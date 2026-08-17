/* ===================================================================
   FileHub · 视图一 工作区
   渲染画布 + 关联连线 + 右侧预览面板，挂载全部交互：
   拖拽 / 连线 / 删连线 / 选中联动 / 侧栏筛选 / 搜索过滤 / 上传加节点
   + 必备功能：撤销 / 重做（E3）、删除节点进回收站（E8）
   =================================================================== */
window.App = window.App || {};
App.views = App.views || {};

App.views.workspace = function (container) {
  var D = App.data;
  var NODE_W = D.NODE_W, NODE_H = D.NODE_H;

  container.innerHTML =
    '<div class="canvas" id="canvas" tabindex="0">' +
      '<div class="canvas-stage" id="canvasStage">' +
        '<div class="ws-title">' + (App.workspaceName || "我的工作区") + '</div>' +
        '<div class="ws-hint">拖拽自由排布 · 连线建立关联 · 点击查看 AI 总结</div>' +
        '<svg class="links-svg" id="linksSvg" viewBox="0 0 840 844" preserveAspectRatio="none"></svg>' +
      '</div>' +
    '</div>' +
    '<aside class="preview">' +
      '<div class="pv-icon" id="pvIcon">PDF</div>' +
      '<div class="pv-name" id="pvName">—</div>' +
      '<div class="pv-meta" id="pvMeta">—</div>' +
      '<div class="pv-divider"></div>' +
      '<div class="pv-section-row">' +
        '<div class="pv-section-label">AI 智能总结</div>' +
        '<div class="pv-todo-pill">AI</div>' +
      '</div>' +
      '<div class="pv-summary" id="pvSummary"></div>' +
      '<div class="pv-todo-note" id="pvTodoNote"></div>' +
      '<div class="pv-tags" id="pvTags"></div>' +
      '<div class="pv-open" id="pvOpen">打开编辑 →</div>' +
    '</aside>';

  var canvas = container.querySelector("#canvas");
  var stage = container.querySelector("#canvasStage");
  var svg = container.querySelector("#linksSvg");
  var stageHeight = Math.max(844, 132 + Math.ceil(D.files.length / 5) * 112);
  stage.style.height = stageHeight + "px";
  svg.setAttribute("viewBox", "0 0 840 " + stageHeight);
  var nodeEls = {};
  var byId = D.byId;
  var removedNodes = {};   // 被删节点缓存（撤销时复原）

  // 画布变更防抖持久化（真实接入后端 PUT /canvas）
  var persistTimer = null;
  function schedulePersist() {
    if (!App.persistCanvas) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () { App.persistCanvas(); }, 800);
  }

  function center(n) { return { x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 }; }

  // ---- 构建单个节点 ----
  function buildNode(n) {
    var el = document.createElement("div");
    el.className = "node";
    el.style.left = n.x + "px";
    el.style.top = n.y + "px";
    el.dataset.id = n.id;
    el.innerHTML =
      '<div class="badge">' + n.type + '</div>' +
      '<div class="name" title="' + n.name + '">' + n.name + '</div>' +
      '<div class="meta">' + (n.meta || n.typeLabel || n.type) + '</div>' +
      '<div class="handle" title="拖出以建立关联"></div>';
    stage.appendChild(el);
    nodeEls[n.id] = el;
    attachNodeEvents(n, el);
  }
  D.files.forEach(buildNode);

  // ---- 连线绘制 ----
  function linkPath(a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var c1x = a.x + dx * 0.5, c1y = a.y;
    var c2x = b.x - dx * 0.5, c2y = b.y;
    return "M " + a.x + " " + a.y + " C " + c1x + " " + c1y + " " + c2x + " " + c2y + " " + b.x + " " + b.y;
  }
  function drawLinks() {
    svg.innerHTML = "";
    D.connections.forEach(function (pair, idx) {
      var a = byId[pair[0]], b = byId[pair[1]];
      if (!a || !b) return;
      if (isDim(a.id) || isDim(b.id)) return;
      var ca = center(a), cb = center(b);
      var pa = linkPath(ca, cb);
      var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      var hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hit.setAttribute("class", "link-hit");
      hit.setAttribute("d", pa);
      hit.addEventListener("click", function () {
        D.connections.splice(idx, 1);
        drawLinks(); pushHistory(); schedulePersist();
        App.toast("已删除一条关联连线");
      });
      var line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute("class", "link-line"); line.setAttribute("d", pa);
      var e1 = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      e1.setAttribute("class", "link-end"); e1.setAttribute("cx", ca.x); e1.setAttribute("cy", ca.y); e1.setAttribute("r", 4);
      var e2 = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      e2.setAttribute("class", "link-end"); e2.setAttribute("cx", cb.x); e2.setAttribute("cy", cb.y); e2.setAttribute("r", 4);
      g.appendChild(hit); g.appendChild(line); g.appendChild(e1); g.appendChild(e2);
      svg.appendChild(g);
    });
  }

  // ---- 交互状态 ----
  var drag = null, linking = null, tempPath = null;

  function attachNodeEvents(n, el) {
    var handle = el.querySelector(".handle");
    el.addEventListener("pointerdown", function (e) {
      if (e.target === handle) return;
      e.preventDefault();
      drag = { id: n.id, el: el, startX: e.clientX, startY: e.clientY, origX: n.x, origY: n.y, moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", function (e) {
      if (!drag || drag.id !== n.id) return;
      var dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      n.x = Math.max(0, Math.min(840 - NODE_W, drag.origX + dx));
      n.y = Math.max(0, Math.min(844 - NODE_H, drag.origY + dy));
      el.style.left = n.x + "px"; el.style.top = n.y + "px";
      drawLinks();
    });
    el.addEventListener("pointerup", function (e) {
      if (!drag || drag.id !== n.id) return;
      el.releasePointerCapture(e.pointerId);
      if (!drag.moved) selectNode(n.id);
      else { pushHistory(); schedulePersist(); }
      drag = null;
    });

    handle.addEventListener("pointerdown", function (e) {
      e.preventDefault(); e.stopPropagation();
      linking = { from: n.id, start: center(n) };
      tempPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      tempPath.setAttribute("class", "link-temp");
      svg.appendChild(tempPath);
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", function (e) {
      if (!linking) return;
      var rect = stage.getBoundingClientRect();
      var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      tempPath.setAttribute("d", "M " + linking.start.x + " " + linking.start.y + " L " + cx + " " + cy);
    });
    handle.addEventListener("pointerup", function (e) {
      if (!linking) return;
      var target = document.elementFromPoint(e.clientX, e.clientY);
      var targetNode = target && target.closest ? target.closest(".node") : null;
      if (targetNode && targetNode.dataset.id !== linking.from) {
        var tid = targetNode.dataset.id;
        var exists = D.connections.some(function (p) {
          return (p[0] === linking.from && p[1] === tid) || (p[0] === tid && p[1] === linking.from);
        });
        if (!exists) { D.connections.push([linking.from, tid]); drawLinks(); pushHistory(); schedulePersist(); App.toast("已建立关联连线"); }
        else App.toast("该关联已存在");
      }
      if (tempPath && tempPath.parentNode) tempPath.parentNode.removeChild(tempPath);
      tempPath = null; linking = null;
    });
  }

  // ---- 预览面板 ----
  var pvIcon = container.querySelector("#pvIcon");
  var pvName = container.querySelector("#pvName");
  var pvMeta = container.querySelector("#pvMeta");
  var pvSummary = container.querySelector("#pvSummary");
  var pvTodoNote = container.querySelector("#pvTodoNote");
  var pvTags = container.querySelector("#pvTags");
  var pvOpen = container.querySelector("#pvOpen");

  function selectNode(id) {
    if (!id || !byId[id]) id = D.files.length ? D.files[0].id : null;
    App.state.selectedId = id;
    D.files.forEach(function (n) {
      if (nodeEls[n.id]) nodeEls[n.id].classList.toggle("selected", n.id === id);
    });
    if (!id) {
      pvIcon.textContent = "—"; pvName.textContent = "—"; pvMeta.textContent = "—";
      pvSummary.textContent = ""; pvTodoNote.textContent = ""; pvTags.innerHTML = "";
      return;
    }
    var n = byId[id];
    pvIcon.textContent = n.type; pvName.textContent = n.name; pvMeta.textContent = n.meta;
    pvSummary.textContent = n.summary;
    pvTodoNote.textContent = "正在请求 LangChain 摘要…";
    if (App.ai && n.content) {
      App.ai.summarize(n.content).then(function (result) {
        if (App.state.selectedId === id) { pvSummary.textContent = result.summary; pvTodoNote.textContent = result.mode === "langchain" ? "LangChain 已生成摘要" : "本地降级摘要已生成"; }
      }).catch(function () { if (App.state.selectedId === id) pvTodoNote.textContent = "本地摘要（AI 服务不可用）"; });
    } else pvTodoNote.textContent = n.summary ? "数据库摘要已加载" : "暂无正文，上传或编辑后可生成摘要";
    pvTags.innerHTML = "";
    (n.tags || []).forEach(function (tg) {
      var s = document.createElement("span");
      s.className = "pv-tag " + tg.c; s.textContent = tg.t; s.title = "按标签筛选";
      s.addEventListener("click", function () { App.state.filter = { kind: "tag", value: tg.t }; App.router.go("#/"); });
      pvTags.appendChild(s);
    });
  }
  pvOpen.addEventListener("click", function () {
    var id = App.state.selectedId || (D.files[0] && D.files[0].id);
    if (id) App.router.go("#/detail/" + id);
  });

  // ---- 筛选可见性 ----
  var searchQuery = "";
  function matchFilter(n) {
    var f = App.state.filter;
    if (!f || f.kind === "all") return true;
    if (f.kind === "recent") {
      var stamp = Date.parse(n.updated_at || n.updated || "");
      return !isNaN(stamp) ? (Date.now() - stamp < 7 * 24 * 60 * 60 * 1000) : true;
    }
    if (f.kind === "fav") return !!n.favorite;
    if (f.kind === "type") return n.type === f.value;
    if (f.kind === "typeGroup") {
      var groups = {
        document: ["PDF", "DOC", "DOCX", "MD", "TXT", "RTF", "XLS", "XLSX", "PPT", "PPTX"],
        image: ["PNG", "JPG", "JPEG", "GIF", "WEBP", "SVG"],
        code: ["JSON", "CSV", "JS", "TS", "TSX", "JSX", "PY", "JAVA", "GO", "RS", "C", "CPP", "CSS", "HTML", "XML", "YAML", "YML", "SQL"],
        folder: ["DIR", "FOLDER"]
      };
      return (groups[f.value] || []).indexOf(String(n.type).toUpperCase()) >= 0;
    }
    if (f.kind === "tag") return (n.tags || []).some(function (t) { return t.t === f.value; });
    return true;
  }
  function matchSearch(n) {
    if (!searchQuery) return true;
    var q = searchQuery.toLowerCase();
    return n.name.toLowerCase().indexOf(q) >= 0 ||
           n.type.toLowerCase().indexOf(q) >= 0 ||
           (n.tags || []).some(function (t) { return t.t.toLowerCase().indexOf(q) >= 0; });
  }
  function isDim(id) { var n = byId[id]; return !(matchFilter(n) && matchSearch(n)); }
  function applyVisibility() {
    D.files.forEach(function (n) {
      if (nodeEls[n.id]) {
        var hidden = isDim(n.id);
        nodeEls[n.id].classList.toggle("dim", hidden);
        nodeEls[n.id].classList.toggle("filtered-out", hidden);
      }
    });
    drawLinks();
  }
  App.workspaceApplySearch = function (q) { searchQuery = q; applyVisibility(); };
  App.workspaceApplyFilter = function () { applyVisibility(); };

  // ---- 撤销 / 重做（E3） ----
  var history = [], hi = -1;
  function snapshot() {
    var pos = {}; D.files.forEach(function (n) { pos[n.id] = { x: n.x, y: n.y }; });
    return { pos: pos, conns: D.connections.map(function (p) { return [p[0], p[1]]; }), ids: D.files.map(function (n) { return n.id; }) };
  }
  function restore(snap) {
    D.files.slice().forEach(function (n) { if (snap.ids.indexOf(n.id) < 0) removeNodeData(n.id); });
    snap.ids.forEach(function (id) {
      if (!byId[id] && removedNodes[id]) { var n = removedNodes[id]; D.files.push(n); D.byId[id] = n; buildNode(n); }
    });
    D.files.forEach(function (n) {
      if (snap.pos[n.id]) { n.x = snap.pos[n.id].x; n.y = snap.pos[n.id].y; if (nodeEls[n.id]) { nodeEls[n.id].style.left = n.x + "px"; nodeEls[n.id].style.top = n.y + "px"; } }
    });
    D.connections = snap.conns.map(function (p) { return [p[0], p[1]]; });
    applyVisibility(); drawLinks();
  }
  function pushHistory() { history = history.slice(0, hi + 1); history.push(snapshot()); hi = history.length - 1; }
  function undo() { if (hi > 0) { hi--; restore(history[hi]); App.toast("已撤销"); } else App.toast("没有可撤销的操作"); }
  function redo() { if (hi < history.length - 1) { hi++; restore(history[hi]); App.toast("已重做"); } else App.toast("没有可重做的操作"); }
  App.workspaceUndo = undo; App.workspaceRedo = redo;

  // ---- 删除节点进回收站（E8） ----
  function removeNodeData(id) {
    var n = byId[id]; if (!n) return;
    D.connections = D.connections.filter(function (p) { return p[0] !== id && p[1] !== id; });
    var idx = D.files.indexOf(n); if (idx >= 0) D.files.splice(idx, 1);
    delete D.byId[id];
    removedNodes[id] = n; App.trash.push(n);
    if (nodeEls[id] && nodeEls[id].parentNode) nodeEls[id].parentNode.removeChild(nodeEls[id]);
    delete nodeEls[id];
  }
  function deleteSelected() {
    var id = App.state.selectedId; if (!id || !byId[id]) return;
    var name = byId[id].name;
    removeNodeData(id);
    App.state.selectedId = null;
    selectNode(D.files.length ? D.files[0].id : null);
    drawLinks(); pushHistory(); schedulePersist();
    // 真实回收站：后端文件软删除
    if (App.api && App.remoteWorkspaceId && id.indexOf("file_") === 0) {
      App.api.del("/files/" + id).catch(function () {});
    }
    App.toast("已移至回收站：" + name);
  }
  function onKey(e) {
    if (e.key === "Delete" || e.key === "Backspace") {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
      if (!document.contains(canvas)) return;
      if (App.state.selectedId) { deleteSelected(); e.preventDefault(); }
    }
  }
  document.addEventListener("keydown", onKey);

  // ---- 初始化 ----
  selectNode(App.state.selectedId && byId[App.state.selectedId] ? App.state.selectedId : (D.files[0] && D.files[0].id));
  applyVisibility();
  drawLinks();
  pushHistory();

  return function cleanup() {
    App.workspaceApplySearch = null;
    App.workspaceApplyFilter = null;
    document.removeEventListener("keydown", onKey);
    App.workspaceUndo = null; App.workspaceRedo = null;
    delete App.workspaceUndo; delete App.workspaceRedo;
  };
};
