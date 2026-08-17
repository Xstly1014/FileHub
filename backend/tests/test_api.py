"""FileHub API acceptance test suite (unittest + TestClient).

Covers the security/correctness fixes from docs/API_AUDIT.md:
P0 (auth/JWT/refresh rotation, WS ticket, export auth, share expiry, column
mapping, snapshot-before-restore, safe deletion) and P1 (camelCase + tag arrays,
tag/recent filters, FTS escaping, pagination, real undo/redo/dedup/sync/graph/
timeline/notifications, 404 on missing deletes, cascade deletes, upload limits).

Run from the backend directory:
    ./.venv/Scripts/python.exe -m unittest discover -s tests -v
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest

# Configure a fully isolated runtime BEFORE importing the app.
_TMP = tempfile.mkdtemp(prefix="filehub-test-")
os.environ["FILEHUB_JWT_SECRET"] = "test-secret-1234567890"
os.environ["FILEHUB_RUNTIME_DIR"] = _TMP
os.environ["OPENAI_API_KEY"] = ""
os.environ["OPENAI_BASE_URL"] = ""

from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from fhapi import app, db  # noqa: E402
from fhapi import config  # noqa: E402

db.init_db()


def body(resp):
    return resp.json()


def data(resp):
    return resp.json()["data"]


class BaseCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.email = cls.__name__.lower() + "@example.com"
        r = cls.client.post("/api/v1/auth/register",
                            json={"email": cls.email, "password": "password123", "displayName": "Tester"})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        cls.token = d["accessToken"]
        cls.refresh = d["refreshToken"]
        cls.user_id = d["user"]["id"]
        cls.H = {"Authorization": "Bearer " + cls.token}
        cls.ws = cls.client.get("/api/v1/workspaces", headers=cls.H).json()["data"]["items"][0]["id"]


class TestAuth(BaseCase):
    def test_register_rejects_invalid_email(self):
        r = self.client.post("/api/v1/auth/register",
                             json={"email": "not-an-email", "password": "password123", "displayName": "X"})
        self.assertEqual(r.status_code, 422)

    def test_register_rejects_short_password(self):
        r = self.client.post("/api/v1/auth/register",
                             json={"email": "short@example.com", "password": "123", "displayName": "X"})
        self.assertEqual(r.status_code, 422)

    def test_register_duplicate_conflict(self):
        r = self.client.post("/api/v1/auth/register",
                             json={"email": self.email, "password": "password123", "displayName": "T2"})
        self.assertEqual(r.status_code, 409)

    def test_login_and_me(self):
        r = self.client.post("/api/v1/auth/login", json={"email": self.email, "password": "password123"})
        self.assertEqual(r.status_code, 200)
        token = data(r)["accessToken"]
        me = self.client.get("/api/v1/auth/me", headers={"Authorization": "Bearer " + token})
        self.assertEqual(me.json()["data"]["email"], self.email)

    def test_login_wrong_password_401(self):
        r = self.client.post("/api/v1/auth/login", json={"email": self.email, "password": "wrongpassword"})
        self.assertEqual(r.status_code, 401)

    def test_refresh_rotation(self):
        # refresh once
        r = self.client.post("/api/v1/auth/refresh", json={"refreshToken": self.refresh})
        self.assertEqual(r.status_code, 200)
        new_tokens = data(r)
        self.assertNotEqual(new_tokens["refreshToken"], self.refresh)
        # the OLD refresh token must now be rejected (rotation)
        r2 = self.client.post("/api/v1/auth/refresh", json={"refreshToken": self.refresh})
        self.assertEqual(r2.status_code, 401)
        # the new one still works
        r3 = self.client.post("/api/v1/auth/refresh", json={"refreshToken": new_tokens["refreshToken"]})
        self.assertEqual(r3.status_code, 200)

    def test_refresh_rejects_garbage(self):
        r = self.client.post("/api/v1/auth/refresh", json={"refreshToken": "not-a-token"})
        self.assertEqual(r.status_code, 401)

    def test_patch_me_rejects_empty_name(self):
        r = self.client.patch("/api/v1/auth/me", headers=self.H, json={"displayName": ""})
        self.assertEqual(r.status_code, 422)

    def test_change_password_invalidates_old_access(self):
        # use a dedicated user so we don't disturb this class's shared token
        em = "changepw@example.com"
        r = self.client.post("/api/v1/auth/register",
                             json={"email": em, "password": "password123", "displayName": "CP"})
        d = data(r)
        old = d["accessToken"]
        h = {"Authorization": "Bearer " + old}
        r = self.client.post("/api/v1/auth/change-password", headers=h,
                             json={"currentPassword": "password123", "newPassword": "newpassword123"})
        self.assertEqual(r.status_code, 200)
        # old access token must be revoked (token_version bump)
        me = self.client.get("/api/v1/auth/me", headers=h)
        self.assertEqual(me.status_code, 401)
        # new password works
        login = self.client.post("/api/v1/auth/login", json={"email": em, "password": "newpassword123"})
        self.assertEqual(login.status_code, 200)

    def test_unauthorized_401(self):
        r = self.client.get("/api/v1/workspaces")
        self.assertEqual(r.status_code, 401)
        self.assertIn("code", r.json())

    def test_error_envelope_shape(self):
        r = self.client.get("/api/v1/files/does-not-exist", headers=self.H)
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()["code"], 40401)
        self.assertIn("traceId", r.json())
        self.assertIn("X-Trace-Id", r.headers)


class TestWorkspaces(BaseCase):
    def test_create_and_list(self):
        r = self.client.post("/api/v1/workspaces", headers=self.H, json={"name": "Project X"})
        self.assertEqual(r.status_code, 200)
        wid = data(r)["id"]
        items = data(self.client.get("/api/v1/workspaces", headers=self.H))["items"]
        self.assertTrue(any(w["id"] == wid for w in items))

    def test_delete_workspace_cascades(self):
        r = self.client.post("/api/v1/workspaces", headers=self.H, json={"name": "ToDelete"})
        wid = data(r)["id"]
        self.client.post(f"/api/v1/workspaces/{wid}/files", headers=self.H,
                         files={"upload": ("a.md", b"# hello cascade", "text/markdown")})
        self.client.delete(f"/api/v1/workspaces/{wid}", headers=self.H)
        # file list now 404 (workspace gone)
        r2 = self.client.get(f"/api/v1/workspaces/{wid}/files", headers=self.H)
        self.assertEqual(r2.status_code, 404)

    def test_cannot_access_other_users_workspace(self):
        # create a second user and try to access our workspace
        r = self.client.post("/api/v1/auth/register",
                             json={"email": "other@example.com", "password": "password123", "displayName": "Other"})
        other_token = data(r)["accessToken"]
        r2 = self.client.get(f"/api/v1/workspaces/{self.ws}", headers={"Authorization": "Bearer " + other_token})
        self.assertEqual(r2.status_code, 404)


class TestFiles(BaseCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        r = cls.client.post(f"/api/v1/workspaces/{cls.ws}/files", headers=cls.H,
                            files={"upload": ("note.md", "# 标题\n\n这是关于 LangChain 架构的中文内容。", "text/markdown")})
        assert r.status_code == 200, r.text
        cls.file_id = data(r)["id"]

    def test_upload_text_indexed_and_summary_empty(self):
        # P0-6: summary must NOT contain the file content
        d = data(self.client.get(f"/api/v1/files/{self.file_id}", headers=self.H))
        self.assertEqual(d["summary"], "")
        self.assertIn("LangChain", d["content"])
        self.assertEqual(d["type"], "MD")
        # tags is an array, not a comma string (P1-1)
        self.assertIsInstance(d["tags"], list)

    def test_list_files_pagination_shape(self):
        d = data(self.client.get(f"/api/v1/workspaces/{self.ws}/files?page=1&pageSize=10", headers=self.H))
        self.assertIn("items", d)
        self.assertIn("total", d)
        self.assertIn("page", d)
        # camelCase keys, no snake_case (P1-1)
        self.assertTrue(all("updatedAt" in f for f in d["items"]))

    def test_list_files_tag_and_recent_filters(self):
        # tag filter (P1-2)
        self.client.post(f"/api/v1/files/{self.file_id}/tags", headers=self.H, json={"name": "专题"})
        d = data(self.client.get(f"/api/v1/workspaces/{self.ws}/files?tag=专题", headers=self.H))
        self.assertEqual(d["total"], 1)
        # recent filter (P1-2)
        d2 = data(self.client.get(f"/api/v1/workspaces/{self.ws}/files?recent=true", headers=self.H))
        self.assertGreaterEqual(d2["total"], 1)

    def test_upload_oversize_rejected(self):
        old = config.MAX_UPLOAD_BYTES
        config.MAX_UPLOAD_BYTES = 10
        try:
            r = self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                                 files={"upload": ("big.md", b"x" * 100, "text/markdown")})
            self.assertEqual(r.status_code, 413)
        finally:
            config.MAX_UPLOAD_BYTES = old

    def test_upload_blocked_extension(self):
        r = self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                             files={"upload": ("evil.exe", b"MZ", "application/octet-stream")})
        self.assertEqual(r.status_code, 415)

    def test_content_save_bumps_version_and_snapshots(self):
        fid = data(self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                                    files={"upload": ("v.md", "v1", "text/markdown")}))["id"]
        v1 = data(self.client.get(f"/api/v1/files/{fid}/versions", headers=self.H))["items"]
        r = self.client.put(f"/api/v1/files/{fid}/content", headers=self.H,
                            json={"content": "v2 content"})
        self.assertEqual(r.status_code, 200)
        v2 = data(self.client.get(f"/api/v1/files/{fid}/versions", headers=self.H))["items"]
        self.assertEqual(len(v2), len(v1) + 1)

    def test_version_restore_snapshots_current(self):
        # P0-7: restoring an old version must first snapshot the current content
        fid = data(self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                                    files={"upload": ("vr.md", "original", "text/markdown")}))["id"]
        self.client.put(f"/api/v1/files/{fid}/content", headers=self.H, json={"content": "current"})
        versions = data(self.client.get(f"/api/v1/files/{fid}/versions", headers=self.H))["items"]
        before = len(versions)
        oldest = versions[-1]["id"]
        r = self.client.post(f"/api/v1/files/{fid}/versions/{oldest}/restore", headers=self.H)
        self.assertEqual(r.status_code, 200)
        after = data(self.client.get(f"/api/v1/files/{fid}/versions", headers=self.H))["items"]
        self.assertEqual(len(after), before + 1)

    def test_trash_restore_purge(self):
        r = self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                             files={"upload": ("tmp.md", "temp", "text/markdown")})
        fid = data(r)["id"]
        self.client.delete(f"/api/v1/files/{fid}", headers=self.H)
        trash = data(self.client.get(f"/api/v1/workspaces/{self.ws}/trash", headers=self.H))["items"]
        self.assertTrue(any(f["id"] == fid for f in trash))
        self.client.post(f"/api/v1/files/{fid}/restore", headers=self.H)
        trash2 = data(self.client.get(f"/api/v1/workspaces/{self.ws}/trash", headers=self.H))["items"]
        self.assertFalse(any(f["id"] == fid for f in trash2))
        self.client.delete(f"/api/v1/files/{fid}", headers=self.H)
        self.client.delete(f"/api/v1/files/{fid}/purge", headers=self.H)
        # purged file detail -> 404
        self.assertEqual(self.client.get(f"/api/v1/files/{fid}", headers=self.H).status_code, 404)

    def test_download_returns_original(self):
        r = self.client.get(f"/api/v1/files/{self.file_id}/download", headers=self.H)
        self.assertEqual(r.status_code, 200)
        self.assertIn("LangChain", r.text)

    def test_search_special_chars_no_500(self):
        # P1-3: FTS special characters must not cause a 500
        for q in ['"quoted', "AND OR NOT", "(paren", "a*b", "中文检索"]:
            r = self.client.get(f"/api/v1/workspaces/{self.ws}/search?q={q}", headers=self.H)
            self.assertEqual(r.status_code, 200, f"query {q!r} failed")


class TestTags(BaseCase):
    def test_create_duplicate_returns_existing_id(self):
        # P1-7
        r1 = data(self.client.post("/api/v1/tags", headers=self.H, json={"name": "dup-tag"}))
        r2 = data(self.client.post("/api/v1/tags", headers=self.H, json={"name": "dup-tag"}))
        self.assertEqual(r1["id"], r2["id"])

    def test_patch_delete_missing_404(self):
        # P1-6
        self.assertEqual(self.client.patch("/api/v1/tags/does-not-exist", headers=self.H,
                                           json={"name": "x", "color": "blue"}).status_code, 404)
        self.assertEqual(self.client.delete("/api/v1/tags/does-not-exist", headers=self.H).status_code, 404)


class TestShare(BaseCase):
    def test_share_expiry_enforced(self):
        r = self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                             files={"upload": ("share.md", "secret", "text/markdown")})
        fid = data(r)["id"]
        # expired share
        r = self.client.post(f"/api/v1/files/{fid}/share", headers=self.H,
                             json={"permission": "read", "expiresAt": "2000-01-01T00:00:00"})
        token = data(r)["token"]
        self.assertEqual(self.client.get(f"/api/v1/shares/{token}").status_code, 404)
        # non-expired share
        r = self.client.post(f"/api/v1/files/{fid}/share", headers=self.H, json={"permission": "read"})
        token2 = data(r)["token"]
        d = data(self.client.get(f"/api/v1/shares/{token2}"))
        self.assertEqual(d["permission"], "read")
        self.assertNotIn("content", d)  # read-only hides content
        # edit share exposes content
        r = self.client.post(f"/api/v1/files/{fid}/share", headers=self.H, json={"permission": "edit"})
        token3 = data(r)["token"]
        d3 = data(self.client.get(f"/api/v1/shares/{token3}"))
        self.assertIn("content", d3)


class TestExport(BaseCase):
    def test_export_download_requires_auth(self):
        r = self.client.post(f"/api/v1/workspaces/{self.ws}/export", headers=self.H, json={"format": "json"})
        path = "/api/v1" + data(r)["download"]
        # no auth -> 401
        self.assertEqual(self.client.get(path).status_code, 401)
        # with auth -> 200
        self.assertEqual(self.client.get(path, headers=self.H).status_code, 200)


class TestCanvas(BaseCase):
    def new_ws(self):
        return data(self.client.post("/api/v1/workspaces", headers=self.H, json={"name": "canvas"}))["id"]

    def test_canvas_undo_to_initial_state(self):
        ws = self.new_ws()
        self.client.put(f"/api/v1/workspaces/{ws}/canvas", headers=self.H,
                        json={"revision": 0, "nodes": [{"id": "A"}], "connections": [], "viewport": {}})
        # single save -> undo returns to empty initial revision 0
        u = self.client.post(f"/api/v1/workspaces/{ws}/canvas/undo", headers=self.H)
        self.assertEqual(u.status_code, 200)
        self.assertEqual(data(u)["revision"], 0)
        self.assertEqual(data(u)["nodes"], [])
        # undo again -> 409
        self.assertEqual(self.client.post(f"/api/v1/workspaces/{ws}/canvas/undo", headers=self.H).status_code, 409)

    def test_canvas_revision_conflict_and_undo(self):
        ws = self.new_ws()
        r = self.client.put(f"/api/v1/workspaces/{ws}/canvas", headers=self.H,
                            json={"revision": 0, "nodes": [{"id": "A", "x": 1}], "connections": [], "viewport": {}})
        self.assertEqual(r.status_code, 200)
        rev1 = data(r)["revision"]
        self.assertEqual(rev1, 1)
        # stale revision -> 409 (P1-14)
        r2 = self.client.put(f"/api/v1/workspaces/{ws}/canvas", headers=self.H,
                             json={"revision": 0, "nodes": [], "connections": [], "viewport": {}})
        self.assertEqual(r2.status_code, 409)
        # correct revision -> 200
        self.client.put(f"/api/v1/workspaces/{ws}/canvas", headers=self.H,
                        json={"revision": 1, "nodes": [{"id": "B"}], "connections": [], "viewport": {}})
        # undo -> revision 1 (real undo, P1-5)
        u = self.client.post(f"/api/v1/workspaces/{ws}/canvas/undo", headers=self.H)
        self.assertEqual(data(u)["revision"], 1)
        # redo -> revision 2
        rd = self.client.post(f"/api/v1/workspaces/{ws}/canvas/redo", headers=self.H)
        self.assertEqual(data(rd)["revision"], 2)


class TestGraphAndConnections(BaseCase):
    def test_connections_crud_and_graph_edges(self):
        r1 = self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                              files={"upload": ("one.md", "one", "text/markdown")})
        r2 = self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                              files={"upload": ("two.md", "two", "text/markdown")})
        a, b = data(r1)["id"], data(r2)["id"]
        c = self.client.post(f"/api/v1/workspaces/{self.ws}/connections", headers=self.H,
                             json={"aId": a, "bId": b})
        self.assertEqual(c.status_code, 200)
        cid = data(c)["id"]
        # graph now has an edge (P1-5: graph was always empty)
        edges = data(self.client.get(f"/api/v1/workspaces/{self.ws}/graph", headers=self.H))["edges"]
        self.assertTrue(any(e["source"] == a and e["target"] == b for e in edges))
        # delete connection
        self.client.delete(f"/api/v1/workspaces/{self.ws}/connections/{cid}", headers=self.H)
        edges2 = data(self.client.get(f"/api/v1/workspaces/{self.ws}/graph", headers=self.H))["edges"]
        self.assertFalse(any(e["source"] == a and e["target"] == b for e in edges2))


class TestTimelineAndNotifications(BaseCase):
    def test_timeline_records_events(self):
        self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                         files={"upload": ("event.md", "event", "text/markdown")})
        events = data(self.client.get(f"/api/v1/workspaces/{self.ws}/timeline", headers=self.H))["items"]
        self.assertTrue(any(e["eventType"] == "file.created" for e in events))

    def test_notifications_written_on_comment(self):
        r = self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                             files={"upload": ("n.md", "n", "text/markdown")})
        fid = data(r)["id"]
        self.client.post(f"/api/v1/files/{fid}/comments", headers=self.H, json={"text": "hello"})
        notifs = data(self.client.get("/api/v1/notifications", headers=self.H))["items"]
        self.assertTrue(len(notifs) >= 1)


class TestDedup(BaseCase):
    def test_dedup_scan_ignore_merge(self):
        r1 = self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                              files={"upload": ("dup1.md", "# same content here", "text/markdown")})
        r2 = self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                              files={"upload": ("dup2.md", "# same content here", "text/markdown")})
        a, b = data(r1)["id"], data(r2)["id"]
        scan = data(self.client.post(f"/api/v1/workspaces/{self.ws}/dedup/scan", headers=self.H))["pairs"]
        self.assertTrue(len(scan) >= 1)
        pair = next(p for p in scan if {p["a"], p["b"]} == {a, b})
        self.client.post(f"/api/v1/dedup/{pair['id']}/merge", headers=self.H)
        # b should be gone after merge
        self.assertEqual(self.client.get(f"/api/v1/files/{b}", headers=self.H).status_code, 404)


class TestAI(BaseCase):
    def test_chat_fallback_mode(self):
        r = self.client.post("/api/v1/ai/chat", headers=self.H,
                             json={"question": "LangChain 是什么", "workspaceId": self.ws})
        self.assertEqual(r.status_code, 200)
        d = data(r)
        self.assertEqual(d["mode"], "fallback")  # no LLM key configured in tests
        self.assertIn("answer", d)
        self.assertIn("citations", d)

    def test_summarize_writes_back(self):
        r = self.client.post(f"/api/v1/workspaces/{self.ws}/files", headers=self.H,
                             files={"upload": ("sum.md", "# 标题\n正文内容", "text/markdown")})
        fid = data(r)["id"]
        self.client.post("/api/v1/ai/summarize", headers=self.H, json={"fileId": fid})
        d = data(self.client.get(f"/api/v1/files/{fid}", headers=self.H))
        self.assertTrue(d["summary"])  # summary written back

    def test_health_score_and_dedup_score(self):
        r = self.client.post("/api/v1/ai/health-score", headers=self.H, json={"content": "x" * 600, "links": 2})
        self.assertEqual(r.status_code, 200)
        self.assertIn("score", data(r))
        r2 = self.client.post("/api/v1/ai/dedup-score", headers=self.H,
                              json={"a": "hello world", "b": "hello world"})
        self.assertEqual(data(r2)["similarity"], 100)


class TestWebSocket(BaseCase):
    def test_ws_rejects_without_ticket(self):
        with self.assertRaises(WebSocketDisconnect) as ctx:
            with self.client.websocket_connect(f"/api/v1/ws/workspaces/{self.ws}") as ws:
                ws.receive_text()
        self.assertEqual(ctx.exception.code, 4401)

    def test_ws_ticket_flow(self):
        t = data(self.client.post("/api/v1/ws/ticket", headers=self.H, json={"workspaceId": self.ws}))["ticket"]
        with self.client.websocket_connect(f"/api/v1/ws/workspaces/{self.ws}?ticket={t}") as ws:
            msg = ws.receive_json()
            self.assertEqual(msg["event"], "presence.join")


if __name__ == "__main__":
    unittest.main(verbosity=2)
