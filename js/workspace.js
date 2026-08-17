/* FileHub workspace: overview + full library + curated visual canvas. */
window.App = window.App || {};
App.views = App.views || {};

App.views.workspace = function (container) {
  "use strict";
  var D = App.data;
  var selected = new Set();
  var searchQuery = App.state.workspaceSearch || "";
  var sortBy = App.state.librarySort || "updated";
  var mode = App.state.workspaceMode || "overview";
  var canvasScale = 1;
  var nodeEls = {};
  var persistTimer = null;
  var history = [], historyIndex = -1;
  var drag = null, linking = null, tempPath = null;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fileTags(file) { return (file.tags || []).map(function (t) { return t.t || t.name || t; }).filter(Boolean); }
  function formatDate(file) {
    var raw = file.updatedAt || file.updated_at || file.updated || "";
    var date = new Date(raw); return isNaN(date.getTime()) ? (raw || "—") : date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  }
  function formatSize(file) {
    if (typeof file.size === "string") return file.size;
    var bytes = Number(file.size || 0);
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
    return bytes ? bytes + " B" : "—";
  }
  function fileGroup(type) {
    type = String(type || "").toUpperCase();
    if (["PDF", "DOC", "DOCX", "MD", "TXT", "RTF", "XLS", "XLSX", "PPT", "PPTX"].indexOf(type) >= 0) return "document";
    if (["PNG", "JPG", "JPEG", "GIF", "WEBP", "SVG"].indexOf(type) >= 0) return "image";
    if (["DIR", "FOLDER"].indexOf(type) >= 0) return "folder";
    return "code";
  }
  function matchFilter(file) {
    var filter = App.state.filter || { kind: "all" };
    if (filter.kind === "all") return true;
    if (filter.kind === "recent") {
      var stamp = Date.parse(file.updatedAt || file.updated_at || file.updated || "");
      return !isNaN(stamp) && Date.now() - stamp < 7 * 86400000;
    }
    if (filter.kind === "fav") return !!file.favorite;
    if (filter.kind === "type") return String(file.type).toUpperCase() === String(filter.value).toUpperCase();
    if (filter.kind === "typeGroup") return fileGroup(file.type) === filter.value;
    if (filter.kind === "tag") return fileTags(file).indexOf(filter.value) >= 0;
    return true;
  }
  function matchSearch(file) {
    if (!searchQuery) return true;
    var q = searchQuery.toLowerCase();
    return [file.name, file.type, file.summary].concat(fileTags(file)).some(function (value) { return String(value || "").toLowerCase().indexOf(q) >= 0; });
  }
  function filteredFiles() {
    var result = D.files.filter(function (file) { return matchFilter(file) && matchSearch(file); });
    result.sort(function (a, b) {
      if (sortBy === "name") return String(a.name).localeCompare(String(b.name), "zh-CN");
      if (sortBy === "type") return String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name), "zh-CN");
      return Date.parse(b.updatedAt || b.updated_at || b.updated || 0) - Date.parse(a.updatedAt || a.updated_at || a.updated || 0);
    });
    return result;
  }
  function canvasIds() {
    if (!Array.isArray(App.canvasNodeIds)) App.canvasNodeIds = [];
    return App.canvasNodeIds.filter(function (id) { return !!D.byId[id]; });
  }
  function isOnCanvas(id) { return canvasIds().indexOf(id) >= 0; }
  function schedulePersist() {
    if (!App.persistCanvas) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () { App.persistCanvas(); }, 650);
  }

  container.innerHTML =
    '<div class="workspace-shell">' +
      '<header class="workspace-header">' +
        '<div class="workspace-heading"><span>当前工作区</span><h1>' + esc(App.workspaceName || "我的工作区") + '</h1><p id="workspaceContext">整理、检索并连接你的项目资料</p></div>' +
        '<div class="workspace-modes" role="tablist" aria-label="工作区视图">' +
          '<button data-mode="overview" role="tab">概览</button><button data-mode="library" role="tab">资料库</button><button data-mode="canvas" role="tab">画布</button>' +
        '</div>' +
      '</header>' +
      '<div class="workspace-main"><section class="workspace-content" id="workspaceContent"></section><aside class="workspace-inspector" id="workspaceInspector"></aside></div>' +
    '</div>';

  var content = container.querySelector("#workspaceContent");
  var inspector = container.querySelector("#workspaceInspector");
  var contextText = container.querySelector("#workspaceContext");

  container.querySelector(".workspace-modes").addEventListener("click", function (event) {
    var button = event.target.closest("[data-mode]"); if (button) setMode(button.dataset.mode);
  });

  function setMode(next) {
    mode = next; App.state.workspaceMode = next;
    render();
  }
  App.workspaceSetMode = setMode;

  function syncModeButtons() {
    container.querySelectorAll("[data-mode]").forEach(function (button) {
      var active = button.dataset.mode === mode;
      button.classList.toggle("active", active); button.setAttribute("aria-selected", active ? "true" : "false");
    });
    contextText.textContent = mode === "overview" ? "回到最近进展与重要资料" : mode === "library" ? "检索、筛选和管理全部资料" : "组织精选资料并建立空间关系";
  }

  function render() {
    syncModeButtons();
    content.classList.toggle("no-inspector", mode === "overview");
    nodeEls = {};
    if (mode === "overview") renderOverview();
    else if (mode === "library") renderLibrary();
    else renderCanvas();
  }

  function renderOverview() {
    inspector.classList.add("hidden");
    var recent = D.files.slice().sort(function (a, b) { return Date.parse(b.updatedAt || b.updated_at || b.updated || 0) - Date.parse(a.updatedAt || a.updated_at || a.updated || 0); }).slice(0, 7);
    var favorites = D.files.filter(function (f) { return f.favorite; }).slice(0, 6);
    var tagSet = {}; D.files.forEach(function (f) { fileTags(f).forEach(function (t) { tagSet[t] = true; }); });
    var linked = {}; (D.connections || []).forEach(function (pair) { linked[pair[0]] = true; linked[pair[1]] = true; });
    var connectedRate = D.files.length ? Math.round(Object.keys(linked).length / D.files.length * 100) : 0;
    content.innerHTML =
      '<div class="overview-wrap">' +
        '<div class="overview-metrics"><div><span>全部资料</span><strong>' + D.files.length + '</strong></div><div><span>画布资料</span><strong>' + canvasIds().length + '</strong></div><div><span>标签体系</span><strong>' + Object.keys(tagSet).length + '</strong></div><div><span>关系覆盖</span><strong>' + connectedRate + '%</strong></div></div>' +
        '<div class="overview-actions"><button class="btn primary" data-overview-action="library">浏览资料库</button><button class="btn ghost" data-overview-action="canvas">打开画布</button></div>' +
        '<div class="overview-columns">' +
          '<section class="overview-section"><div class="section-head"><div><span>最近更新</span><small>继续上次的工作</small></div><button data-overview-action="library">查看全部</button></div><div class="recent-list">' + recent.map(resourceRow).join("") + '</div></section>' +
          '<section class="overview-section"><div class="section-head"><div><span>重要资料</span><small>收藏与当前画布</small></div></div><div class="favorite-list">' + (favorites.length ? favorites.map(favoriteRow).join("") : '<div class="quiet-empty">暂无收藏资料</div>') + '</div><div class="overview-note"><b>工作区建议</b><p>全量文件留在资料库中；只把当前项目需要对照、讨论或建立关系的资料加入画布。</p></div></section>' +
        '</div>' +
      '</div>';
    content.querySelectorAll("[data-overview-action]").forEach(function (button) { button.addEventListener("click", function () { setMode(button.dataset.overviewAction); }); });
    content.querySelectorAll("[data-file-id]").forEach(function (row) { row.addEventListener("click", function () { App.router.go("#/detail/" + row.dataset.fileId); }); });
  }
  function resourceRow(file) {
    return '<button class="resource-row" data-file-id="' + esc(file.id) + '"><span class="file-type-icon">' + esc(file.type) + '</span><span><b>' + esc(file.name) + '</b><small>' + esc(fileTags(file).slice(0, 2).join(" · ") || "未分类") + '</small></span><time>' + esc(formatDate(file)) + '</time></button>';
  }
  function favoriteRow(file) {
    return '<button class="favorite-row" data-file-id="' + esc(file.id) + '"><span>★</span><b>' + esc(file.name) + '</b><small>' + esc(file.type) + '</small></button>';
  }

  function renderLibrary() {
    inspector.classList.remove("hidden");
    var files = filteredFiles();
    content.innerHTML =
      '<div class="library-view">' +
        '<div class="library-toolbar"><div><strong>' + files.length + '</strong><span>项资料</span></div><div class="library-tools"><select id="librarySort" aria-label="资料排序"><option value="updated">最近更新</option><option value="name">名称</option><option value="type">类型</option></select><button id="libraryCanvas" title="打开画布">画布 · ' + canvasIds().length + '</button></div></div>' +
        '<div class="batch-bar' + (selected.size ? " show" : "") + '" id="batchBar"><span>已选择 <b>' + selected.size + '</b> 项</span><button data-batch="canvas">加入画布</button><button data-batch="favorite">收藏</button><button data-batch="clear">取消选择</button></div>' +
        '<div class="library-table"><div class="library-head"><label><input type="checkbox" id="selectAll" /></label><span>名称</span><span>标签</span><span>更新</span><span>大小</span><span></span></div>' +
          '<div class="library-rows">' + (files.length ? files.map(libraryRow).join("") : '<div class="library-empty"><strong>没有匹配的资料</strong><span>调整筛选条件或搜索关键词</span></div>') + '</div></div>' +
      '</div>';
    var sort = content.querySelector("#librarySort"); sort.value = sortBy;
    sort.addEventListener("change", function () { sortBy = sort.value; App.state.librarySort = sortBy; renderLibrary(); });
    content.querySelector("#libraryCanvas").addEventListener("click", function () { setMode("canvas"); });
    var all = content.querySelector("#selectAll");
    all.checked = files.length > 0 && files.every(function (f) { return selected.has(f.id); });
    all.addEventListener("change", function () { files.forEach(function (f) { if (all.checked) selected.add(f.id); else selected.delete(f.id); }); renderLibrary(); });
    content.querySelectorAll(".library-row").forEach(function (row) {
      var id = row.dataset.id;
      row.addEventListener("click", function (event) {
        if (event.target.closest("button,label,input")) return;
        selectFile(id);
      });
      row.querySelector("input").addEventListener("change", function (event) { if (event.target.checked) selected.add(id); else selected.delete(id); renderLibrary(); });
      row.querySelector("[data-row-action]").addEventListener("click", function () { toggleCanvas(id); renderLibrary(); });
    });
    content.querySelectorAll("[data-batch]").forEach(function (button) {
      button.addEventListener("click", function () {
        var action = button.dataset.batch;
        if (action === "canvas") { selected.forEach(addToCanvas); App.toast("已将所选资料加入画布"); }
        else if (action === "favorite") { selected.forEach(function (id) { updateFavorite(id, true); }); App.toast("已收藏所选资料"); }
        selected.clear(); renderLibrary();
      });
    });
    var selectedId = App.state.selectedId && D.byId[App.state.selectedId] ? App.state.selectedId : (files[0] && files[0].id);
    if (selectedId) selectFile(selectedId, true); else renderInspector(null);
  }
  function libraryRow(file) {
    var tags = fileTags(file).slice(0, 2);
    return '<div class="library-row' + (App.state.selectedId === file.id ? " active" : "") + '" data-id="' + esc(file.id) + '">' +
      '<label><input type="checkbox" ' + (selected.has(file.id) ? "checked" : "") + ' aria-label="选择 ' + esc(file.name) + '" /></label>' +
      '<div class="library-name"><span class="file-type-icon">' + esc(file.type) + '</span><span><b title="' + esc(file.name) + '">' + esc(file.name) + '</b><small>' + esc(file.type) + '</small></span></div>' +
      '<div class="library-tags">' + (tags.length ? tags.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join("") : '<small>未分类</small>') + '</div>' +
      '<time>' + esc(formatDate(file)) + '</time><span class="library-size">' + esc(formatSize(file)) + '</span>' +
      '<button class="row-action' + (isOnCanvas(file.id) ? " active" : "") + '" data-row-action title="' + (isOnCanvas(file.id) ? "从画布移除" : "加入画布") + '">' + (isOnCanvas(file.id) ? "−" : "+") + '</button></div>';
  }

  function selectFile(id, quiet) {
    if (!D.byId[id]) return;
    App.state.selectedId = id;
    if (!quiet) content.querySelectorAll(".library-row").forEach(function (row) { row.classList.toggle("active", row.dataset.id === id); });
    renderInspector(D.byId[id]);
  }
  function renderInspector(file) {
    if (!file) { inspector.innerHTML = '<div class="inspector-empty"><span>选择一项资料</span><small>查看摘要、标签和可用操作</small></div>'; return; }
    inspector.innerHTML =
      '<div class="inspector-file"><span class="inspector-icon">' + esc(file.type) + '</span><div><h2>' + esc(file.name) + '</h2><p>' + esc(file.type + " · " + formatSize(file)) + '</p></div></div>' +
      '<div class="inspector-actions"><button id="inspectorOpen" class="primary">打开详情</button><button id="inspectorCanvas">' + (isOnCanvas(file.id) ? "从画布移除" : "加入画布") + '</button></div>' +
      '<section><div class="inspector-label"><span>AI 摘要</span><b>AI</b></div><p class="inspector-summary" id="inspectorSummary">' + esc(file.summary || "暂无摘要") + '</p><small id="inspectorAiState">' + (file.summary ? "数据库摘要已加载" : "等待生成摘要") + '</small></section>' +
      '<section><div class="inspector-label"><span>标签</span></div><div class="inspector-tags">' + (fileTags(file).length ? fileTags(file).map(function (t) { return '<button data-inspector-tag="' + esc(t) + '">' + esc(t) + '</button>'; }).join("") : '<small>暂无标签</small>') + '</div></section>' +
      '<div class="inspector-secondary"><button id="inspectorFavorite">' + (file.favorite ? "取消收藏" : "收藏") + '</button><button id="inspectorTrash" class="danger">移入回收站</button></div>';
    inspector.querySelector("#inspectorOpen").addEventListener("click", function () { App.router.go("#/detail/" + file.id); });
    inspector.querySelector("#inspectorCanvas").addEventListener("click", function () { toggleCanvas(file.id); if (mode === "canvas" && !isOnCanvas(file.id)) renderCanvas(); else renderInspector(file); });
    inspector.querySelector("#inspectorFavorite").addEventListener("click", function () { updateFavorite(file.id, !file.favorite); renderInspector(file); });
    inspector.querySelector("#inspectorTrash").addEventListener("click", function () { trashFile(file.id); });
    inspector.querySelectorAll("[data-inspector-tag]").forEach(function (button) { button.addEventListener("click", function () { App.state.filter = { kind: "tag", value: button.dataset.inspectorTag }; setMode("library"); }); });
    if (App.ai && file.content) {
      App.ai.summarize(file.content).then(function (result) {
        if (App.state.selectedId !== file.id || !document.contains(inspector)) return;
        var summary = inspector.querySelector("#inspectorSummary"), status = inspector.querySelector("#inspectorAiState");
        if (summary) summary.textContent = result.summary; if (status) status.textContent = result.mode === "langchain" ? "LangChain 已生成摘要" : "本地降级摘要已生成";
      }).catch(function () {});
    }
  }

  function addToCanvas(id) {
    if (!D.byId[id] || isOnCanvas(id)) return;
    App.canvasNodeIds.push(id);
    var index = App.canvasNodeIds.length - 1;
    D.byId[id].x = 60 + (index % 4) * 230; D.byId[id].y = 80 + Math.floor(index / 4) * 150;
    schedulePersist();
  }
  function removeFromCanvas(id) {
    App.canvasNodeIds = canvasIds().filter(function (item) { return item !== id; });
    D.connections = (D.connections || []).filter(function (pair) { return pair[0] !== id && pair[1] !== id; });
    if (App.state.selectedId === id) App.state.selectedId = null;
    schedulePersist();
  }
  function toggleCanvas(id) { if (isOnCanvas(id)) { removeFromCanvas(id); App.toast("已从画布移除"); } else { addToCanvas(id); App.toast("已加入画布"); } }
  function updateFavorite(id, value) {
    var file = D.byId[id]; if (!file) return; file.favorite = value;
    if (App.api && id.indexOf("file_") === 0) App.api.patch("/files/" + id, { favorite: value }).catch(function () {});
  }
  function trashFile(id) {
    var file = D.byId[id]; if (!file) return;
    removeFromCanvas(id); D.connections = (D.connections || []).filter(function (p) { return p[0] !== id && p[1] !== id; });
    D.files = D.files.filter(function (f) { return f.id !== id; }); delete D.byId[id]; App.trash.push(file);
    if (App.api && id.indexOf("file_") === 0) App.api.del("/files/" + id).catch(function () {});
    App.toast("已移至回收站：" + file.name); App.state.selectedId = null; render();
  }

  function renderCanvas() {
    inspector.classList.remove("hidden");
    var ids = canvasIds();
    content.innerHTML =
      '<div class="canvas-workbench"><div class="canvas-toolbar"><div><strong>精选画布</strong><span>' + ids.length + ' 项资料 · ' + subsetConnections(ids).length + ' 条关系</span></div><div><button id="canvasLibrary">添加资料</button><button id="canvasArrange" title="整理布局">整理</button><span class="zoom-group"><button data-zoom="out" title="缩小">−</button><b id="zoomValue">100%</b><button data-zoom="in" title="放大">＋</button><button data-zoom="fit" title="适合窗口">适配</button></span></div></div>' +
      '<div class="visual-canvas-viewport" id="visualViewport"><div class="visual-stage-wrap" id="stageWrap"><div class="visual-stage" id="visualStage"><svg class="visual-links" id="visualLinks"></svg><div class="canvas-empty" id="canvasEmpty"><strong>画布还是空的</strong><span>从资料库挑选当前需要整理和关联的资料</span><button>前往资料库</button></div></div></div><div class="canvas-minimap" id="canvasMinimap" aria-label="画布小地图"></div></div></div>';
    var viewport = content.querySelector("#visualViewport");
    var wrap = content.querySelector("#stageWrap");
    var stage = content.querySelector("#visualStage");
    var svg = content.querySelector("#visualLinks");
    var empty = content.querySelector("#canvasEmpty");
    nodeEls = {};
    empty.classList.toggle("show", !ids.length);
    empty.querySelector("button").addEventListener("click", function () { setMode("library"); });
    content.querySelector("#canvasLibrary").addEventListener("click", function () { setMode("library"); });
    content.querySelector("#canvasArrange").addEventListener("click", function () { autoArrange(ids); renderCanvas(); schedulePersist(); App.toast("画布已整理"); });
    content.querySelectorAll("[data-zoom]").forEach(function (button) { button.addEventListener("click", function () { changeZoom(button.dataset.zoom, viewport, wrap, stage); }); });
    ids.forEach(function (id, index) { buildCanvasNode(D.byId[id], index, stage, svg, ids); });
    drawCanvasLinks(svg, ids);
    updateMinimap(ids);
    changeZoom("current", viewport, wrap, stage);
    var selectedId = App.state.selectedId && isOnCanvas(App.state.selectedId) ? App.state.selectedId : ids[0];
    if (selectedId) selectCanvasNode(selectedId); else renderInspector(null);
    pushHistory();
  }
  function subsetConnections(ids) { return (D.connections || []).filter(function (pair) { return ids.indexOf(pair[0]) >= 0 && ids.indexOf(pair[1]) >= 0; }); }
  function autoArrange(ids) {
    ids.forEach(function (id, index) { D.byId[id].x = 70 + (index % 4) * 250; D.byId[id].y = 80 + Math.floor(index / 4) * 160; });
  }
  function changeZoom(action, viewport, wrap, stage) {
    if (action === "in") canvasScale = Math.min(1.5, canvasScale + .1);
    else if (action === "out") canvasScale = Math.max(.5, canvasScale - .1);
    else if (action === "fit") canvasScale = Math.max(.5, Math.min(1, (viewport.clientWidth - 36) / 1200));
    stage.style.transform = "scale(" + canvasScale + ")"; wrap.style.width = 1200 * canvasScale + "px"; wrap.style.height = 820 * canvasScale + "px";
    var label = content.querySelector("#zoomValue"); if (label) label.textContent = Math.round(canvasScale * 100) + "%";
  }
  function buildCanvasNode(file, index, stage, svg, ids) {
    if (!Number.isFinite(file.x) || !Number.isFinite(file.y)) { file.x = 70 + (index % 4) * 250; file.y = 80 + Math.floor(index / 4) * 160; }
    file.x = Math.max(20, Math.min(1000, file.x)); file.y = Math.max(20, Math.min(680, file.y));
    var node = document.createElement("article"); node.className = "canvas-node"; node.dataset.id = file.id; node.style.left = file.x + "px"; node.style.top = file.y + "px";
    node.innerHTML = '<div class="canvas-node-top"><span>' + esc(file.type) + '</span><button class="canvas-node-remove" title="从画布移除">×</button></div><h3 title="' + esc(file.name) + '">' + esc(file.name) + '</h3><p>' + esc(formatSize(file)) + ' · ' + esc(formatDate(file)) + '</p><div class="canvas-node-tags">' + fileTags(file).slice(0, 2).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join("") + '</div><button class="canvas-handle" title="拖出以建立关联" aria-label="建立关联"></button>';
    stage.appendChild(node); nodeEls[file.id] = node;
    node.querySelector(".canvas-node-remove").addEventListener("click", function (event) { event.stopPropagation(); removeFromCanvas(file.id); renderCanvas(); });
    attachCanvasEvents(file, node, svg, ids);
  }
  function center(file) { return { x: file.x + 95, y: file.y + 57 }; }
  function pathBetween(a, b) { var dx = b.x - a.x; return "M " + a.x + " " + a.y + " C " + (a.x + dx * .45) + " " + a.y + " " + (b.x - dx * .45) + " " + b.y + " " + b.x + " " + b.y; }
  function drawCanvasLinks(svg, ids) {
    if (!svg) return; svg.innerHTML = "";
    subsetConnections(ids).forEach(function (pair) {
      var a = D.byId[pair[0]], b = D.byId[pair[1]]; if (!a || !b) return;
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", pathBetween(center(a), center(b))); path.setAttribute("class", "canvas-link");
      path.addEventListener("click", function () { D.connections = D.connections.filter(function (p) { return p !== pair; }); drawCanvasLinks(svg, ids); pushHistory(); schedulePersist(); App.toast("关联已删除"); }); svg.appendChild(path);
    });
  }
  function attachCanvasEvents(file, node, svg, ids) {
    var handle = node.querySelector(".canvas-handle");
    node.addEventListener("pointerdown", function (event) {
      if (event.target.closest("button")) return; event.preventDefault();
      drag = { id: file.id, startX: event.clientX, startY: event.clientY, x: file.x, y: file.y, moved: false }; node.setPointerCapture(event.pointerId);
    });
    node.addEventListener("pointermove", function (event) {
      if (!drag || drag.id !== file.id) return;
      var dx = (event.clientX - drag.startX) / canvasScale, dy = (event.clientY - drag.startY) / canvasScale; if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      file.x = Math.max(20, Math.min(990, drag.x + dx)); file.y = Math.max(20, Math.min(680, drag.y + dy)); node.style.left = file.x + "px"; node.style.top = file.y + "px"; drawCanvasLinks(svg, ids); updateMinimap(ids);
    });
    node.addEventListener("pointerup", function (event) {
      if (!drag || drag.id !== file.id) return; node.releasePointerCapture(event.pointerId); if (!drag.moved) selectCanvasNode(file.id); else { pushHistory(); schedulePersist(); } drag = null;
    });
    handle.addEventListener("pointerdown", function (event) {
      event.preventDefault(); event.stopPropagation(); linking = { from: file.id };
      tempPath = document.createElementNS("http://www.w3.org/2000/svg", "path"); tempPath.setAttribute("class", "canvas-link temp"); svg.appendChild(tempPath); handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", function (event) {
      if (!linking || !tempPath) return; var rect = node.closest(".visual-stage").getBoundingClientRect(); var point = { x: (event.clientX - rect.left) / canvasScale, y: (event.clientY - rect.top) / canvasScale }; tempPath.setAttribute("d", pathBetween(center(file), point));
    });
    handle.addEventListener("pointerup", function (event) {
      if (!linking) return; var target = document.elementFromPoint(event.clientX, event.clientY); var targetNode = target && target.closest(".canvas-node");
      if (targetNode && targetNode.dataset.id !== file.id) {
        var targetId = targetNode.dataset.id; var exists = (D.connections || []).some(function (p) { return (p[0] === file.id && p[1] === targetId) || (p[1] === file.id && p[0] === targetId); });
        if (!exists) { D.connections.push([file.id, targetId]); App.toast("已建立资料关联"); pushHistory(); schedulePersist(); }
      }
      if (tempPath && tempPath.parentNode) tempPath.parentNode.removeChild(tempPath); tempPath = null; linking = null; drawCanvasLinks(svg, ids);
    });
  }
  function selectCanvasNode(id) {
    App.state.selectedId = id; Object.keys(nodeEls).forEach(function (nodeId) { nodeEls[nodeId].classList.toggle("selected", nodeId === id); }); renderInspector(D.byId[id]);
  }
  function updateMinimap(ids) {
    var minimap = content.querySelector("#canvasMinimap"); if (!minimap) return;
    minimap.innerHTML = '<span class="minimap-label">小地图</span>' + ids.map(function (id) { var f = D.byId[id]; return '<i style="left:' + Math.round(f.x / 1200 * 100) + '%;top:' + Math.round(f.y / 820 * 100) + '%"></i>'; }).join("");
  }
  function canvasSnapshot() {
    var positions = {}; canvasIds().forEach(function (id) { var f = D.byId[id]; positions[id] = { x: f.x, y: f.y }; });
    return { ids: canvasIds().slice(), positions: positions, connections: subsetConnections(canvasIds()).map(function (p) { return [p[0], p[1]]; }) };
  }
  function pushHistory() { var snap = canvasSnapshot(); if (historyIndex >= 0 && JSON.stringify(history[historyIndex]) === JSON.stringify(snap)) return; history = history.slice(0, historyIndex + 1); history.push(snap); historyIndex = history.length - 1; }
  function restoreHistory(snap) {
    App.canvasNodeIds = snap.ids.slice(); snap.ids.forEach(function (id) { if (D.byId[id] && snap.positions[id]) { D.byId[id].x = snap.positions[id].x; D.byId[id].y = snap.positions[id].y; } });
    var outside = (D.connections || []).filter(function (p) { return snap.ids.indexOf(p[0]) < 0 || snap.ids.indexOf(p[1]) < 0; }); D.connections = outside.concat(snap.connections); renderCanvas(); schedulePersist();
  }
  function undo() { if (mode !== "canvas" || historyIndex <= 0) { App.toast("没有可撤销的画布操作"); return; } historyIndex--; restoreHistory(history[historyIndex]); }
  function redo() { if (mode !== "canvas" || historyIndex >= history.length - 1) { App.toast("没有可重做的画布操作"); return; } historyIndex++; restoreHistory(history[historyIndex]); }
  App.workspaceUndo = undo; App.workspaceRedo = redo;

  function keyHandler(event) {
    if (mode !== "canvas" || (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName))) return;
    if ((event.key === "Delete" || event.key === "Backspace") && App.state.selectedId && isOnCanvas(App.state.selectedId)) { removeFromCanvas(App.state.selectedId); renderCanvas(); App.toast("已从画布移除，原文件仍在资料库"); event.preventDefault(); }
    if (event.key === "Enter" && App.state.selectedId) App.router.go("#/detail/" + App.state.selectedId);
  }
  document.addEventListener("keydown", keyHandler);

  App.workspaceApplySearch = function (query) { searchQuery = query || ""; App.state.workspaceSearch = searchQuery; if (searchQuery) mode = App.state.workspaceMode = "library"; render(); };
  App.workspaceApplyFilter = function () { mode = App.state.workspaceMode = "library"; render(); };

  render();
  return function cleanup() {
    clearTimeout(persistTimer); document.removeEventListener("keydown", keyHandler);
    App.workspaceApplySearch = null; App.workspaceApplyFilter = null; App.workspaceSetMode = null; App.workspaceUndo = null; App.workspaceRedo = null;
  };
};
