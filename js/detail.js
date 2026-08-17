/* ===================================================================
   FileHub · 视图二 文件详情 / 编辑（重写版 · 数据驱动 + 路由可达）
   面包屑返回 · 预览/编辑/版本切换 · 目录大纲 · 文件信息 · LangChain 代码块(TODO)
   =================================================================== */
window.App = window.App || {};
App.views = App.views || {};

App.views.detail = function (container, params) {
  var D = App.data;
  var id = params[0];
  var f = D.byId[id] || D.files[0];
  App.workspaceApplySearch = null; // 离开工作区，解除搜索钩子
  if (!f) {
    container.innerHTML = '<div class="cmd-empty">文件尚未加载，请返回工作区后重试</div>';
    return;
  }
  f.content = typeof f.content === "string" ? f.content : "";
  f.tags = Array.isArray(f.tags) ? f.tags : [];
  f.typeLabel = f.typeLabel || f.type || "FILE";
  f.size = f.size || "0 B";
  f.updated = f.updated || f.updatedAt || "";

  // ---- 简易 Markdown 渲染（预览态） ----
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inline(s) {
    return escapeHtml(s).replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
  }
  function renderMarkdown(md) {
    var lines = String(md || "").split("\n");
    var html = "", inCode = false, code = "";
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf("```") === 0) {
        if (inCode) { html += '<pre class="md-code">' + escapeHtml(code) + "</pre>"; code = ""; inCode = false; }
        else { inCode = true; }
        continue;
      }
      if (inCode) { code += line + "\n"; continue; }
      if (line.indexOf("# ") === 0) html += "<h1>" + inline(line.slice(2)) + "</h1>";
      else if (line.indexOf("## ") === 0) html += "<h2>" + inline(line.slice(3)) + "</h2>";
      else if (line.trim() === "") { /* 空行忽略 */ }
      else html += "<p>" + inline(line) + "</p>";
    }
    return html;
  }
  function toc(md) {
    var items = [], lines = String(md || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^(#{1,2})\s+(.*)$/);
      if (m) items.push({ text: m[2], level: m[1].length });
    }
    return items;
  }

  // ---- 模板 ----
  container.innerHTML =
    '<section class="editor">' +
      '<div class="toolbar">' +
        '<div class="tb-left">' +
          '<span class="back-btn" id="backBtn">← 工作区</span>' +
          '<span class="breadcrumb" id="breadcrumb"></span>' +
        '</div>' +
        '<div class="tb-tabs">' +
          '<span class="tb-tab preview active" data-tab="preview">预览</span>' +
          '<span class="tb-tab edit" data-tab="edit">编辑</span>' +
          '<span class="tb-tab version" data-tab="version">版本</span>' +
        '</div>' +
      '</div>' +
      '<div class="doc-scroll" id="docScroll"></div>' +
    '</section>' +
    '<aside class="info-panel">' +
      '<div class="dp-title">文档目录</div>' +
      '<nav class="dp-toc" id="dpToc"></nav>' +
      '<div class="dp-divider"></div>' +
      '<div class="dp-title">文件信息</div>' +
      '<div class="dp-meta" id="dpMeta"></div>' +
      '<div class="dp-todo">正文编辑会自动生成版本；AI 摘要支持 LangChain 与本地降级链路。</div>' +
    '</aside>';

  var docScroll = container.querySelector("#docScroll");
  var dpToc = container.querySelector("#dpToc");
  var dpMeta = container.querySelector("#dpMeta");
  var breadcrumb = container.querySelector("#breadcrumb");

  breadcrumb.textContent = "我的工作区 / " + f.name;
  dpMeta.textContent = "类型：" + f.typeLabel + "\n大小：" + f.size + "\n更新：" + f.updated +
    "\n标签：" + f.tags.map(function (t) { return t.t; }).join(" / ");

  var activeTab = "preview";
  function renderToc() {
    var tocItems = toc(f.content);
    dpToc.innerHTML = tocItems.length ? tocItems.map(function (t, i) {
      return '<a data-i="' + i + '" style="' + (t.level === 2 ? "padding-left:12px;" : "") + '">' + escapeHtml(t.text) + "</a>";
    }).join("") : '<span class="dp-empty">暂无目录</span>';
    dpToc.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        switchTab("preview");
        App.toast("已定位：" + a.textContent);
      });
    });
  }
  renderToc();

  // ---- 三个标签页内容 ----
  function renderPreview() {
    docScroll.innerHTML = f.content
      ? '<div class="md">' + renderMarkdown(f.content) + "</div>"
      : '<div class="cmd-empty">正文加载中…</div>';
  }
  function renderEdit() {
    docScroll.innerHTML =
      '<textarea class="edit-area" id="editArea" spellcheck="false"></textarea>' +
      '<div class="edit-hint">直接编辑文档正文（Markdown）。点击保存将写入后端并自动生成新版本。</div>' +
      '<div class="code-block">' +
        '<div class="cb-title">AI 摘要链路</div>' +
        '<pre>LangChain → 工作区权限过滤 → 内容检索 → 摘要与引用\n服务不可用时自动使用本地确定性摘要。</pre>' +
      '</div>' +
      '<div class="save-row">' +
        '<button class="btn primary" id="saveBtn">保存草稿</button>' +
        '<button class="btn ghost" id="resetBtn">还原</button>' +
      '</div>';
    var editArea = docScroll.querySelector("#editArea");
    editArea.value = f.content;
    editArea.addEventListener("input", function () {
      f.content = editArea.value; // 仅内存态
    });
    docScroll.querySelector("#saveBtn").addEventListener("click", function () {
      var remote = App.api && App.remoteWorkspaceId && f.id && f.id.indexOf("file_") === 0;
      if (remote) {
        App.api.put("/files/" + f.id + "/content", { content: editArea.value }).then(function (r) {
          f.content = editArea.value;
          App.toast("已保存到后端（版本 " + (r && r.version) + "）");
        }).catch(function (e) { App.toast("保存失败：" + e.message); });
      } else {
        f.content = editArea.value;
        App.toast("草稿已暂存（离线内存态）");
      }
    });
    docScroll.querySelector("#resetBtn").addEventListener("click", function () {
      editArea.value = f.content;
      App.toast("已还原");
    });
  }
  function renderVersion() {
    var list = document.createElement("div");
    list.className = "ver-list";
    list.innerHTML = '<div class="cmd-empty">加载版本…</div>';
    docScroll.innerHTML = "";
    docScroll.appendChild(list);

    function renderItems(vers) {
      list.innerHTML = "";
      if (!vers.length) { list.innerHTML = '<div class="cmd-empty">暂无版本</div>'; return; }
      vers.forEach(function (v, i) {
        var el = document.createElement("div");
        el.className = "ver-item" + (v.current ? " current" : "");
        el.innerHTML = '<div class="v-left">' +
          '<div class="v-name">' + v.name + '</div>' +
          '<div class="v-meta">' + v.meta + '</div>' +
          '</div>' +
          (v.current ? '<span class="v-tag">当前</span>' : '<span class="v-tag" style="background:var(--tag-gray-bg);color:var(--text-2)">历史</span>');
        el.addEventListener("click", function () {
          if (v.remote && v.id) {
            App.api.post("/files/" + f.id + "/versions/" + v.id + "/restore", {}).then(function () {
              App.toast("已还原该版本"); switchTab("preview");
            }).catch(function (e) { App.toast("还原失败：" + e.message); });
          } else {
            App.toast("当前文件尚未同步，无法恢复远程版本");
          }
        });
        list.appendChild(el);
      });
    }

    var remote = App.api && App.remoteWorkspaceId && f.id && f.id.indexOf("file_") === 0;
    if (remote) {
      App.api.get("/files/" + f.id + "/versions").then(function (res) {
        var vers = ((res && res.items) || []).map(function (v, i) {
          return { name: f.name + " · 版本 " + (v.id ? "" : ""), meta: (v.createdAt || "") + " · " + v.size + " 字节", current: i === 0, remote: true, id: v.id };
        });
        renderItems(vers);
      }).catch(function () { renderItems(D.versionsFor(f)); });
    } else {
      renderItems(D.versionsFor(f));
    }
  }

  // ---- 标签切换 ----
  var tabs = container.querySelectorAll(".tb-tab");
  function switchTab(name) {
    activeTab = name;
    tabs.forEach(function (t) { t.classList.toggle("active", t.dataset.tab === name); });
    if (name === "preview") renderPreview();
    else if (name === "edit") renderEdit();
    else if (name === "version") renderVersion();
    docScroll.scrollTop = 0;
  }
  tabs.forEach(function (t) {
    t.addEventListener("click", function () { switchTab(t.dataset.tab); });
  });

  container.querySelector("#backBtn").addEventListener("click", function () {
    App.router.go("#/");
  });

  // 默认预览态
  switchTab("preview");

  var remote = App.api && f.id && f.id.indexOf("file_") === 0;
  if (remote) {
    App.api.get("/files/" + f.id + "/content").then(function (result) {
      if (!document.contains(container)) return;
      f.content = (result && result.content) || "";
      renderToc();
      if (activeTab === "preview") renderPreview();
    }).catch(function () {
      if (!document.contains(container) || activeTab !== "preview" || f.content) return;
      docScroll.innerHTML = '<div class="cmd-empty">正文暂时无法加载，请稍后重试</div>';
    });
  }
};
