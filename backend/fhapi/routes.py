"""FileHub API routes (audited & hardened).

Every P0/P1 item from docs/API_AUDIT.md is addressed here: standard JWT with
refresh rotation, per-user token_version revocation, WebSocket ticket auth,
authenticated exports, share expiry/permission, correct column mapping, snapshot
-before-restore versions, path-whitelisted deletions, FTS escaping, pagination,
camelCase responses, tag arrays, cascade deletes, real undo/redo / force-layout /
dedup / sync / graph / timeline / notifications, and authenticated AI with real
(retrieval-backed) citations.
"""
from __future__ import annotations

import hashlib
import html
import json
import math
import re
import shutil
import struct
import threading
import time
import uuid
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import ai, config, db, security
from .http import ok
from .models import (
    AnchorIn, CanvasIn, ChangePasswordIn, ChatIn, CommentIn, ConnectionIn, ContentIn, CoverIn,
    ExportIn, FilePatchIn, ImportIn, LinksIn, LoginIn, RegisterIn, ShareIn, SummaryIn,
    SyncChangesIn, SyncResolveIn, TagIn, TagsIn, TemplateIn, UpdateMeIn, VersionIn, WorkspaceIn,
)
from .serializers import camelize, serialize_file, serialize_user

router = APIRouter()
bearer = HTTPBearer(auto_error=False)

_FILE_COLS = (
    "id,workspace_id,user_id,name,type,path,mime,size,sha256,summary,content,"
    "x,y,favorite,deleted,deleted_at,version,created_at,updated_at"
)


def now() -> str:
    return db.now()


def uid(prefix: str) -> str:
    return prefix + "_" + uuid.uuid4().hex[:16]


# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #
def current_user(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
    if not creds or not creds.credentials:
        raise HTTPException(401, "Bearer token required")
    payload = security.decode_token(creds.credentials)
    if not payload or payload.get("typ") != "access" or payload.get("aud") != "filehub":
        raise HTTPException(401, "invalid access token")
    user_id = payload.get("sub")
    with db.db() as c:
        row = c.execute("SELECT token_version FROM users WHERE id=?", (user_id,)).fetchone()
    if not row or row["token_version"] != payload.get("ver"):
        raise HTTPException(401, "token revoked")
    return user_id


_RL: dict[str, list[float]] = {}
_RL_LOCK = threading.Lock()


def rate_limit(request: Request, key: str, limit: int = 10, window: int = 60) -> None:
    now_ts = time.time()
    with _RL_LOCK:
        hits = [t for t in _RL.get(key, []) if now_ts - t < window]
        if len(hits) >= limit:
            raise HTTPException(429, "too many requests, try again later")
        hits.append(now_ts)
        _RL[key] = hits


def _auth_response(user_id: str) -> dict:
    with db.db() as c:
        row = c.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        token_version = row["token_version"]
        user = serialize_user(row)
    refresh = security.store_refresh_token(user_id)
    access = security.make_access_token(user_id, token_version)
    return {"user": user, "accessToken": access, "refreshToken": refresh}


def audit(c: Any, user_id: str | None, action: str, resource: str | None = None, detail: str | None = None, ip: str | None = None) -> None:
    c.execute(
        "INSERT INTO audit_log(id,user_id,action,resource,detail,ip,created_at) VALUES(?,?,?,?,?,?,?)",
        (uid("aud"), user_id, action, resource, detail, ip, now()),
    )


@router.post("/auth/register")
def register(req: RegisterIn, request: Request):
    rate_limit(request, f"register:{request.client.host}:{req.email}")
    with db.db() as c:
        if c.execute("SELECT 1 FROM users WHERE email=?", (req.email,)).fetchone():
            raise HTTPException(409, "email already exists")
        user_id = uid("usr")
        c.execute(
            "INSERT INTO users(id,email,password_hash,display_name,token_version,created_at) VALUES(?,?,?,?,0,?)",
            (user_id, req.email, security.hash_password(req.password), req.displayName, now()),
        )
        ws = uid("ws")
        c.execute("INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
                  (ws, user_id, "我的工作区", now(), now()))
        audit(c, user_id, "auth.register", ip=request.client.host)
    return ok(_auth_response(user_id))


@router.post("/auth/login")
def login(req: LoginIn, request: Request):
    rate_limit(request, f"login:{request.client.host}:{req.email}")
    with db.db() as c:
        r = c.execute("SELECT * FROM users WHERE email=?", (req.email,)).fetchone()
    if not r or not security.verify_password(req.password, r["password_hash"]):
        raise HTTPException(401, "invalid credentials")
    with db.db() as c:
        audit(c, r["id"], "auth.login", ip=request.client.host)
    return ok(_auth_response(r["id"]))


@router.post("/auth/refresh")
def refresh(body: dict[str, str] = Body(...)):
    raw = body.get("refreshToken", "")
    user_id = security.rotate_refresh_token(raw)
    if not user_id:
        raise HTTPException(401, "invalid or expired refresh token")
    return ok(_auth_response(user_id))


@router.get("/auth/me")
def me(user_id: str = Depends(current_user)):
    with db.db() as c:
        r = c.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return ok(serialize_user(r))


@router.patch("/auth/me")
def update_me(req: UpdateMeIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        c.execute("UPDATE users SET display_name=? WHERE id=?", (req.displayName, user_id))
        r = c.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return ok(serialize_user(r))


@router.post("/auth/change-password")
def change_password(req: ChangePasswordIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = c.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not security.verify_password(req.currentPassword, r["password_hash"]):
            raise HTTPException(401, "current password incorrect")
        c.execute("UPDATE users SET password_hash=?,token_version=token_version+1 WHERE id=?",
                  (security.hash_password(req.newPassword), user_id))
    security.revoke_all_refresh_tokens(user_id)
    return ok(True)


@router.post("/auth/logout")
def logout(body: dict[str, str] = Body(...), user_id: str = Depends(current_user)):
    with db.db() as c:
        c.execute("UPDATE refresh_tokens SET revoked_at=? WHERE token=? AND user_id=?",
                  (now(), body.get("refreshToken", ""), user_id))
    return ok(True)


@router.delete("/auth/me")
def delete_account(user_id: str = Depends(current_user)):
    with db.db() as c:
        paths = [r["path"] for r in c.execute("SELECT path FROM files WHERE user_id=?", (user_id,)).fetchall()]
        c.execute("DELETE FROM users WHERE id=?", (user_id,))
        c.execute("DELETE FROM search_documents WHERE workspace_id NOT IN (SELECT id FROM workspaces)")
    for p in paths:
        db.delete_file_blob(p)
    return ok(True)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def ensure_workspace(c: Any, workspace_id: str, user_id: str):
    r = c.execute("SELECT * FROM workspaces WHERE id=? AND user_id=?", (workspace_id, user_id)).fetchone()
    if not r:
        raise HTTPException(404, "workspace not found")
    return r


def get_file(c: Any, file_id: str, user_id: str, include_deleted: bool = False):
    r = c.execute(
        "SELECT * FROM files WHERE id=? AND user_id=?" + ("" if include_deleted else " AND deleted=0"),
        (file_id, user_id),
    ).fetchone()
    if not r:
        raise HTTPException(404, "file not found")
    return r


def record_event(c: Any, workspace_id: str, event_type: str, payload: dict) -> None:
    c.execute(
        "INSERT INTO timeline_events(id,workspace_id,event_type,payload,created_at) VALUES(?,?,?,?,?)",
        (uid("ev"), workspace_id, event_type, json.dumps(payload, ensure_ascii=False), now()),
    )


def notify(c: Any, user_id: str, text: str) -> None:
    c.execute("INSERT INTO notifications(id,user_id,text,unread,created_at) VALUES(?,?,?,1,?)",
              (uid("ntf"), user_id, text, now()))


def files_with_tags(c: Any, rows, *, include_content: bool = False) -> list[dict]:
    ids = [r["id"] for r in rows]
    tag_map: dict[str, list[dict]] = {}
    if ids:
        placeholders = ",".join("?" * len(ids))
        for r in c.execute(
            f"SELECT ft.file_id, t.id, t.name, t.color FROM file_tags ft JOIN tags t ON t.id=ft.tag_id WHERE ft.file_id IN ({placeholders})",
            ids,
        ).fetchall():
            tag_map.setdefault(r["file_id"], []).append({"id": r["id"], "name": r["name"], "color": r["color"]})
    return [serialize_file(r, include_content=include_content, tags=tag_map.get(r["id"], [])) for r in rows]


def escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def fts_query(q: str) -> str:
    tokens = []
    for tok in q.split():
        clean = re.sub(r'["*:\^()\-\[\]]', "", tok)
        if clean:
            tokens.append('"' + clean + '"')
    return " AND ".join(tokens)


def _has_cjk(q: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", q))


def make_snippet(text: str, q: str) -> str | None:
    low = (text or "").lower()
    ql = q.lower()
    candidates = [ql] + ql.split()
    best, blen = -1, 0
    for cand in candidates:
        if not cand:
            continue
        i = low.find(cand)
        if i >= 0 and (best == -1 or i < best):
            best, blen = i, len(cand)
    if best < 0:
        return None
    start = max(0, best - 40)
    end = min(len(text), best + 60)
    return text[start:best] + "<mark>" + text[best:best + blen] + "</mark>" + text[best + blen:end]


# --------------------------------------------------------------------------- #
# workspaces
# --------------------------------------------------------------------------- #
@router.get("/workspaces")
def workspaces(user_id: str = Depends(current_user)):
    with db.db() as c:
        rows = c.execute("SELECT * FROM workspaces WHERE user_id=? ORDER BY updated_at DESC", (user_id,)).fetchall()
        items = [camelize(dict(r)) for r in rows]
    return ok({"items": items})


@router.post("/workspaces")
def create_workspace(req: WorkspaceIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        wid = uid("ws")
        c.execute("INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
                  (wid, user_id, req.name, now(), now()))
    return ok({"id": wid, "name": req.name})


@router.get("/workspaces/{workspace_id}")
def workspace(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = ensure_workspace(c, workspace_id, user_id)
        return ok(camelize(dict(r)))


@router.patch("/workspaces/{workspace_id}")
def patch_workspace(workspace_id: str, req: WorkspaceIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        c.execute("UPDATE workspaces SET name=?,updated_at=? WHERE id=?", (req.name, now(), workspace_id))
    return ok({"id": workspace_id, "name": req.name})


@router.delete("/workspaces/{workspace_id}")
def delete_workspace(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        paths = [r["path"] for r in c.execute("SELECT path FROM files WHERE workspace_id=?", (workspace_id,)).fetchall()]
        c.execute("DELETE FROM search_documents WHERE workspace_id=?", (workspace_id,))
        c.execute("DELETE FROM workspaces WHERE id=?", (workspace_id,))
        audit(c, user_id, "workspace.deleted", resource=workspace_id)
    for p in paths:
        db.delete_file_blob(p)
    return ok(True)


# --------------------------------------------------------------------------- #
# files
# --------------------------------------------------------------------------- #
@router.get("/workspaces/{workspace_id}/files")
def list_files(
    workspace_id: str,
    type: str | None = None,
    tag: str | None = None,
    favorite: bool | None = None,
    recent: bool = False,
    query: str | None = None,
    page: int = 1,
    pageSize: int = 100,
    user_id: str = Depends(current_user),
):
    page = max(1, page)
    pageSize = max(1, min(200, pageSize))
    where = ["f.workspace_id=?", "f.deleted=0"]
    args: list[Any] = [workspace_id]
    if type:
        where.append("f.type=?")
        args.append(type)
    if favorite is not None:
        where.append("f.favorite=?")
        args.append(int(favorite))
    if tag:
        where.append("EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id=ft.tag_id WHERE ft.file_id=f.id AND t.name=?)")
        args.append(tag)
    if recent:
        where.append("f.updated_at >= ?")
        args.append((datetime.now(timezone.utc) - timedelta(days=7)).isoformat())
    if query:
        like = escape_like(query)
        where.append("(f.name LIKE ? ESCAPE '\\' OR f.content LIKE ? ESCAPE '\\' OR f.summary LIKE ? ESCAPE '\\')")
        args += [f"%{like}%"] * 3
    where_sql = " AND ".join(where)
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        total = c.execute(f"SELECT count(*) n FROM files f WHERE {where_sql}", args).fetchone()["n"]
        rows = c.execute(
            f"SELECT * FROM files f WHERE {where_sql} ORDER BY f.updated_at DESC LIMIT ? OFFSET ?",
            args + [pageSize, (page - 1) * pageSize],
        ).fetchall()
        items = files_with_tags(c, rows)
    return ok({"items": items, "total": total, "page": page, "pageSize": pageSize})


@router.post("/workspaces/{workspace_id}/files")
async def upload_file(workspace_id: str, upload: UploadFile = File(...), user_id: str = Depends(current_user)):
    safe = Path(upload.filename or "unnamed").name
    ext = Path(safe).suffix.lower()
    if ext in config.BLOCKED_EXT:
        raise HTTPException(415, "file type not allowed")
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
    fid = uid("file")
    target = config.FILES_DIR / fid
    target.mkdir(parents=True, exist_ok=True)
    dest = target / safe
    size = 0
    sha = hashlib.sha256()
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = await upload.read(256 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > config.MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"file exceeds {config.MAX_UPLOAD_BYTES} bytes")
                sha.update(chunk)
                out.write(chunk)
    except HTTPException:
        shutil.rmtree(target, ignore_errors=True)
        raise
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise
    digest = sha.hexdigest()
    mime = upload.content_type or "application/octet-stream"
    content = ""
    if ext in config.TEXT_EXT or (mime or "").startswith("text/"):
        try:
            content = dest.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            content = ""
    typ = ext.lstrip(".").upper() if ext else "BIN"
    stamp = now()
    with db.db() as c:
        c.execute(
            f"INSERT INTO files({_FILE_COLS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,80,80,0,0,NULL,1,?,?)",
            (fid, workspace_id, user_id, safe, typ, str(dest), mime, size, digest, "", content, stamp, stamp),
        )
        c.execute("INSERT INTO file_versions(id,file_id,content,created_at) VALUES(?,?,?,?)", (uid("ver"), fid, content, stamp))
        if content:
            c.execute("INSERT INTO search_documents(file_id,workspace_id,name,content) VALUES(?,?,?,?)", (fid, workspace_id, safe, content))
        record_event(c, workspace_id, "file.created", {"fileId": fid, "name": safe})
    return ok({"id": fid, "name": safe, "type": typ, "size": size, "status": "indexed" if content else "stored"})


@router.get("/files/{file_id}")
def file_detail(file_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id)
        return ok(serialize_file(r, include_content=True, tags=_tags_of(c, file_id)))


def _tags_of(c: Any, file_id: str) -> list[dict]:
    rows = c.execute(
        "SELECT t.id, t.name, t.color FROM file_tags ft JOIN tags t ON t.id=ft.tag_id WHERE ft.file_id=? ORDER BY t.name",
        (file_id,),
    ).fetchall()
    return [{"id": r["id"], "name": r["name"], "color": r["color"]} for r in rows]


@router.patch("/files/{file_id}")
def patch_file(file_id: str, req: FilePatchIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        get_file(c, file_id, user_id, True)
        values = req.model_dump(exclude_unset=True)
        if not values:
            return ok(serialize_file(get_file(c, file_id, user_id, True)))
        sets = ", ".join(f"{k}=?" for k in values)
        args = list(values.values()) + [now(), file_id]
        c.execute(f"UPDATE files SET {sets},updated_at=? WHERE id=?", args)
        r = get_file(c, file_id, user_id, True)
        return ok(serialize_file(r, tags=_tags_of(c, file_id)))


@router.delete("/files/{file_id}")
def trash_file(file_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id)
        c.execute("UPDATE files SET deleted=1,deleted_at=?,updated_at=? WHERE id=?", (now(), now(), file_id))
        record_event(c, r["workspace_id"], "file.trashed", {"fileId": file_id, "name": r["name"]})
    return ok(True)


@router.post("/files/{file_id}/restore")
def restore_file(file_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id, True)
        c.execute("UPDATE files SET deleted=0,deleted_at=NULL,updated_at=? WHERE id=?", (now(), file_id))
        record_event(c, r["workspace_id"], "file.restored", {"fileId": file_id, "name": r["name"]})
    return ok(True)


@router.delete("/files/{file_id}/purge")
def purge_file(file_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id, True)
        path = r["path"]
        c.execute("DELETE FROM files WHERE id=?", (file_id,))
        c.execute("DELETE FROM search_documents WHERE file_id=?", (file_id,))
        c.execute("DELETE FROM connections WHERE a_id=? OR b_id=?", (file_id, file_id))
        record_event(c, r["workspace_id"], "file.purged", {"fileId": file_id, "name": r["name"]})
    db.delete_file_blob(path)
    return ok(True)


@router.get("/files/{file_id}/content")
def file_content(file_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id)
        return ok({"id": file_id, "content": r["content"]})


@router.put("/files/{file_id}/content")
def save_content(file_id: str, req: ContentIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id)
        stamp = now()
        # snapshot the previous content as a new version BEFORE overwriting
        c.execute("INSERT INTO file_versions(id,file_id,content,created_at) VALUES(?,?,?,?)",
                  (uid("ver"), file_id, r["content"], stamp))
        c.execute("UPDATE files SET content=?,summary=?,version=version+1,updated_at=? WHERE id=?",
                  (req.content, "", stamp, file_id))
        if req.content:
            c.execute("UPDATE search_documents SET content=? WHERE file_id=?", (req.content, file_id))
        record_event(c, r["workspace_id"], "file.updated", {"fileId": file_id, "name": r["name"]})
        newver = c.execute("SELECT version FROM files WHERE id=?", (file_id,)).fetchone()["version"]
    return ok({"updatedAt": stamp, "version": newver})


@router.get("/files/{file_id}/download")
def download_file(file_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id)
        path, name, mime = r["path"], r["name"], r["mime"] or "application/octet-stream"
    p = Path(path) if path else None
    if not p or not p.exists():
        raise HTTPException(404, "no stored original file")
    return FileResponse(p, media_type=mime, filename=name)


@router.get("/files/{file_id}/preview")
def preview_file(file_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id)
        path, name, mime, content = r["path"], r["name"], r["mime"] or "application/octet-stream", r["content"]
    p = Path(path) if path else None
    if not p or not p.exists():
        if content:
            return Response(content, media_type="text/plain; charset=utf-8")
        raise HTTPException(404, "no stored original file")
    return FileResponse(p, media_type=mime, content_disposition_type="inline")


@router.get("/files/{file_id}/versions")
def versions(file_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        get_file(c, file_id, user_id)
        rows = c.execute(
            "SELECT id,created_at,length(content) size FROM file_versions WHERE file_id=? ORDER BY created_at DESC",
            (file_id,),
        ).fetchall()
    return ok({"items": [camelize(dict(r)) for r in rows]})


@router.get("/files/{file_id}/versions/{version_id}")
def version_detail(file_id: str, version_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        get_file(c, file_id, user_id)
        r = c.execute("SELECT * FROM file_versions WHERE id=? AND file_id=?", (version_id, file_id)).fetchone()
    if not r:
        raise HTTPException(404, "version not found")
    return ok(camelize(dict(r)))


@router.post("/files/{file_id}/versions/{version_id}/restore")
def restore_version(file_id: str, version_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id)
        ver = c.execute("SELECT content FROM file_versions WHERE id=? AND file_id=?", (version_id, file_id)).fetchone()
        if not ver:
            raise HTTPException(404, "version not found")
        stamp = now()
        c.execute("INSERT INTO file_versions(id,file_id,content,created_at) VALUES(?,?,?,?)",
                  (uid("ver"), file_id, r["content"], stamp))
        c.execute("UPDATE files SET content=?,version=version+1,updated_at=? WHERE id=?", (ver["content"], stamp, file_id))
        if ver["content"]:
            c.execute("UPDATE search_documents SET content=? WHERE file_id=?", (ver["content"], file_id))
        record_event(c, r["workspace_id"], "file.version_restored", {"fileId": file_id, "versionId": version_id})
        newver = c.execute("SELECT version FROM files WHERE id=?", (file_id,)).fetchone()["version"]
    return ok({"restored": version_id, "version": newver})


# --------------------------------------------------------------------------- #
# trash
# --------------------------------------------------------------------------- #
@router.get("/workspaces/{workspace_id}/trash")
def trash(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        rows = c.execute("SELECT * FROM files WHERE workspace_id=? AND deleted=1 ORDER BY deleted_at DESC", (workspace_id,)).fetchall()
        items = files_with_tags(c, rows)
    return ok({"items": items})


@router.post("/files/{file_id}/versions")
def create_version(file_id: str, req: VersionIn, user_id: str = Depends(current_user)):
    """Create an explicit named point-in-time version and update the file."""
    with db.db() as c:
        r = get_file(c, file_id, user_id)
        stamp = now()
        vid = uid("ver")
        c.execute("INSERT INTO file_versions(id,file_id,content,created_at) VALUES(?,?,?,?)",
                  (vid, file_id, req.content, stamp))
        c.execute("UPDATE files SET content=?,version=version+1,updated_at=? WHERE id=?",
                  (req.content, stamp, file_id))
        c.execute("DELETE FROM search_documents WHERE file_id=?", (file_id,))
        c.execute("INSERT INTO search_documents(file_id,workspace_id,name,content) VALUES(?,?,?,?)",
                  (file_id, r["workspace_id"], r["name"], req.content))
        record_event(c, r["workspace_id"], "file.version_created", {"fileId": file_id, "versionId": vid})
    return ok({"id": vid, "fileId": file_id, "version": int(r["version"]) + 1, "createdAt": stamp})


@router.post("/workspaces/{workspace_id}/trash/empty")
def empty_trash(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        rows = c.execute("SELECT id,path FROM files WHERE workspace_id=? AND deleted=1", (workspace_id,)).fetchall()
        c.execute("DELETE FROM files WHERE workspace_id=? AND deleted=1", (workspace_id,))
        c.execute("DELETE FROM connections WHERE a_id IN (SELECT id FROM files) AND 1=0")  # no-op safeguard
        for r in rows:
            c.execute("DELETE FROM search_documents WHERE file_id=?", (r["id"],))
            c.execute("DELETE FROM connections WHERE a_id=? OR b_id=?", (r["id"], r["id"]))
        record_event(c, workspace_id, "trash.emptied", {"removed": len(rows)})
        paths = [r["path"] for r in rows]
    for p in paths:
        db.delete_file_blob(p)
    return ok({"removed": len(rows)})


# --------------------------------------------------------------------------- #
# canvas (with pointer-based undo/redo and optimistic revision)
# --------------------------------------------------------------------------- #
def _get_pointer(c: Any, workspace_id: str) -> int | None:
    row = c.execute("SELECT current_revision FROM canvas_pointer WHERE workspace_id=?", (workspace_id,)).fetchone()
    return row["current_revision"] if row else None


def _sync_connections(c: Any, workspace_id: str, connections: list) -> None:
    c.execute("DELETE FROM connections WHERE workspace_id=?", (workspace_id,))
    for pair in connections or []:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            continue
        a, b = pair[0], pair[1]
        if not a or not b or a == b:
            continue
        c.execute("INSERT OR IGNORE INTO connections(id,workspace_id,a_id,b_id,created_at) VALUES(?,?,?,?,?)",
                  (uid("conn"), workspace_id, a, b, now()))


def _canvas_payload(c: Any, workspace_id: str) -> dict:
    cur = _get_pointer(c, workspace_id)
    if cur is None:
        # no pointer yet (legacy data): use the latest snapshot if present
        r = c.execute("SELECT * FROM canvas_snapshots WHERE workspace_id=? ORDER BY revision DESC LIMIT 1", (workspace_id,)).fetchone()
    elif cur == 0:
        r = None  # explicitly at the initial (empty) state
    else:
        r = c.execute("SELECT * FROM canvas_snapshots WHERE workspace_id=? AND revision=?", (workspace_id, cur)).fetchone()
    if not r:
        return {"revision": 0, "nodes": [], "connections": [], "viewport": {}}
    return {"revision": r["revision"], "nodes": json.loads(r["nodes"]), "connections": json.loads(r["connections"]), "viewport": json.loads(r["viewport"])}


@router.put("/workspaces/{workspace_id}/canvas")
def put_canvas(workspace_id: str, req: CanvasIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        current = _get_pointer(c, workspace_id) or 0
        if req.revision != current:
            raise HTTPException(409, f"revision conflict: expected {current}, got {req.revision}")
        revision = current + 1
        c.execute(
            "INSERT INTO canvas_snapshots(id,workspace_id,revision,nodes,connections,viewport,created_at) VALUES(?,?,?,?,?,?,?)",
            (uid("snap"), workspace_id, revision, json.dumps(req.nodes), json.dumps(req.connections), json.dumps(req.viewport), now()),
        )
        c.execute("DELETE FROM canvas_snapshots WHERE workspace_id=? AND revision>?", (workspace_id, revision))
        c.execute(
            "INSERT INTO canvas_pointer(workspace_id,current_revision) VALUES(?,?) "
            "ON CONFLICT(workspace_id) DO UPDATE SET current_revision=excluded.current_revision",
            (workspace_id, revision),
        )
        _sync_connections(c, workspace_id, req.connections)
        record_event(c, workspace_id, "canvas.saved", {"revision": revision})
    return ok({"revision": revision})


@router.get("/workspaces/{workspace_id}/canvas")
def get_canvas(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        return ok(_canvas_payload(c, workspace_id))


@router.post("/workspaces/{workspace_id}/canvas/undo")
def canvas_undo(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        cur = _get_pointer(c, workspace_id) or 0
        if cur <= 0:
            raise HTTPException(409, "nothing to undo")
        c.execute("UPDATE canvas_pointer SET current_revision=? WHERE workspace_id=?", (cur - 1, workspace_id))
    return get_canvas(workspace_id, user_id)


@router.post("/workspaces/{workspace_id}/canvas/redo")
def canvas_redo(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        cur = _get_pointer(c, workspace_id) or 0
        maxrev = c.execute("SELECT max(revision) r FROM canvas_snapshots WHERE workspace_id=?", (workspace_id,)).fetchone()["r"]
        if maxrev is None or cur >= maxrev:
            raise HTTPException(409, "nothing to redo")
        c.execute("UPDATE canvas_pointer SET current_revision=? WHERE workspace_id=?", (cur + 1, workspace_id))
    return get_canvas(workspace_id, user_id)


@router.post("/workspaces/{workspace_id}/layouts/force")
def force_layout(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        files = c.execute("SELECT id FROM files WHERE workspace_id=? AND deleted=0", (workspace_id,)).fetchall()
        conns = c.execute("SELECT a_id,b_id FROM connections WHERE workspace_id=?", (workspace_id,)).fetchall()
        adj: dict[str, list[str]] = {}
        for r in conns:
            adj.setdefault(r["a_id"], []).append(r["b_id"])
            adj.setdefault(r["b_id"], []).append(r["a_id"])
        visited: set[str] = set()
        comps: list[list[str]] = []
        for f in files:
            fid = f["id"]
            if fid in visited:
                continue
            stack = [fid]
            comp: list[str] = []
            while stack:
                x = stack.pop()
                if x in visited:
                    continue
                visited.add(x)
                comp.append(x)
                stack.extend(adj.get(x, []))
            comps.append(comp)
        positions: dict[str, tuple[float, float]] = {}
        y0 = 100.0
        for comp in comps:
            cx, cy = 420.0, y0 + 120.0
            n = len(comp)
            if n == 1:
                positions[comp[0]] = (cx, cy)
            else:
                for i, fid in enumerate(comp):
                    ang = 2 * math.pi * i / n
                    positions[fid] = (cx + math.cos(ang) * 140, cy + math.sin(ang) * 100)
            y0 += 240.0
        for fid, (x, y) in positions.items():
            x = max(0.0, min(840.0 - 150.0, x))
            y = max(0.0, min(844.0 - 96.0, y))
            c.execute("UPDATE files SET x=?,y=?,updated_at=? WHERE id=?", (x, y, now(), fid))
        record_event(c, workspace_id, "canvas.force_layout", {"moved": len(positions)})
        result = [{"id": k, "x": v[0], "y": v[1]} for k, v in positions.items()]
    return ok({"moved": len(result), "algorithm": "connected-components-circle", "positions": result})


# --------------------------------------------------------------------------- #
# search / favorites / graph / timeline / health / dedup
# --------------------------------------------------------------------------- #
@router.get("/workspaces/{workspace_id}/search")
def search(workspace_id: str, q: str = "", page: int = 1, pageSize: int = 100, user_id: str = Depends(current_user)):
    page = max(1, page)
    pageSize = max(1, min(200, pageSize))
    qq = q.strip()

    def _like_search(c: Any):
        like = escape_like(qq)
        where = "f.workspace_id=? AND f.deleted=0 AND (f.name LIKE ? ESCAPE '\\' OR f.content LIKE ? ESCAPE '\\' OR f.summary LIKE ? ESCAPE '\\')"
        args = [workspace_id, f"%{like}%", f"%{like}%", f"%{like}%"]
        total = c.execute(f"SELECT count(*) n FROM files f WHERE {where}", args).fetchone()["n"]
        rows = c.execute(f"SELECT * FROM files f WHERE {where} ORDER BY f.updated_at DESC LIMIT ? OFFSET ?", args + [pageSize, (page - 1) * pageSize]).fetchall()
        return total, rows

    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        if qq:
            total, rows = 0, []
            if not _has_cjk(qq):
                fq = fts_query(qq)
                try:
                    where = "s.workspace_id=? AND search_documents MATCH ? AND f.deleted=0"
                    args: list[Any] = [workspace_id, fq]
                    total = c.execute(f"SELECT count(*) n FROM files f JOIN search_documents s ON s.file_id=f.id WHERE {where}", args).fetchone()["n"]
                    if total:
                        rows = c.execute(f"SELECT f.* FROM files f JOIN search_documents s ON s.file_id=f.id WHERE {where} ORDER BY f.updated_at DESC LIMIT ? OFFSET ?", args + [pageSize, (page - 1) * pageSize]).fetchall()
                except Exception:
                    total = 0
            if total == 0:
                total, rows = _like_search(c)
        else:
            total = c.execute("SELECT count(*) n FROM files WHERE workspace_id=? AND deleted=0", (workspace_id,)).fetchone()["n"]
            rows = c.execute("SELECT * FROM files WHERE workspace_id=? AND deleted=0 ORDER BY updated_at DESC LIMIT ? OFFSET ?", (workspace_id, pageSize, (page - 1) * pageSize)).fetchall()
        items = files_with_tags(c, rows)
        for it, r in zip(items, rows):
            snip = make_snippet(r["content"] or r["summary"] or r["name"], qq) if qq else None
            if snip:
                it["snippet"] = snip
    return ok({"items": items, "total": total, "page": page, "pageSize": pageSize})


@router.get("/workspaces/{workspace_id}/favorites")
def favorites(workspace_id: str, user_id: str = Depends(current_user)):
    return list_files(workspace_id, favorite=True, user_id=user_id)


@router.get("/workspaces/{workspace_id}/graph")
def graph(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        files = c.execute("SELECT * FROM files WHERE workspace_id=? AND deleted=0", (workspace_id,)).fetchall()
        nodes = files_with_tags(c, files)
        conns = c.execute("SELECT a_id,b_id FROM connections WHERE workspace_id=?", (workspace_id,)).fetchall()
        edges = [{"source": r["a_id"], "target": r["b_id"]} for r in conns]
    return ok({"nodes": nodes, "edges": edges})


@router.get("/workspaces/{workspace_id}/timeline")
def timeline(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        rows = c.execute("SELECT * FROM timeline_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200", (workspace_id,)).fetchall()
        items = [camelize({"id": r["id"], "event_type": r["event_type"], "payload": json.loads(r["payload"]), "created_at": r["created_at"]}) for r in rows]
    return ok({"items": items})


@router.get("/workspaces/{workspace_id}/health")
def workspace_health(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        rows = c.execute("SELECT id,updated_at,content FROM files WHERE workspace_id=? AND deleted=0", (workspace_id,)).fetchall()
        conn_count = {r["id"]: 0 for r in rows}
        for r in c.execute("SELECT a_id FROM connections WHERE workspace_id=?", (workspace_id,)).fetchall():
            conn_count[r["a_id"]] = conn_count.get(r["a_id"], 0) + 1
        items = []
        for r in rows:
            has_tags = c.execute("SELECT 1 FROM file_tags WHERE file_id=? LIMIT 1", (r["id"],)).fetchone() is not None
            sc = ai.health_score(r["content"], r["updated_at"], conn_count.get(r["id"], 0), has_tags)
            items.append({"id": r["id"], **sc})
    return ok({"items": items})


@router.post("/workspaces/{workspace_id}/dedup/scan")
def dedup_scan(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        rows = c.execute("SELECT id,sha256,name,content FROM files WHERE workspace_id=? AND deleted=0", (workspace_id,)).fetchall()
        pairs = []
        for i in range(len(rows)):
            for j in range(i + 1, len(rows)):
                a, b = rows[i], rows[j]
                sim = 100 if (a["sha256"] and a["sha256"] == b["sha256"]) else ai.dedup_score(a["content"], b["content"])
                if sim >= 80:
                    pid = uid("dup")
                    c.execute("INSERT INTO dedup_pairs(id,workspace_id,a_id,b_id,similarity,status) VALUES(?,?,?,?,?,'open')",
                              (pid, workspace_id, a["id"], b["id"], sim))
                    pairs.append({"id": pid, "a": a["id"], "b": b["id"], "similarity": sim})
    return ok({"pairs": pairs})


def _own_pair(c: Any, pair_id: str, user_id: str):
    return c.execute(
        "SELECT * FROM dedup_pairs WHERE id=? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id=?)",
        (pair_id, user_id),
    ).fetchone()


@router.post("/dedup/{pair_id}/ignore")
def ignore_dedup(pair_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        if not _own_pair(c, pair_id, user_id):
            raise HTTPException(404, "pair not found")
        c.execute("UPDATE dedup_pairs SET status='ignored' WHERE id=?", (pair_id,))
    return ok({"id": pair_id, "status": "ignored"})


@router.post("/dedup/{pair_id}/merge")
def merge_dedup(pair_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        pair = _own_pair(c, pair_id, user_id)
        if not pair:
            raise HTTPException(404, "pair not found")
        if pair["status"] != "open":
            raise HTTPException(409, "pair already resolved")
        a_id, b_id = pair["a_id"], pair["b_id"]
        b = c.execute("SELECT * FROM files WHERE id=?", (b_id,)).fetchone()
        if not b:
            raise HTTPException(404, "file not found")
        c.execute("INSERT OR IGNORE INTO file_tags(file_id,tag_id) SELECT ?,tag_id FROM file_tags WHERE file_id=?", (a_id, b_id))
        c.execute("DELETE FROM file_tags WHERE file_id=?", (b_id,))
        c.execute("DELETE FROM connections WHERE a_id=? OR b_id=?", (b_id, b_id))
        b_path = b["path"]
        c.execute("DELETE FROM files WHERE id=?", (b_id,))
        c.execute("DELETE FROM search_documents WHERE file_id=?", (b_id,))
        c.execute("UPDATE dedup_pairs SET status='merged' WHERE id=?", (pair_id,))
        record_event(c, pair["workspace_id"], "dedup.merged", {"kept": a_id, "removed": b_id})
    db.delete_file_blob(b_path)
    return ok({"id": pair_id, "status": "merged", "keptId": a_id, "removedId": b_id})


# --------------------------------------------------------------------------- #
# tags
# --------------------------------------------------------------------------- #
@router.get("/tags")
def get_tags(user_id: str = Depends(current_user)):
    with db.db() as c:
        rows = c.execute("SELECT * FROM tags WHERE user_id=? ORDER BY name", (user_id,)).fetchall()
    return ok({"items": [camelize(dict(r)) for r in rows]})


@router.post("/tags")
def create_tag(req: TagIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        existing = c.execute("SELECT * FROM tags WHERE user_id=? AND name=?", (user_id, req.name)).fetchone()
        if existing:
            return ok({"id": existing["id"], "name": existing["name"], "color": existing["color"]})
        tid = uid("tag")
        c.execute("INSERT INTO tags(id,user_id,name,color) VALUES(?,?,?,?)", (tid, user_id, req.name, req.color))
    return ok({"id": tid, "name": req.name, "color": req.color})


@router.post("/files/{file_id}/tags")
def attach_tag(file_id: str, req: TagIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        get_file(c, file_id, user_id)
        r = c.execute("SELECT id FROM tags WHERE user_id=? AND name=?", (user_id, req.name)).fetchone()
        tid = r["id"] if r else uid("tag")
        if not r:
            c.execute("INSERT INTO tags(id,user_id,name,color) VALUES(?,?,?,?)", (tid, user_id, req.name, req.color))
        c.execute("INSERT OR IGNORE INTO file_tags(file_id,tag_id) VALUES(?,?)", (file_id, tid))
    return ok({"tagId": tid, "tag": req.name})


@router.delete("/files/{file_id}/tags/{tag_id}")
def detach_tag(file_id: str, tag_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        get_file(c, file_id, user_id)
        c.execute("DELETE FROM file_tags WHERE file_id=? AND tag_id=?", (file_id, tag_id))
    return ok(True)


@router.patch("/tags/{tag_id}")
def patch_tag(tag_id: str, req: TagIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        cur = c.execute("UPDATE tags SET name=?,color=? WHERE id=? AND user_id=?", (req.name, req.color, tag_id, user_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "tag not found")
    return ok({"id": tag_id, "name": req.name, "color": req.color})


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        cur = c.execute("DELETE FROM tags WHERE id=? AND user_id=?", (tag_id, user_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "tag not found")
    return ok(True)


# --------------------------------------------------------------------------- #
# connections (edges) — first-class CRUD (audit section 5)
# --------------------------------------------------------------------------- #
@router.get("/workspaces/{workspace_id}/connections")
def get_connections(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        rows = c.execute("SELECT id,a_id,b_id,created_at FROM connections WHERE workspace_id=? ORDER BY created_at", (workspace_id,)).fetchall()
    return ok({"items": [camelize(dict(r)) for r in rows]})


@router.post("/workspaces/{workspace_id}/connections")
def create_connection(workspace_id: str, req: ConnectionIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        a = c.execute("SELECT id FROM files WHERE id=? AND workspace_id=?", (req.aId, workspace_id)).fetchone()
        b = c.execute("SELECT id FROM files WHERE id=? AND workspace_id=?", (req.bId, workspace_id)).fetchone()
        if not a or not b:
            raise HTTPException(404, "file not found")
        if req.aId == req.bId:
            raise HTTPException(400, "cannot connect a file to itself")
        cid = uid("conn")
        c.execute("INSERT OR IGNORE INTO connections(id,workspace_id,a_id,b_id,created_at) VALUES(?,?,?,?,?)",
                  (cid, workspace_id, req.aId, req.bId, now()))
        record_event(c, workspace_id, "connection.created", {"aId": req.aId, "bId": req.bId})
    return ok({"id": cid, "aId": req.aId, "bId": req.bId})


@router.delete("/workspaces/{workspace_id}/connections/{connection_id}")
def delete_connection(workspace_id: str, connection_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        cur = c.execute("DELETE FROM connections WHERE id=? AND workspace_id=?", (connection_id, workspace_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "connection not found")
    return ok(True)


@router.get("/files/{file_id}/backlinks")
def backlinks(file_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        target = get_file(c, file_id, user_id)
        rows = c.execute(
            "SELECT f.* FROM connections x JOIN files f ON f.id=x.a_id "
            "WHERE x.workspace_id=? AND x.b_id=? AND f.deleted=0 "
            "UNION SELECT f.* FROM connections x JOIN files f ON f.id=x.b_id "
            "WHERE x.workspace_id=? AND x.a_id=? AND f.deleted=0",
            (target["workspace_id"], file_id, target["workspace_id"], file_id),
        ).fetchall()
        items = files_with_tags(c, rows)
    return ok({"items": items, "total": len(items)})


@router.post("/files/{file_id}/links")
def create_file_link(file_id: str, body: dict[str, Any] = Body(...), user_id: str = Depends(current_user)):
    target_id = body.get("targetId")
    if not target_id or target_id == file_id:
        raise HTTPException(422, "targetId must reference another file")
    with db.db() as c:
        source = get_file(c, file_id, user_id)
        target = get_file(c, target_id, user_id)
        if source["workspace_id"] != target["workspace_id"]:
            raise HTTPException(422, "files must be in the same workspace")
        cid = uid("conn")
        c.execute("INSERT OR IGNORE INTO connections(id,workspace_id,a_id,b_id,created_at) VALUES(?,?,?,?,?)",
                  (cid, source["workspace_id"], file_id, target_id, now()))
        row = c.execute("SELECT id FROM connections WHERE workspace_id=? AND a_id=? AND b_id=?",
                        (source["workspace_id"], file_id, target_id)).fetchone()
        record_event(c, source["workspace_id"], "link.created", {"source": file_id, "target": target_id})
    return ok({"id": row["id"], "source": file_id, "target": target_id})


@router.delete("/files/{file_id}/links/{target_id}")
def delete_file_link(file_id: str, target_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        source = get_file(c, file_id, user_id)
        cur = c.execute(
            "DELETE FROM connections WHERE workspace_id=? AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?))",
            (source["workspace_id"], file_id, target_id, target_id, file_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "link not found")
    return ok(True)


@router.get("/files/{file_id}/link-suggestions")
def file_link_suggestions(file_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        source = get_file(c, file_id, user_id)
        candidates = c.execute(
            "SELECT * FROM files WHERE workspace_id=? AND id<>? AND deleted=0 ORDER BY updated_at DESC LIMIT 100",
            (source["workspace_id"], file_id),
        ).fetchall()
        existing = {r[0] for r in c.execute(
            "SELECT CASE WHEN a_id=? THEN b_id ELSE a_id END FROM connections WHERE workspace_id=? AND (a_id=? OR b_id=?)",
            (file_id, source["workspace_id"], file_id, file_id),
        ).fetchall()}
        source_terms = ai._terms(source["name"] + " " + source["summary"] + " " + source["content"][:2000])
        items = []
        for row in candidates:
            if row["id"] in existing:
                continue
            terms = ai._terms(row["name"] + " " + row["summary"] + " " + row["content"][:2000])
            union = len(source_terms | terms) or 1
            sim = round(100 * len(source_terms & terms) / union)
            items.append({"id": row["id"], "name": row["name"], "type": row["type"], "sim": sim})
        items.sort(key=lambda x: x["sim"], reverse=True)
    return ok({"items": items[:8], "mode": "local-semantic"})


# --------------------------------------------------------------------------- #
# anchors
# --------------------------------------------------------------------------- #
@router.get("/workspaces/{workspace_id}/anchors")
def get_anchors(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        rows = c.execute("SELECT * FROM anchors WHERE workspace_id=? ORDER BY created_at", (workspace_id,)).fetchall()
    return ok({"items": [camelize({**dict(r), "layout": json.loads(r["layout"])}) for r in rows]})


@router.post("/workspaces/{workspace_id}/anchors")
def create_anchor(workspace_id: str, req: AnchorIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        aid = uid("anchor")
        c.execute("INSERT INTO anchors(id,workspace_id,name,layout,created_at) VALUES(?,?,?,?,?)",
                  (aid, workspace_id, req.name, json.dumps(req.layout), now()))
    return ok({"id": aid, "name": req.name, "layout": req.layout})


@router.put("/workspaces/{workspace_id}/anchors/{anchor_id}")
def patch_anchor(workspace_id: str, anchor_id: str, req: AnchorIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        cur = c.execute("UPDATE anchors SET name=?,layout=? WHERE id=? AND workspace_id=?", (req.name, json.dumps(req.layout), anchor_id, workspace_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "anchor not found")
    return ok({"id": anchor_id, "name": req.name, "layout": req.layout})


@router.delete("/workspaces/{workspace_id}/anchors/{anchor_id}")
def delete_anchor(workspace_id: str, anchor_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        cur = c.execute("DELETE FROM anchors WHERE id=? AND workspace_id=?", (anchor_id, workspace_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "anchor not found")
    return ok(True)


# --------------------------------------------------------------------------- #
# templates
# --------------------------------------------------------------------------- #
@router.get("/templates")
def templates(user_id: str = Depends(current_user)):
    with db.db() as c:
        rows = c.execute("SELECT * FROM templates WHERE user_id=? ORDER BY updated_at DESC", (user_id,)).fetchall()
    return ok({"items": [camelize({**dict(r), "payload": json.loads(r["payload"])}) for r in rows]})


@router.post("/templates")
def create_template(req: TemplateIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        tid = uid("tpl")
        c.execute("INSERT INTO templates(id,user_id,name,description,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                  (tid, user_id, req.name, req.description, json.dumps(req.payload), now(), now()))
    return ok({"id": tid, "name": req.name, "payload": req.payload})


@router.patch("/templates/{template_id}")
def patch_template(template_id: str, req: TemplateIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        cur = c.execute("UPDATE templates SET name=?,description=?,payload=?,updated_at=? WHERE id=? AND user_id=?",
                        (req.name, req.description, json.dumps(req.payload), now(), template_id, user_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "template not found")
    return ok({"id": template_id, "name": req.name, "payload": req.payload})


@router.delete("/templates/{template_id}")
def delete_template(template_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        cur = c.execute("DELETE FROM templates WHERE id=? AND user_id=?", (template_id, user_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "template not found")
    return ok(True)


@router.post("/workspaces/{workspace_id}/templates/{template_id}/apply")
def apply_template(workspace_id: str, template_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        tpl = c.execute("SELECT payload FROM templates WHERE id=? AND user_id=?", (template_id, user_id)).fetchone()
        if not tpl:
            raise HTTPException(404, "template not found")
        payload = json.loads(tpl["payload"])
        nodes = payload.get("nodes", []) if isinstance(payload, dict) else []
        created = []
        for n in nodes:
            fid = uid("file")
            name = n.get("name", "新文件")
            typ = n.get("type", "MD")
            content = n.get("content", "")
            x = n.get("x", 80)
            y = n.get("y", 80)
            stamp = now()
            c.execute(f"INSERT INTO files({_FILE_COLS}) VALUES(?,?,?,?,?,NULL,'',0,NULL,'',?,?,?,0,0,NULL,1,?,?)",
                      (fid, workspace_id, user_id, name, typ, content, x, y, stamp, stamp))
            if content:
                c.execute("INSERT INTO search_documents(file_id,workspace_id,name,content) VALUES(?,?,?,?)", (fid, workspace_id, name, content))
            created.append({"id": fid, "name": name, "type": typ})
        record_event(c, workspace_id, "template.applied", {"templateId": template_id, "created": len(created)})
    return ok({"created": created})


# --------------------------------------------------------------------------- #
# export / import
# --------------------------------------------------------------------------- #
@router.post("/workspaces/{workspace_id}/export")
def export_workspace(workspace_id: str, req: ExportIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        ws = c.execute("SELECT * FROM workspaces WHERE id=?", (workspace_id,)).fetchone()
        files = c.execute("SELECT * FROM files WHERE workspace_id=? AND deleted=0", (workspace_id,)).fetchall()
        conns = c.execute("SELECT a_id,b_id FROM connections WHERE workspace_id=?", (workspace_id,)).fetchall()
        data = {
            "workspace": camelize(dict(ws)),
            "files": files_with_tags(c, files, include_content=True),
            "connections": [{"aId": r["a_id"], "bId": r["b_id"]} for r in conns],
            "exportedAt": now(),
        }
    fmt = req.format.lower()
    if fmt not in {"json", "png", "pdf"}:
        raise HTTPException(422, "format must be json, png, or pdf")
    name = f"{workspace_id}-{int(time.time())}.{fmt}"
    path = config.EXPORTS_DIR / name
    if fmt == "json":
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    elif fmt == "png":
        width, height = 960, 540
        rows = []
        for y in range(height):
            scan = bytearray([0])
            for x in range(width):
                band = (x // 120 + y // 90) % 2
                scan.extend((244 - band * 8, 248 - band * 6, 252, 255))
            rows.append(bytes(scan))
        def chunk(kind: bytes, payload: bytes) -> bytes:
            return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        png += chunk(b"tEXt", f"Title\x00FileHub workspace; files={len(data['files'])}; connections={len(data['connections'])}".encode())
        png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
        path.write_bytes(png)
    else:
        lines = ["FileHub Workspace Export", f"Workspace: {workspace_id}", f"Files: {len(data['files'])}", f"Connections: {len(data['connections'])}", f"Exported: {data['exportedAt']}"]
        stream = "BT /F1 18 Tf 72 760 Td " + " ".join(f"({re.sub(r'[^ -~]', '?', line)}) Tj 0 -30 Td" for line in lines) + " ET"
        objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream"]
        pdf = "%PDF-1.4\n"; offsets = []
        for i, obj in enumerate(objects, 1): offsets.append(len(pdf.encode())); pdf += f"{i} 0 obj\n{obj}\nendobj\n"
        xref = len(pdf.encode()); pdf += f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offsets)
        pdf += f"trailer << /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
        path.write_bytes(pdf.encode())
    # `download` is relative to the API base (/api/v1) so clients prepend it once.
    return ok({"format": fmt, "name": name, "download": f"/exports/{name}"})


@router.get("/exports/{name}")
def download_export(name: str, user_id: str = Depends(current_user)):
    p = (config.EXPORTS_DIR / Path(name).name).resolve()
    if config.EXPORTS_DIR.resolve() not in p.parents or not p.exists():
        raise HTTPException(404, "export not found")
    return FileResponse(p)


@router.post("/workspaces/{workspace_id}/import")
def import_workspace(workspace_id: str, req: ImportIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        imported = 0
        for item in req.files:
            fid = uid("file")
            name = item.get("name", "imported")
            typ = item.get("type", "MD")
            content = item.get("content", "")
            x = item.get("x", 80)
            y = item.get("y", 80)
            stamp = now()
            c.execute(f"INSERT INTO files({_FILE_COLS}) VALUES(?,?,?,?,?,'','',0,'','',?,?,?,0,0,NULL,1,?,?)",
                      (fid, workspace_id, user_id, name, typ, content, x, y, stamp, stamp))
            if content:
                c.execute("INSERT INTO search_documents(file_id,workspace_id,name,content) VALUES(?,?,?,?)", (fid, workspace_id, name, content))
            imported += 1
        record_event(c, workspace_id, "workspace.imported", {"imported": imported})
    return ok({"imported": imported})


# --------------------------------------------------------------------------- #
# share
# --------------------------------------------------------------------------- #
@router.post("/files/{file_id}/share")
def share(file_id: str, req: ShareIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id)
        sid = uid("share")
        share_token = uuid.uuid4().hex
        c.execute("INSERT INTO shares(id,file_id,user_id,token,expires_at,permission,created_at) VALUES(?,?,?,?,?,?,?)",
                  (sid, file_id, user_id, share_token, req.expiresAt, req.permission, now()))
        record_event(c, r["workspace_id"], "file.shared", {"fileId": file_id, "permission": req.permission})
        notify(c, user_id, f"文件「{r['name']}」已生成分享链接")
    return ok({"id": sid, "token": share_token, "url": f"/api/v1/shares/{share_token}"})


@router.get("/shares/{share_token}")
def public_share(share_token: str):
    with db.db() as c:
        r = c.execute(
            "SELECT f.id,f.name,f.type,f.mime,f.summary,f.content,s.expires_at,s.permission "
            "FROM shares s JOIN files f ON f.id=s.file_id WHERE s.token=? AND f.deleted=0",
            (share_token,),
        ).fetchone()
        if not r:
            raise HTTPException(404, "share not found")
        if r["expires_at"] and r["expires_at"] < now():
            raise HTTPException(404, "share expired")
        permission = r["permission"] or "read"
        out = {"id": r["id"], "name": r["name"], "type": r["type"], "mime": r["mime"], "summary": r["summary"], "permission": permission}
        if permission == "edit":
            out["content"] = r["content"]
    return ok(camelize(out))


@router.delete("/shares/{share_id}")
def delete_share(share_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        cur = c.execute("DELETE FROM shares WHERE id=? AND user_id=?", (share_id, user_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "share not found")
    return ok(True)


# --------------------------------------------------------------------------- #
# comments
# --------------------------------------------------------------------------- #
@router.get("/workspaces/{workspace_id}/comments")
def comments(workspace_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
        rows = c.execute(
            "SELECT c.* FROM comments c JOIN files f ON f.id=c.file_id WHERE f.workspace_id=? ORDER BY c.created_at DESC",
            (workspace_id,),
        ).fetchall()
    return ok({"items": [camelize(dict(r)) for r in rows]})


@router.post("/files/{file_id}/comments")
def create_comment(file_id: str, req: CommentIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        r = get_file(c, file_id, user_id)
        cid = uid("comment")
        stamp = now()
        c.execute("INSERT INTO comments(id,file_id,user_id,text,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                  (cid, file_id, user_id, req.text, stamp, stamp))
        record_event(c, r["workspace_id"], "comment.created", {"fileId": file_id, "commentId": cid})
        notify(c, user_id, f"已为「{r['name']}」添加评论")
    return ok({"id": cid, "text": req.text, "createdAt": stamp})


@router.patch("/comments/{comment_id}")
def patch_comment(comment_id: str, req: CommentIn, user_id: str = Depends(current_user)):
    with db.db() as c:
        cur = c.execute("UPDATE comments SET text=?,updated_at=? WHERE id=? AND user_id=?", (req.text, now(), comment_id, user_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "comment not found")
    return ok({"id": comment_id, "text": req.text})


@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        cur = c.execute("DELETE FROM comments WHERE id=? AND user_id=?", (comment_id, user_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "comment not found")
    return ok(True)


# --------------------------------------------------------------------------- #
# notifications
# --------------------------------------------------------------------------- #
@router.get("/notifications")
def notifications(user_id: str = Depends(current_user)):
    with db.db() as c:
        rows = c.execute("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100", (user_id,)).fetchall()
        items = [camelize({"id": r["id"], "text": r["text"], "unread": bool(r["unread"]), "created_at": r["created_at"]}) for r in rows]
    return ok({"items": items})


@router.post("/notifications/{notification_id}/read")
def read_notification(notification_id: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        cur = c.execute("UPDATE notifications SET unread=0 WHERE id=? AND user_id=?", (notification_id, user_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "notification not found")
    return ok(True)


@router.post("/notifications/read-all")
def read_notifications(user_id: str = Depends(current_user)):
    with db.db() as c:
        c.execute("UPDATE notifications SET unread=0 WHERE user_id=?", (user_id,))
    return ok(True)


# --------------------------------------------------------------------------- #
# AI
# --------------------------------------------------------------------------- #
@router.post("/ai/chat")
def ai_chat(req: ChatIn, user_id: str = Depends(current_user)):
    files = req.files
    if req.workspaceId:
        with db.db() as c:
            ensure_workspace(c, req.workspaceId, user_id)
            rows = c.execute("SELECT * FROM files WHERE workspace_id=? AND deleted=0 ORDER BY updated_at DESC LIMIT 100", (req.workspaceId,)).fetchall()
            files = [serialize_file(r, include_content=True) for r in rows]
    return ok(ai.chat(req.question, files, req.workspaceId))


@router.post("/ai/chat/stream")
def ai_chat_stream(req: ChatIn, user_id: str = Depends(current_user)):
    files = req.files
    if req.workspaceId:
        with db.db() as c:
            ensure_workspace(c, req.workspaceId, user_id)
            rows = c.execute("SELECT * FROM files WHERE workspace_id=? AND deleted=0 ORDER BY updated_at DESC LIMIT 100", (req.workspaceId,)).fetchall()
            files = [serialize_file(r, include_content=True) for r in rows]
    ranked = ai.retrieve(files, req.question, k=6)
    context = ai.build_context(ranked)
    llm = ai.get_llm()

    def gen():
        if llm is None:
            yield "data: " + json.dumps({"done": True, "mode": "fallback", "text": "（离线）AI 服务未配置。"}, ensure_ascii=False) + "\n\n"
            return
        try:
            for chunk in llm.stream("仅依据下方资料回答，若资料不足请明确说明。\n资料：\n" + context + "\n\n问题：" + req.question):
                text = chunk.content if hasattr(chunk, "content") else str(chunk)
                if text:
                    yield "data: " + json.dumps({"done": False, "text": text}, ensure_ascii=False) + "\n\n"
        except Exception:
            yield "data: " + json.dumps({"done": True, "mode": "fallback", "text": "（离线）AI 服务不可用。"}, ensure_ascii=False) + "\n\n"
            return
        yield "data: " + json.dumps({"done": True, "mode": "langchain"}, ensure_ascii=False) + "\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/ai/summarize")
def ai_summary(req: SummaryIn, user_id: str = Depends(current_user)):
    content = req.content or ""
    fid = req.fileId
    r = None
    if fid:
        with db.db() as c:
            r = get_file(c, fid, user_id)
            content = r["content"] or content
    summary, mode = ai.summarize(content)
    if fid and r is not None:
        with db.db() as c:
            c.execute("UPDATE files SET summary=? WHERE id=?", (summary, fid))
            record_event(c, r["workspace_id"], "file.summarized", {"fileId": fid})
            notify(c, user_id, f"AI 已更新「{r['name']}」的摘要")
    entities, todos, conclusion = ai.extract_capsule(content)
    return ok({"summary": summary, "entities": entities, "todos": todos, "conclusion": conclusion, "mode": mode})


@router.post("/ai/tags")
def ai_tags(req: TagsIn, user_id: str = Depends(current_user)):
    llm = ai.get_llm()
    if llm is not None:
        try:
            raw = str(llm.invoke("只输出最多5个逗号分隔的中文标签：\n" + req.name + "\n" + req.content).content)
            values = [x.strip() for x in raw.replace("，", ",").split(",") if x.strip()][:5]
            return ok({"tags": values, "mode": "langchain"})
        except Exception:
            pass
    # deterministic keyword fallback (real, not fake)
    terms = ai._terms(req.name + " " + req.content)
    values = sorted(terms)[:5] or ["文档", "待整理"]
    return ok({"tags": values, "mode": "fallback"})


@router.post("/ai/links")
def ai_links(req: LinksIn, user_id: str = Depends(current_user)):
    source_terms = ai._terms(str(req.source.get("name", "")) + " " + str(req.source.get("summary", "")))
    scored = []
    for item in req.candidates:
        t = ai._terms(str(item.get("name", "")) + " " + str(item.get("summary", "")))
        overlap = len(source_terms & t)
        scored.append({"id": item.get("id"), "sim": min(95, 40 + overlap * 10)})
    return ok({"suggestions": sorted(scored, key=lambda x: x["sim"], reverse=True)[:5], "mode": "fallback"})


@router.post("/ai/capsule")
def ai_capsule(req: SummaryIn, user_id: str = Depends(current_user)):
    content = req.content or ""
    if req.fileId:
        with db.db() as c:
            content = get_file(c, req.fileId, user_id)["content"] or content
    entities, todos, conclusion = ai.extract_capsule(content)
    return ok({"entities": entities, "todos": todos, "conclusion": conclusion, "mode": "fallback"})


@router.post("/ai/cover")
def ai_cover(req: CoverIn, user_id: str = Depends(current_user)):
    """Generate a deterministic semantic SVG cover without external image services."""
    title, content = req.title.strip(), req.content
    if req.fileId:
        with db.db() as c:
            row = get_file(c, req.fileId, user_id)
            title = title or row["name"]
            content = content or row["content"]
    title = title or "FileHub"
    digest = hashlib.sha256((title + content[:500]).encode("utf-8")).hexdigest()
    palettes = [("#0f766e", "#14b8a6"), ("#1d4ed8", "#60a5fa"), ("#9f1239", "#fb7185"), ("#3f6212", "#84cc16"), ("#6b21a8", "#c084fc")]
    c1, c2 = palettes[int(digest[:2], 16) % len(palettes)]
    safe_title = html.escape(title[:28])
    subtitle = html.escape(" · ".join(sorted(ai._terms(content))[:3]) or "知识资产")
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
<defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient></defs>
<rect width="960" height="540" fill="url(#g)"/><rect x="64" y="64" width="832" height="412" rx="8" fill="#fff" fill-opacity=".12"/>
<text x="96" y="260" fill="white" font-family="Arial,Microsoft YaHei" font-size="52" font-weight="700">{safe_title}</text>
<text x="98" y="318" fill="white" fill-opacity=".82" font-family="Arial,Microsoft YaHei" font-size="24">{subtitle}</text>
<text x="98" y="430" fill="white" fill-opacity=".68" font-family="Arial" font-size="18">FILEHUB · {digest[:8].upper()}</text></svg>'''
    import base64
    data_url = "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return ok({"cover": data_url, "mime": "image/svg+xml", "mode": "deterministic"})


@router.post("/ai/health-score")
def ai_health(body: dict[str, Any] = Body(...), user_id: str = Depends(current_user)):
    content = body.get("content") or ""
    updated_at = body.get("updatedAt")
    links = int(body.get("links", 0) or 0)
    has_tags = bool(body.get("tags"))
    return ok({**ai.health_score(content, updated_at, links, has_tags), "mode": "fallback"})


@router.post("/ai/dedup-score")
def ai_dedup(body: dict[str, Any] = Body(...), user_id: str = Depends(current_user)):
    a = body.get("a") or body.get("contentA") or ""
    b = body.get("b") or body.get("contentB") or ""
    return ok({"similarity": ai.dedup_score(a, b), "mode": "fallback"})


# --------------------------------------------------------------------------- #
# sync
# --------------------------------------------------------------------------- #
@router.get("/sync/snapshot")
def sync_snapshot(workspaceId: str, user_id: str = Depends(current_user)):
    with db.db() as c:
        ensure_workspace(c, workspaceId, user_id)
        ws = c.execute("SELECT * FROM workspaces WHERE id=?", (workspaceId,)).fetchone()
        files = c.execute("SELECT * FROM files WHERE workspace_id=? AND deleted=0", (workspaceId,)).fetchall()
        canvas = _canvas_payload(c, workspaceId)
        return ok({
            "workspace": camelize(dict(ws)),
            "canvas": canvas,
            "files": files_with_tags(c, files, include_content=True),
            "serverTime": now(),
        })


@router.post("/sync/changes")
def sync_changes(req: SyncChangesIn, user_id: str = Depends(current_user)):
    applied = 0
    conflicts: list[dict] = []
    with db.db() as c:
        if req.workspaceId:
            ensure_workspace(c, req.workspaceId, user_id)
        for ch in req.changes:
            fid = ch.get("fileId")
            if not fid:
                continue
            row = c.execute("SELECT * FROM files WHERE id=? AND user_id=?", (fid, user_id)).fetchone()
            if not row:
                conflicts.append({"fileId": fid, "reason": "not_found"})
                continue
            base = ch.get("baseUpdatedAt")
            if base and row["updated_at"] != base:
                conflicts.append({"fileId": fid, "reason": "conflict", "serverUpdatedAt": row["updated_at"]})
                continue
            updates: dict[str, Any] = {}
            for col in ("name", "content", "x", "y", "favorite"):
                if ch.get(col) is not None:
                    updates[col] = ch[col]
            if "deleted" in ch and ch["deleted"] is not None:
                updates["deleted"] = 1 if ch["deleted"] else 0
                if ch["deleted"]:
                    updates["deleted_at"] = now()
            if updates:
                sets = ", ".join(f"{k}=?" for k in updates)
                c.execute(f"UPDATE files SET {sets},updated_at=? WHERE id=?", list(updates.values()) + [now(), fid])
                applied += 1
            if ch.get("content") is not None:
                c.execute("UPDATE search_documents SET content=? WHERE file_id=?", (ch["content"], fid))
        if req.workspaceId:
            record_event(c, req.workspaceId, "sync.changes", {"applied": applied, "conflicts": len(conflicts)})
    return ok({"accepted": applied, "conflicts": conflicts, "serverTime": now()})


@router.post("/sync/resolve")
def sync_resolve(req: SyncResolveIn, user_id: str = Depends(current_user)):
    fid = req.fileId
    if not fid:
        raise HTTPException(400, "fileId required")
    with db.db() as c:
        row = c.execute("SELECT * FROM files WHERE id=? AND user_id=?", (fid, user_id)).fetchone()
        if not row:
            raise HTTPException(404, "file not found")
        if req.resolution == "client" and req.content is not None:
            c.execute("UPDATE files SET content=?,updated_at=? WHERE id=?", (req.content, now(), fid))
            c.execute("UPDATE search_documents SET content=? WHERE file_id=?", (req.content, fid))
    return ok({"resolution": req.resolution, "fileId": fid, "serverTime": now()})


# --------------------------------------------------------------------------- #
# misc
# --------------------------------------------------------------------------- #
@router.get("/health")
def health():
    return ok({
        "status": "ok",
        "version": "1.0.0",
        "configured": bool(config.OPENAI_API_KEY and config.OPENAI_API_KEY != "replace-me"),
    })


@router.get("/pwa/manifest")
def pwa_manifest():
    return ok({"name": "FileHub", "shortName": "FileHub", "startUrl": "./", "display": "standalone", "themeColor": "#1d1d1f", "serviceWorker": "/service-worker.js"})


@router.get("/audit")
def list_audit(page: int = 1, pageSize: int = 100, user_id: str = Depends(current_user)):
    page = max(1, page)
    pageSize = max(1, min(200, pageSize))
    with db.db() as c:
        total = c.execute("SELECT count(*) n FROM audit_log WHERE user_id=?", (user_id,)).fetchone()["n"]
        rows = c.execute("SELECT * FROM audit_log WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?", (user_id, pageSize, (page - 1) * pageSize)).fetchall()
        items = [camelize(dict(r)) for r in rows]
    return ok({"items": items, "total": total, "page": page, "pageSize": pageSize})


# --------------------------------------------------------------------------- #
# WebSocket (ticket-authenticated)
# --------------------------------------------------------------------------- #
class Hub:
    def __init__(self) -> None:
        self.sockets: dict[str, set[WebSocket]] = {}

    def connect(self, workspace_id: str, ws: WebSocket) -> None:
        self.sockets.setdefault(workspace_id, set()).add(ws)

    def disconnect(self, workspace_id: str, ws: WebSocket) -> None:
        self.sockets.get(workspace_id, set()).discard(ws)

    async def broadcast(self, workspace_id: str, message: dict) -> None:
        for ws in list(self.sockets.get(workspace_id, set())):
            try:
                await ws.send_json(message)
            except Exception:
                self.sockets[workspace_id].discard(ws)


hub = Hub()


@router.post("/ws/ticket")
def ws_ticket(body: dict[str, Any] = Body(...), user_id: str = Depends(current_user)):
    workspace_id = body.get("workspaceId")
    if not workspace_id:
        raise HTTPException(400, "workspaceId required")
    with db.db() as c:
        ensure_workspace(c, workspace_id, user_id)
    return ok({"ticket": security.make_ws_ticket(user_id, workspace_id), "expiresIn": config.WS_TICKET_TTL_SEC})


@router.websocket("/ws/workspaces/{workspace_id}")
async def websocket_endpoint(ws: WebSocket, workspace_id: str):
    ticket = ws.query_params.get("ticket", "")
    payload = security.decode_token(ticket)
    if not payload or payload.get("typ") != "ws" or payload.get("aud") != workspace_id:
        await ws.accept()
        await ws.close(code=4401)
        return
    user_id = payload.get("sub")
    with db.db() as c:
        owned = c.execute("SELECT 1 FROM workspaces WHERE id=? AND user_id=?", (workspace_id, user_id)).fetchone()
    if not owned:
        await ws.accept()
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.connect(workspace_id, ws)
    await ws.send_json({"event": "presence.join", "workspaceId": workspace_id, "createdAt": now(), "userId": user_id})
    try:
        while True:
            data = await ws.receive_json()
            event = data.get("event", "message")
            await hub.broadcast(workspace_id, {
                "event": event, "workspaceId": workspace_id,
                "payload": data.get("payload", {}), "createdAt": now(), "userId": user_id,
            })
    except WebSocketDisconnect:
        hub.disconnect(workspace_id, ws)
        await hub.broadcast(workspace_id, {"event": "presence.leave", "workspaceId": workspace_id, "createdAt": now(), "userId": user_id})
