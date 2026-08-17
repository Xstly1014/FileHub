/* FileHub Feature Lab: real API-backed implementations for C1-C20. */
(function () {
  "use strict";
  if (!window.App || !App.features || !App.api) return;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(text, run, ghost) {
    var b = el("button", "lab-btn " + (ghost ? "ghost" : "primary"), text);
    b.addEventListener("click", function () {
      b.disabled = true;
      Promise.resolve().then(run).catch(function (e) { App.toast(e.message || "操作失败"); }).finally(function () { b.disabled = false; });
    });
    return b;
  }
  function status(area, text) { var n = el("div", "lab-hint", text); area.appendChild(n); return n; }
  function row(area) { var n = el("div", "lab-row"); area.appendChild(n); return n; }
  function list(area) { var n = el("div", "lab-api-list"); area.appendChild(n); return n; }
  function empty(target, text) { target.innerHTML = ""; target.appendChild(el("div", "lab-hint", text)); }
  function wsid() {
    if (App.remoteWorkspaceId) return Promise.resolve(App.remoteWorkspaceId);
    return App.api.demoAuth().then(function () { return App.api.get("/workspaces"); }).then(function (r) {
      App.remoteWorkspaceId = r.items[0].id; return App.remoteWorkspaceId;
    });
  }
  function files() {
    return wsid().then(function (id) { return App.api.get("/workspaces/" + id + "/files?pageSize=200"); }).then(function (r) { return r.items || []; });
  }
  function selector(items) {
    var s = el("select", "lab-input");
    items.forEach(function (f) { var o = el("option", "", f.name); o.value = f.id; s.appendChild(o); });
    return s;
  }
  function card(target, title, body, action) {
    var n = el("div", "sug-item"); n.appendChild(el("div", "si-name", title));
    if (body) n.appendChild(el("div", "lab-hint", body)); if (action) n.appendChild(action); target.appendChild(n); return n;
  }
  function override(id, render) { if (App.features.byId[id]) App.features.byId[id].render = render; }

  override("force-layout", function (area) {
    var info = status(area, "正在读取画布节点…"), out = list(area);
    row(area).appendChild(button("一键整理", function () { return wsid().then(function (id) { return App.api.post("/workspaces/" + id + "/layouts/force", {}); }).then(function (r) { info.textContent = "已真实计算并保存 " + r.moved + " 个节点位置，算法：" + r.algorithm; return files(); }).then(draw); }));
    function draw(items) { out.innerHTML = ""; items.slice(0, 24).forEach(function (f) { card(out, f.name, "坐标 " + Math.round(f.x) + ", " + Math.round(f.y)); }); info.textContent = "已加载 " + items.length + " 个文件（展示前 24 个）"; }
    files().then(draw).catch(function (e) { info.textContent = e.message; });
  });

  override("timeline", function (area) {
    var out = list(area), info = status(area, "读取事件流…");
    wsid().then(function (id) { return App.api.get("/workspaces/" + id + "/timeline"); }).then(function (r) {
      var items = r.items || []; info.textContent = "共读取 " + items.length + " 条真实事件"; out.innerHTML = "";
      items.slice(0, 50).forEach(function (x, i) { var n = card(out, x.eventType, new Date(x.createdAt).toLocaleString()); n.dataset.index = i; });
      var i = 0; row(area).appendChild(button("回放时间线", function () { var nodes = out.children; if (!nodes.length) return; Array.prototype.forEach.call(nodes, function (n) { n.classList.remove("selected"); }); nodes[i++ % nodes.length].classList.add("selected"); return Promise.resolve(); }, true));
    }).catch(function (e) { info.textContent = e.message; });
  });

  override("anchors", function (area) {
    var out = list(area), inp = el("input", "lab-input"); inp.placeholder = "锚点名称"; var r = row(area); r.appendChild(inp);
    function load() { return wsid().then(function (id) { return App.api.get("/workspaces/" + id + "/anchors"); }).then(function (x) { out.innerHTML = ""; (x.items || []).forEach(function (a) { card(out, a.name, Object.keys(a.layout || {}).length + " 个节点", button("恢复", function () { Object.keys(a.layout || {}).forEach(function (id) { var f = App.data.byId[id]; if (f) { f.x = a.layout[id].x; f.y = a.layout[id].y; } }); App.router.go("#/"); return Promise.resolve(); }, true)); }); }); }
    r.appendChild(button("保存当前布局", function () { var layout = {}; App.data.files.forEach(function (f) { layout[f.id] = { x: f.x, y: f.y }; }); return wsid().then(function (id) { return App.api.post("/workspaces/" + id + "/anchors", { name: inp.value || "新锚点", layout: layout }); }).then(load); })); load();
  });

  override("templates", function (area) {
    var out = list(area), info = status(area, "读取模板库…");
    function load() { return App.api.get("/templates").then(function (r) { out.innerHTML = ""; (r.items || []).forEach(function (t) { card(out, t.name, t.description, button("应用到工作区", function () { return wsid().then(function (id) { return App.api.post("/workspaces/" + id + "/templates/" + t.id + "/apply", {}); }).then(function (x) { App.toast("模板已生成 " + x.created.length + " 个文件"); }); })); }); info.textContent = "模板均来自数据库，可直接生成文件结构"; }); } load().catch(function (e) { info.textContent = e.message; });
  });

  override("ai-links", function (area) {
    var r = row(area), out = list(area), info = status(area, "选择文件后计算语义关联");
    files().then(function (fs) { var s = selector(fs); r.appendChild(s); r.appendChild(button("查找关联", function () { return App.api.get("/files/" + s.value + "/link-suggestions").then(function (x) { out.innerHTML = ""; (x.items || []).forEach(function (v) { card(out, v.name, "相似度 " + v.sim + "%", button("建立连接", function () { return App.api.post("/files/" + s.value + "/links", { targetId: v.id }).then(function () { App.toast("连接已写入数据库"); }); })); }); info.textContent = "本地语义检索已完成"; }); })); });
  });

  override("ai-chat", function (area) {
    var r = row(area), q = el("input", "lab-input"); q.placeholder = "询问工作区资料…"; q.style.width = "420px"; r.appendChild(q); var out = list(area);
    r.appendChild(button("发送", function () { empty(out, "LangChain 正在检索并生成回答…"); return wsid().then(function (id) { return App.api.post("/ai/chat", { workspaceId: id, question: q.value || "当前项目有哪些主要风险？" }); }).then(function (x) { out.innerHTML = ""; card(out, "回答 · " + x.mode, x.answer); (x.citations || []).forEach(function (c) { card(out, "引用：" + (c.name || c.fileId), c.snippet || "相似度 " + c.score); }); }); }));
  });

  override("ai-capsule", function (area) {
    var r = row(area), out = list(area); files().then(function (fs) { var s = selector(fs); r.appendChild(s); r.appendChild(button("提取摘要胶囊", function () { return App.api.post("/ai/capsule", { fileId: s.value }).then(function (x) { out.innerHTML = ""; card(out, "结论", x.conclusion || "资料中未抽取到结论"); card(out, "实体", (x.entities || []).join("、") || "无"); card(out, "待办", (x.todos || []).join("；") || "无"); }); })); });
  });

  override("ai-tags", function (area) {
    var r = row(area), out = list(area); files().then(function (fs) { var s = selector(fs); r.appendChild(s); r.appendChild(button("推荐标签", function () { var f = fs.find(function (x) { return x.id === s.value; }); return App.api.get("/files/" + s.value).then(function (d) { return App.api.post("/ai/tags", { name: f.name, content: d.content }); }).then(function (x) { out.innerHTML = ""; (x.tags || []).forEach(function (name) { card(out, name, "AI 推荐", button("应用", function () { return App.api.post("/files/" + s.value + "/tags", { name: name, color: "blue" }).then(function () { App.toast("标签已写入"); }); }, true)); }); }); })); });
  });

  override("ai-cover", function (area) {
    var r = row(area), img = el("img", ""); img.style.cssText = "display:block;width:min(100%,640px);aspect-ratio:16/9;object-fit:cover;border-radius:8px;margin-top:12px"; files().then(function (fs) { var s = selector(fs); r.appendChild(s); r.appendChild(button("生成封面", function () { return App.api.post("/ai/cover", { fileId: s.value }).then(function (x) { img.src = x.cover; App.toast("语义封面已生成"); }); })); area.appendChild(img); });
  });

  override("dedup", function (area) {
    var out = list(area); row(area).appendChild(button("扫描重复资料", function () { empty(out, "正在比对内容哈希和文本相似度…"); return wsid().then(function (id) { return App.api.post("/workspaces/" + id + "/dedup/scan", {}); }).then(function (x) { out.innerHTML = ""; (x.pairs || []).slice(0, 30).forEach(function (p) { var actions = el("div", "lab-row"); actions.appendChild(button("合并", function () { return App.api.post("/dedup/" + p.id + "/merge", {}).then(function () { actions.parentNode.remove(); }); })); actions.appendChild(button("忽略", function () { return App.api.post("/dedup/" + p.id + "/ignore", {}).then(function () { actions.parentNode.remove(); }); }, true)); card(out, (p.aName || p.a) + " / " + (p.bName || p.b), "相似度 " + p.similarity + "%", actions); }); }); }));
  });

  override("health", function (area) {
    var out = list(area), info = status(area, "计算新鲜度、关联度与完整度…"); wsid().then(function (id) { return App.api.get("/workspaces/" + id + "/health"); }).then(function (x) { out.innerHTML = ""; (x.items || []).slice(0, 60).forEach(function (v) { card(out, v.id, "综合 " + v.score + " · 新鲜 " + v.fresh + " · 关联 " + v.link + " · 完整 " + v.complete); }); info.textContent = "已计算 " + x.items.length + " 个文件"; });
  });

  override("presence", function (area) {
    var out = list(area), info = status(area, "申请一次性 WebSocket 票据…"); wsid().then(function (id) { return App.api.post("/ws/ticket", { workspaceId: id }).then(function (x) { var base = App.api.base.replace(/^http/, "ws"); var socket = new WebSocket(base + "/ws/workspaces/" + id + "?ticket=" + encodeURIComponent(x.ticket)); socket.onopen = function () { info.textContent = "实时协同已连接"; socket.send(JSON.stringify({ event: "cursor.move", payload: { x: 160, y: 120 } })); }; socket.onmessage = function (e) { var m = JSON.parse(e.data); card(out, m.event, JSON.stringify(m.payload || {})); }; socket.onerror = function () { info.textContent = "实时连接失败"; }; area._socket = socket; }); });
  });

  override("sticky", function (area) {
    var r = row(area), txt = el("input", "lab-input"); txt.placeholder = "输入批注（支持 @提及）"; txt.style.width = "360px"; r.appendChild(txt); var out = list(area);
    function load() { return wsid().then(function (id) { return App.api.get("/workspaces/" + id + "/comments"); }).then(function (x) { out.innerHTML = ""; (x.items || []).slice(0, 50).forEach(function (c) { card(out, c.text, new Date(c.updatedAt).toLocaleString(), button("删除", function () { return App.api.del("/comments/" + c.id).then(load); }, true)); }); }); }
    files().then(function (fs) { var s = selector(fs); r.insertBefore(s, txt); r.appendChild(button("添加批注", function () { return App.api.post("/files/" + s.value + "/comments", { text: txt.value || "@团队 请复核这项决策" }).then(load); })); }); load();
  });

  override("share", function (area) {
    var r = row(area), out = list(area); files().then(function (fs) { var s = selector(fs), perm = el("select", "lab-input"); ["read", "edit"].forEach(function (v) { var o = el("option", "", v === "read" ? "只读" : "可编辑"); o.value = v; perm.appendChild(o); }); r.appendChild(s); r.appendChild(perm); r.appendChild(button("生成分享链接", function () { return App.api.post("/files/" + s.value + "/share", { permission: perm.value }).then(function (x) { out.innerHTML = ""; var url = location.origin + "/#/share/" + x.token; card(out, url, "权限 " + perm.value, button("撤销", function () { return App.api.del("/shares/" + x.id).then(function () { empty(out, "分享已撤销"); }); }, true)); }); })); });
  });

  override("backlinks", function (area) {
    var r = row(area), out = list(area); files().then(function (fs) { var s = selector(fs); r.appendChild(s); function load() { return App.api.get("/files/" + s.value + "/backlinks").then(function (x) { out.innerHTML = ""; (x.items || []).forEach(function (f) { card(out, f.name, f.type, button("打开", function () { App.router.go("#/detail/" + f.id); return Promise.resolve(); }, true)); }); if (!x.total) empty(out, "暂无反向链接"); }); } s.addEventListener("change", load); r.appendChild(button("刷新反向链接", load)); load(); });
  });

  override("graph", function (area) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 900 520"); svg.style.cssText = "width:100%;height:520px;background:var(--workspace-bg);border:1px solid var(--border);border-radius:8px"; area.appendChild(svg);
    wsid().then(function (id) { return App.api.get("/workspaces/" + id + "/graph"); }).then(function (x) { var nodes = (x.nodes || []).slice(0, 80), known = {}; nodes.forEach(function (n, i) { known[n.id] = { x: 70 + (i % 10) * 84, y: 55 + Math.floor(i / 10) * 62, n: n }; }); (x.edges || []).forEach(function (e) { if (!known[e.source] || !known[e.target]) return; var l = document.createElementNS(svg.namespaceURI, "line"); l.setAttribute("x1", known[e.source].x); l.setAttribute("y1", known[e.source].y); l.setAttribute("x2", known[e.target].x); l.setAttribute("y2", known[e.target].y); l.setAttribute("stroke", "#94a3b8"); svg.appendChild(l); }); Object.keys(known).forEach(function (id) { var p = known[id], g = document.createElementNS(svg.namespaceURI, "g"), c = document.createElementNS(svg.namespaceURI, "circle"), t = document.createElementNS(svg.namespaceURI, "text"); c.setAttribute("cx", p.x); c.setAttribute("cy", p.y); c.setAttribute("r", 9); c.setAttribute("fill", "#0066cc"); t.setAttribute("x", p.x + 12); t.setAttribute("y", p.y + 4); t.setAttribute("font-size", 9); t.textContent = p.n.name.slice(0, 10); g.appendChild(c); g.appendChild(t); g.style.cursor = "pointer"; g.onclick = function () { App.router.go("#/detail/" + id); }; svg.appendChild(g); }); });
  });

  override("smart-fav", function (area) {
    var out = list(area); function load() { return wsid().then(function (id) { return App.api.get("/workspaces/" + id + "/favorites"); }).then(function (x) { out.innerHTML = ""; (x.items || []).forEach(function (f) { card(out, f.name, "收藏 · " + f.type, button("取消收藏", function () { return App.api.patch("/files/" + f.id, { favorite: false }).then(load); }, true)); }); }); } load();
  });

  override("fulltext", function (area) {
    var r = row(area), q = el("input", "lab-input"); q.placeholder = "搜索正文、摘要或文件名"; q.style.width = "420px"; r.appendChild(q); var out = list(area);
    r.appendChild(button("全文搜索", function () { return wsid().then(function (id) { return App.api.get("/workspaces/" + id + "/search?q=" + encodeURIComponent(q.value || "风险")); }).then(function (x) { out.innerHTML = ""; (x.items || []).forEach(function (f) { var n = card(out, f.name, ""); var s = el("div", "lab-hint"); s.innerHTML = f.snippet || f.summary; n.appendChild(s); n.onclick = function () { App.router.go("#/detail/" + f.id); }; }); }); }));
  });

  override("pwa", function (area) {
    var info = status(area, navigator.onLine ? "当前在线，Service Worker 可用" : "当前离线，读取本地快照"); var out = list(area), r = row(area);
    r.appendChild(button("保存离线快照", function () { return wsid().then(function (id) { return App.api.get("/sync/snapshot?workspaceId=" + id); }).then(function (x) { localStorage.setItem("fh_offline_snapshot", JSON.stringify(x)); info.textContent = "已缓存 " + x.files.length + " 个文件，时间 " + x.serverTime; }); }));
    r.appendChild(button("同步待办改动", function () { var changes = JSON.parse(localStorage.getItem("fh_pending_changes") || "[]"); return wsid().then(function (id) { return App.api.post("/sync/changes", { workspaceId: id, changes: changes }); }).then(function (x) { localStorage.removeItem("fh_pending_changes"); empty(out, "已应用 " + x.applied + " 项，冲突 " + x.conflicts.length + " 项"); }); }, true));
    navigator.serviceWorker && navigator.serviceWorker.getRegistration().then(function (reg) { card(out, "Service Worker", reg ? "已注册并控制离线资源" : "注册中"); });
  });
})();
