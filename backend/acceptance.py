"""Live Docker acceptance mapped one-to-one to PRD E1-E10 and C1-C20."""
from __future__ import annotations

import json
import os
import sys
import uuid

import httpx
from websockets.sync.client import connect

BASE = os.getenv("FILEHUB_ACCEPTANCE_API", "http://127.0.0.1:8787/api/v1")
WEB = os.getenv("FILEHUB_ACCEPTANCE_WEB", "http://web")
client = httpx.Client(timeout=45)
web_client = httpx.Client(timeout=10, trust_env=False)
results: dict[str, dict] = {}


def call(method: str, path: str, *, auth: bool = True, **kwargs):
    headers = kwargs.pop("headers", {})
    if auth and token:
        headers["Authorization"] = "Bearer " + token
    r = client.request(method, BASE + path, headers=headers, **kwargs)
    if r.status_code >= 400:
        raise AssertionError(f"{method} {path}: {r.status_code} {r.text[:240]}")
    content_type = r.headers.get("content-type", "")
    return r.json()["data"] if "json" in content_type else r.content


def check(fid: str, title: str, fn):
    try:
        detail = fn()
        results[fid] = {"status": "PASS", "title": title, "detail": str(detail or "ok")[:160]}
    except Exception as exc:
        results[fid] = {"status": "FAIL", "title": title, "detail": f"{type(exc).__name__}: {exc}"[:240]}


login = client.post(BASE + "/auth/login", json={"email": "demo@filehub.local", "password": "FileHubDemo123!"})
login.raise_for_status()
token = login.json()["data"]["accessToken"]
seed_ws = call("GET", "/workspaces")["items"][0]["id"]
temp_ws = call("POST", "/workspaces", json={"name": "验收临时工作区 " + uuid.uuid4().hex[:6]})["id"]


def upload(name: str, body: str):
    return call("POST", f"/workspaces/{temp_ws}/files", files={"upload": (name, body.encode(), "text/markdown")})


a = upload("验收架构.md", "# 验收架构\nLangChain 检索 架构 风险\n- [ ] 完成上线评审")
b = upload("验收风险.md", "# 验收风险\nLangChain 检索 架构 风险\n- [ ] 完成上线评审")

html = web_client.get(WEB + "/").text
app_js = web_client.get(WEB + "/js/app.js").text
workspace_js = web_client.get(WEB + "/js/workspace.js").text
feature_js = web_client.get(WEB + "/js/feature-api.js").text + web_client.get(WEB + "/js/features.js").text
css = "\n".join(web_client.get(WEB + p).text for p in ["/css/app.css", "/css/workspace.css", "/css/dark.css"])
sw = web_client.get(WEB + "/service-worker.js").text

check("E1", "深色模式", lambda: "data-theme" if "data-theme" in app_js and ':root[data-theme="dark"]' in css else (_ for _ in ()).throw(AssertionError("theme missing")))
check("E2", "命令面板", lambda: "cmdPalette" if "cmdPalette" in html and "cmdCommands" in app_js else (_ for _ in ()).throw(AssertionError("palette missing")))

def e3():
    cur = call("GET", f"/workspaces/{temp_ws}/canvas")
    call("PUT", f"/workspaces/{temp_ws}/canvas", json={"revision": cur["revision"], "nodes": [{"id": a["id"]}], "connections": [], "viewport": {}})
    call("POST", f"/workspaces/{temp_ws}/canvas/undo", json={})
    call("POST", f"/workspaces/{temp_ws}/canvas/redo", json={})
    return "revision undo/redo"
check("E3", "撤销重做", e3)
check("E4", "响应式", lambda: "@media" if "@media" in css and 'name="viewport"' in html else (_ for _ in ()).throw(AssertionError("responsive missing")))
check("E5", "设置中心", lambda: "settingsModal" if "settingsModal" in html and "fh_model_preference" in app_js else (_ for _ in ()).throw(AssertionError("settings missing")))
check("E6", "通知中心", lambda: len(call("GET", "/notifications")["items"]))
check("E7", "新手引导", lambda: "fh_onboard" if "fh_onboard" in app_js and "onboard" in html else (_ for _ in ()).throw(AssertionError("onboarding missing")))

def e8():
    f = upload("回收站验收.md", "trash restore purge")
    call("DELETE", f"/files/{f['id']}")
    assert any(x["id"] == f["id"] for x in call("GET", f"/workspaces/{temp_ws}/trash")["items"])
    call("POST", f"/files/{f['id']}/restore", json={})
    call("DELETE", f"/files/{f['id']}"); call("DELETE", f"/files/{f['id']}/purge")
    return "delete/restore/purge"
check("E8", "回收站", e8)

def e9():
    signatures = {"json": b"{", "png": b"\x89PNG", "pdf": b"%PDF"}
    for fmt, sig in signatures.items():
        out = call("POST", f"/workspaces/{temp_ws}/export", json={"format": fmt})
        r = client.get(BASE + out["download"], headers={"Authorization": "Bearer " + token})
        r.raise_for_status(); blob = r.content
        assert blob.startswith(sig), (fmt, blob[:8])
    return "json/png/pdf"
check("E9", "导出备份", e9)
check("E10", "快捷键", lambda: "shortcutsModal" if "shortcutsModal" in html and "Ctrl / Cmd + K" in app_js else (_ for _ in ()).throw(AssertionError("shortcuts missing")))

check("C1", "力导向布局", lambda: call("POST", f"/workspaces/{temp_ws}/layouts/force", json={})["algorithm"])
check("C2", "时间线", lambda: len(call("GET", f"/workspaces/{temp_ws}/timeline")["items"]))
check("C3", "无限画布与小地图", lambda: "wheel" if "wheel" in feature_js and "minimap" in (feature_js + workspace_js).lower() else (_ for _ in ()).throw(AssertionError("canvas interactions missing")))

def c4():
    x = call("POST", f"/workspaces/{temp_ws}/anchors", json={"name": "验收锚点", "layout": {a["id"]: {"x": 10, "y": 20}}})
    got = call("GET", f"/workspaces/{temp_ws}/anchors")["items"]
    assert isinstance(got[-1]["layout"], dict)
    call("DELETE", f"/workspaces/{temp_ws}/anchors/{x['id']}")
    return "CRUD"
check("C4", "空间锚点", c4)

def c5():
    t = call("GET", "/templates")["items"][0]
    x = call("POST", f"/workspaces/{temp_ws}/templates/{t['id']}/apply", json={})
    assert len(x["created"]) >= 1
    return len(x["created"])
check("C5", "画布模板", c5)
check("C6", "AI 关联推荐", lambda: len(call("GET", f"/files/{a['id']}/link-suggestions")["items"]))

def c7():
    x = call("POST", "/ai/chat", json={"workspaceId": temp_ws, "question": "架构风险是什么？"})
    assert "answer" in x and "citations" in x
    return x["mode"]
check("C7", "跨文件问答", c7)
check("C8", "摘要胶囊", lambda: call("POST", "/ai/capsule", json={"fileId": a["id"]})["conclusion"])
check("C9", "智能标签", lambda: call("POST", "/ai/tags", json={"name": a["name"], "content": "LangChain 架构 风险"})["tags"])
check("C10", "AI 封面", lambda: call("POST", "/ai/cover", json={"fileId": a["id"]})["cover"][:26])

def c11():
    pairs = call("POST", f"/workspaces/{temp_ws}/dedup/scan", json={})["pairs"]
    assert pairs
    call("POST", f"/dedup/{pairs[0]['id']}/ignore", json={})
    return len(pairs)
check("C11", "重复检测", c11)
check("C12", "健康评分", lambda: len(call("GET", f"/workspaces/{temp_ws}/health")["items"]))

def c13():
    ticket = call("POST", "/ws/ticket", json={"workspaceId": temp_ws})["ticket"]
    with connect(f"ws://127.0.0.1:8787/api/v1/ws/workspaces/{temp_ws}?ticket={ticket}", open_timeout=10) as ws:
        first = json.loads(ws.recv(timeout=10))
        assert first["event"] == "presence.join"
        ws.send(json.dumps({"event": "cursor.move", "payload": {"x": 1, "y": 2}}))
    return "presence.join"
check("C13", "协同在线", c13)

def c14():
    x = call("POST", f"/files/{a['id']}/comments", json={"text": "@团队 验收批注"})
    call("PATCH", f"/comments/{x['id']}", json={"text": "批注已更新"})
    call("DELETE", f"/comments/{x['id']}")
    return "CRUD"
check("C14", "批注便签", c14)

def c15():
    x = call("POST", f"/files/{a['id']}/share", json={"permission": "read"})
    public = call("GET", f"/shares/{x['token']}", auth=False)
    assert public["permission"] == "read"
    call("DELETE", f"/shares/{x['id']}")
    return "create/access/revoke"
check("C15", "分享权限", c15)

def c16():
    call("POST", f"/files/{a['id']}/links", json={"targetId": b["id"]})
    backs = call("GET", f"/files/{b['id']}/backlinks")
    assert any(x["id"] == a["id"] for x in backs["items"])
    return backs["total"]
check("C16", "反向链接", c16)
check("C17", "关系图谱", lambda: len(call("GET", f"/workspaces/{temp_ws}/graph")["edges"]))

def c18():
    call("PATCH", f"/files/{a['id']}", json={"favorite": True})
    fav = call("GET", f"/workspaces/{temp_ws}/favorites")
    assert any(x["id"] == a["id"] for x in fav["items"])
    return fav["total"]
check("C18", "智能收藏", c18)
check("C19", "全文检索", lambda: call("GET", f"/workspaces/{temp_ws}/search?q=LangChain")["items"][0]["snippet"])

def c20():
    snap = call("GET", f"/sync/snapshot?workspaceId={temp_ws}")
    synced = call("POST", "/sync/changes", json={"workspaceId": temp_ws, "changes": []})
    manifest = call("GET", "/pwa/manifest")
    assert snap["files"] and synced["accepted"] == 0 and "serviceWorker" in manifest and "filehub-shell-v17" in sw
    return "snapshot/sync/service-worker"
check("C20", "PWA 离线同步", c20)

call("DELETE", f"/workspaces/{temp_ws}")
failed = {k: v for k, v in results.items() if v["status"] != "PASS"}
print(json.dumps({"summary": {"passed": len(results) - len(failed), "failed": len(failed), "total": len(results)}, "features": results}, ensure_ascii=False, indent=2))
sys.exit(1 if failed else 0)
