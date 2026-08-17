/* ===================================================================
   FileHub · 应用引导
   状态 / Toast / 侧栏 / 搜索 / 上传 / 必备功能（暗色·命令面板·通知·设置·
   快捷键·回收站·引导·导出） / 实验室路由注册
   =================================================================== */
window.App = window.App || {};

(function () {
  "use strict";

  // ---- 全局状态 ----
  App.state = {
    filter: { kind: "all" },
    selectedId: null,
    workspaceMode: "overview",
    workspaceSearch: ""
  };
  App.trash = [];                 // 回收站（被删节点）
  App._cleanup = null;            // 当前视图的清理函数

  // ---- Toast ----
  var toastEl = document.getElementById("toast");
  var toastTimer = null;
  App.toast = function (msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1800);
  };

  // ---- 侧栏高亮定位（流体布局下按实际元素位置计算，支持增减项） ----
  var sidebar = document.getElementById("sidebar");
  var sbHl = sidebar.querySelector(".sb-hl");
  function highlightNav(navEl) {
    if (!navEl) { sbHl.style.display = "none"; return; }
    sbHl.style.display = "block";
    var h = 30;
    sbHl.style.top = (navEl.offsetTop + (navEl.offsetHeight - h) / 2) + "px";
  }

  function clearNavActive() {
    sidebar.querySelectorAll(".sb-nav").forEach(function (el) { el.classList.remove("active"); });
  }
  function clearTagActive() {
    sidebar.querySelectorAll(".tag-pill").forEach(function (el) { el.classList.remove("active"); });
  }
  function clearTypeActive() {
    sidebar.querySelectorAll("[data-type],[data-type-group]").forEach(function (el) { el.classList.remove("active"); });
  }

  function applyFilter(kind, value, navEl) {
    App.state.filter = value ? { kind: kind, value: value } : { kind: kind };
    App.state.workspaceMode = "library";
    App.state.selectedId = null;
    clearNavActive(); clearTagActive(); clearTypeActive();
    if (navEl && navEl.classList.contains("sb-nav")) {
      highlightNav(navEl);
      if (navEl) navEl.classList.add("active");
    } else {
      sbHl.style.display = "none";
      if (navEl) navEl.classList.add("active");
    }
    var si = document.getElementById("globalSearch");
    if (si) si.value = "";
    App.router.go("#/");
    if (App.workspaceApplyFilter) App.workspaceApplyFilter();
  }

  sidebar.addEventListener("click", function (e) {
    var el = e.target.closest("[data-filter],[data-type],[data-type-group],[data-tag],[data-route-to]");
    if (!el) return;
    if (el.dataset.routeTo) { App.router.go(el.dataset.routeTo); return; }
    if (el.dataset.filter) { applyFilter(el.dataset.filter, null, el); return; }
    if (el.dataset.type) { applyFilter("type", el.dataset.type, el); return; }
    if (el.dataset.typeGroup) { applyFilter("typeGroup", el.dataset.typeGroup, el); return; }
    if (el.dataset.tag) {
      var active = el.classList.contains("active");
      if (active) applyFilter("all", null, sidebar.querySelector('[data-filter="all"]'));
      else applyFilter("tag", el.dataset.tag, el);
    }
  });
  // 初始化侧栏高亮（'all' 默认激活）
  highlightNav(sidebar.querySelector('[data-filter="all"]'));

  // ---- 顶部搜索 ----
  var searchInput = document.getElementById("globalSearch");
  searchInput.addEventListener("input", function () {
    var query = searchInput.value.trim();
    if (App.workspaceApplySearch) App.workspaceApplySearch(query);
    else if (query) { App.state.workspaceMode = "library"; App.state.workspaceSearch = query; App.router.go("#/"); }
  });

  // ---- 工作区侧边栏增强 ----
  var appShell = document.getElementById("app");
  document.getElementById("sidebarToggle").addEventListener("click", function () {
    appShell.classList.toggle("sidebar-collapsed");
    localStorage.setItem("fh_sidebar_collapsed", appShell.classList.contains("sidebar-collapsed") ? "1" : "0");
  });
  if (localStorage.getItem("fh_sidebar_collapsed") === "1" || window.innerWidth < 760) appShell.classList.add("sidebar-collapsed");
  document.getElementById("sbAiChat").addEventListener("click", function () { App.router.go("#/lab/ai-chat"); });
  document.getElementById("workspaceCreateBtn").addEventListener("click", function () { openSettings("workspace"); setTimeout(function () { document.getElementById("newWorkspaceName").focus(); }, 0); });
  document.getElementById("sbRefreshTags").addEventListener("click", function () { renderSidebarInsights(App.data.files, App.data.files.length); });

  function fileGroup(type) {
    type = String(type || "").toUpperCase();
    if (["PDF", "DOC", "DOCX", "MD", "TXT", "RTF", "XLS", "XLSX", "PPT", "PPTX"].indexOf(type) >= 0) return "document";
    if (["PNG", "JPG", "JPEG", "GIF", "WEBP", "SVG"].indexOf(type) >= 0) return "image";
    if (["DIR", "FOLDER"].indexOf(type) >= 0) return "folder";
    return "code";
  }
  function setCount(name, value) { var n = sidebar.querySelector('[data-count="' + name + '"]'); if (n) n.textContent = value; }
  function renderSidebarInsights(files, total) {
    files = files || [];
    setCount("all", total == null ? files.length : total);
    setCount("fav", files.filter(function (f) { return f.favorite; }).length);
    setCount("recent", files.filter(function (f) { var ts = Date.parse(f.updatedAt || f.updated || ""); return !isNaN(ts) && Date.now() - ts < 7 * 86400000; }).length);
    ["document", "image", "code", "folder"].forEach(function (group) { setCount(group, files.filter(function (f) { return fileGroup(f.type) === group; }).length); });
    var counts = {};
    files.forEach(function (f) { (f.tags || []).forEach(function (t) { counts[t.t] = (counts[t.t] || 0) + 1; }); });
    var tags = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); }).slice(0, 10);
    var wrap = document.getElementById("sbTags"); wrap.innerHTML = "";
    if (!tags.length) wrap.innerHTML = '<span class="sb-muted">暂无标签</span>';
    tags.forEach(function (name, i) { var tag = document.createElement("button"); tag.className = "tag-pill " + (i < 3 ? "blue" : "gray"); tag.dataset.tag = name; tag.innerHTML = '<span>' + name + '</span><small>' + counts[name] + '</small>'; wrap.appendChild(tag); });
    if (App.api && App.remoteWorkspaceId) {
      App.api.get("/workspaces/" + App.remoteWorkspaceId + "/trash").then(function (r) { setCount("trash", (r.items || []).length); }).catch(function () {});
      App.api.get("/workspaces/" + App.remoteWorkspaceId + "/health").then(function (r) { var items = r.items || [], avg = items.length ? Math.round(items.reduce(function (sum, x) { return sum + x.score; }, 0) / items.length) : 0; document.getElementById("sbHealthScore").textContent = avg; }).catch(function () {});
    }
  }

  // ---- 顶部收纳菜单与用户菜单 ----
  var moreMenu = document.getElementById("moreMenu");
  var userMenu = document.getElementById("userMenu");
  var avatarBtn = document.getElementById("avatarBtn");
  function initials(name) { return String(name || "U").trim().slice(0, 1).toUpperCase(); }
  function setCurrentUser(user) {
    App.currentUser = user;
    var letter = initials(user && user.displayName);
    avatarBtn.textContent = letter;
    document.getElementById("userMenuAvatar").textContent = letter;
    document.getElementById("userMenuName").textContent = (user && user.displayName) || "用户";
    document.getElementById("userMenuEmail").textContent = (user && user.email) || "";
  }
  function closeMenus() { moreMenu.classList.remove("show"); userMenu.classList.remove("show"); }
  document.getElementById("moreBtn").addEventListener("click", function (e) {
    e.stopPropagation(); userMenu.classList.remove("show"); moreMenu.classList.toggle("show");
  });
  avatarBtn.addEventListener("click", function (e) {
    e.stopPropagation(); moreMenu.classList.remove("show"); userMenu.classList.toggle("show");
  });
  document.addEventListener("click", function (e) {
    if (!moreMenu.contains(e.target) && !userMenu.contains(e.target)) closeMenus();
  });

  // ---- 顶部导航 ----
  document.querySelectorAll(".top-link").forEach(function (a) {
    a.addEventListener("click", function () { App.router.go(a.dataset.route); });
  });
  function syncTopNav() {
    var h = location.hash || "#/";
    document.querySelectorAll(".top-link").forEach(function (a) {
      a.classList.toggle("active", a.dataset.route === h || (h.indexOf("#/lab") === 0 && a.dataset.route === "#/lab"));
    });
  }

  // ---- 上传弹窗 ----
  var modal = document.getElementById("uploadModal");
  var dropzone = modal.querySelector(".dropzone");
  document.querySelector(".upload-btn").addEventListener("click", function () { modal.classList.add("show"); });
  modal.querySelector(".modal-close").addEventListener("click", closeModal);
  modal.querySelector(".btn.ghost").addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
  function closeModal() { modal.classList.remove("show"); }

  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add("drag"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove("drag"); });
  });
  dropzone.addEventListener("drop", function (e) {
    var files = e.dataTransfer.files;
    if (files && files.length) { for (var i = 0; i < files.length; i++) uploadFile(files[i]); }
  });
  modal.querySelector("#addSampleBtn").addEventListener("click", function () {
    var content = "# 新上传资料\n\n这是通过上传弹窗创建的 Markdown 文件。\n\n- [ ] 补充负责人\n- [ ] 完成内容评审";
    uploadFile(new File([content], "新上传资料.md", { type: "text/markdown" }));
  });

  function extToType(name) {
    var ext = (name.split(".").pop() || "").toLowerCase();
    if (ext === "pdf") return "PDF";
    if (ext === "md" || ext === "markdown") return "MD";
    if (ext === "doc" || ext === "docx") return "DOC";
    if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif") return "PNG";
    return "DIR";
  }

  // Real multipart upload when the backend is reachable; local node otherwise.
  function uploadFile(file) {
    closeModal();
    if (!App.api || !App.remoteWorkspaceId) { addSampleLocal(file.name); return; }
    App.api.upload("/workspaces/" + App.remoteWorkspaceId + "/files", file).then(function (f) {
      App.toast("已上传：" + f.name);
      syncRemoteFiles().then(syncRemoteCanvas);
    }).catch(function (e) { App.toast("上传失败：" + e.message); });
  }

  function addSampleLocal(name) {
    var D = App.data;
    var id = "U" + Date.now();
    var type = extToType(name);
    var node = {
      id: id, name: name, type: type, typeLabel: type === "DIR" ? "文件夹" : type,
      meta: (type === "DIR" ? "文件夹 · 新建" : type + " · 新增"),
      x: 260 + Math.random() * 200, y: 460 + Math.random() * 120,
      size: "—", updated: "刚刚",
      tags: [{ t: "新", c: "blue" }], favorite: false,
      summary: "离线模式临时加入画布，恢复网络后可通过同步功能提交。",
      content: "# " + name + "\n\n这是离线创建的临时文件。"
    };
    D.files.push(node);
    D.byId[id] = node;
    App.state.filter = { kind: "all" };
    App.state.selectedId = id;
    clearNavActive(); clearTagActive(); clearTypeActive();
    highlightNav(sidebar.querySelector('[data-filter="all"]'));
    sidebar.querySelector('[data-filter="all"]').classList.add("active");
    var si = document.getElementById("globalSearch"); if (si) si.value = "";
    closeModal();
    App.router.go("#/");
    App.toast("已加入画布（离线）：" + name);
  }

  /* ===================================================================
     必备功能 E1 · 暗色模式
     =================================================================== */
  var themeToggle = document.getElementById("themeToggle");
  function applyTheme(t) {
    if (t === "dark") { document.documentElement.setAttribute("data-theme", "dark"); themeToggle.textContent = "☀️"; }
    else { document.documentElement.removeAttribute("data-theme"); themeToggle.textContent = "🌙"; }
    try { localStorage.setItem("fh_theme", t); } catch (e) {}
  }
  themeToggle.addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(cur);
  });
  (function initTheme() {
    var saved = "light";
    try { saved = localStorage.getItem("fh_theme") || "light"; } catch (e) {}
    applyTheme(saved);
  })();

  /* ===================================================================
     必备功能 E2 · 命令面板 ⌘K
     =================================================================== */
  var cmdMask = document.getElementById("cmdPalette");
  var cmdInput = document.getElementById("cmdInput");
  var cmdList = document.getElementById("cmdList");
  var cmdIndex = 0;
  var cmdCommands = [
    { icon: "🗂", title: "跳转到工作区", run: function () { closeCmd(); App.router.go("#/"); } },
    { icon: "🧪", title: "打开功能实验室", run: function () { closeCmd(); App.router.go("#/lab"); } },
    { icon: "🌓", title: "切换深色 / 浅色主题", run: function () { closeCmd(); themeToggle.click(); } },
    { icon: "⚙️", title: "打开设置", run: function () { closeCmd(); openSettings(); } },
    { icon: "⬆", title: "上传文件", run: function () { closeCmd(); modal.classList.add("show"); } },
    { icon: "🗑", title: "打开回收站", run: function () { closeCmd(); openTrash(); } },
    { icon: "🔔", title: "打开通知中心", run: function () { closeCmd(); toggleNotif(true); } },
    { icon: "⌨", title: "显示键盘快捷键", run: function () { closeCmd(); openShortcuts(); } },
    { icon: "⤓", title: "导出 / 备份工作区", run: function () { closeCmd(); doExport(); } }
  ];
  function renderCmd(q) {
    q = (q || "").toLowerCase();
    var items = cmdCommands.filter(function (c) { return c.title.toLowerCase().indexOf(q) >= 0; });
    cmdList.innerHTML = "";
    if (!items.length) { cmdList.innerHTML = '<div class="cmd-empty">无匹配命令</div>'; return; }
    items.forEach(function (c, i) {
      var el = document.createElement("div");
      el.className = "cmd-item" + (i === cmdIndex ? " active" : "");
      el.innerHTML = '<span class="ci-icon">' + c.icon + '</span><span>' + c.title + '</span>';
      el.addEventListener("mouseenter", function () { cmdIndex = i; renderCmd(cmdInput.value); });
      el.addEventListener("click", function () { c.run(); });
      cmdList.appendChild(el);
    });
  }
  function openCmd() { cmdIndex = 0; cmdInput.value = ""; renderCmd(""); cmdMask.classList.add("show"); cmdInput.focus(); }
  function closeCmd() { cmdMask.classList.remove("show"); }
  var cmdBtn = document.getElementById("cmdBtn");
  if (cmdBtn) cmdBtn.addEventListener("click", openCmd);
  cmdMask.addEventListener("click", function (e) { if (e.target === cmdMask) closeCmd(); });
  cmdInput.addEventListener("input", function () { cmdIndex = 0; renderCmd(cmdInput.value); });
  cmdInput.addEventListener("keydown", function (e) {
    var items = cmdCommands.filter(function (c) { return c.title.toLowerCase().indexOf(cmdInput.value.toLowerCase()) >= 0; });
    if (e.key === "ArrowDown") { e.preventDefault(); cmdIndex = Math.min(cmdIndex + 1, items.length - 1); renderCmd(cmdInput.value); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cmdIndex = Math.max(cmdIndex - 1, 0); renderCmd(cmdInput.value); }
    else if (e.key === "Enter") { e.preventDefault(); if (items[cmdIndex]) items[cmdIndex].run(); }
    else if (e.key === "Escape") { closeCmd(); }
  });

  /* ===================================================================
     必备功能 E6 · 通知中心
     =================================================================== */
  var notifPanel = document.getElementById("notifPanel");
  var notifList = document.getElementById("notifList");
  var notifSeed = [];
  function loadNotifications() {
    return App.api.get("/notifications").then(function (r) {
      notifSeed = (r.items || []).map(function (n) { return { id: n.id, text: n.text, time: new Date(n.createdAt).toLocaleString(), unread: n.unread }; });
      renderNotif();
    });
  }
  function renderNotif() {
    notifList.innerHTML = "";
    notifSeed.forEach(function (n) {
      var el = document.createElement("div");
      el.className = "notif-item" + (n.unread ? " unread" : "");
      el.innerHTML = '<div>' + n.text + '</div><div class="ni-time">' + n.time + '</div>';
      notifList.appendChild(el);
    });
    var dot = document.getElementById("bellDot");
    var hasUnread = notifSeed.some(function (n) { return n.unread; });
    dot.style.display = hasUnread ? "block" : "none";
  }
  function toggleNotif(force) {
    var show = force !== undefined ? force : !notifPanel.classList.contains("show");
    notifPanel.classList.toggle("show", show);
    if (show) {
      loadNotifications().then(function () { return App.api.post("/notifications/read-all", {}); }).then(function () { notifSeed.forEach(function (n) { n.unread = false; }); renderNotif(); }).catch(function () {});
    }
  }
  document.getElementById("bellBtn").addEventListener("click", function (e) { e.stopPropagation(); toggleNotif(); });
  document.addEventListener("click", function (e) {
    if (!notifPanel.contains(e.target) && e.target.id !== "bellBtn") notifPanel.classList.remove("show");
  });

  /* ===================================================================
     必备功能 E5 · 设置中心
     =================================================================== */
  var settingsModal = document.getElementById("settingsModal");
  function openSettings(tab) {
    closeMenus();
    selectSettingsTab(tab || "account");
    settingsModal.classList.add("show");
    if (App.currentUser) {
      document.getElementById("profileName").value = App.currentUser.displayName || "";
      document.getElementById("profileEmail").value = App.currentUser.email || "";
    }
    document.getElementById("workspaceNameInput").value = App.workspaceName || "";
  }
  function selectSettingsTab(name) {
    document.querySelectorAll("[data-settings-tab]").forEach(function (el) { el.classList.toggle("active", el.dataset.settingsTab === name); });
    document.querySelectorAll("[data-settings-pane]").forEach(function (el) { el.classList.toggle("active", el.dataset.settingsPane === name); });
  }
  document.querySelectorAll("[data-settings-tab]").forEach(function (el) { el.addEventListener("click", function () { selectSettingsTab(el.dataset.settingsTab); }); });
  document.getElementById("settingsClose").addEventListener("click", function () { settingsModal.classList.remove("show"); });
  document.getElementById("settingsCancel").addEventListener("click", function () { settingsModal.classList.remove("show"); });
  settingsModal.addEventListener("click", function (e) { if (e.target === settingsModal) settingsModal.classList.remove("show"); });
  document.getElementById("setTheme").addEventListener("change", function (e) { applyTheme(e.target.value); });
  document.getElementById("setModel").addEventListener("change", function (e) { localStorage.setItem("fh_model_preference", e.target.value); App.toast("AI 模型偏好已保存：" + e.target.value); });
  document.getElementById("setDensity").addEventListener("change", function (e) { localStorage.setItem("fh_density", e.target.value); document.documentElement.dataset.density = e.target.value === "紧凑" ? "compact" : "comfortable"; });
  document.getElementById("setReduceMotion").addEventListener("change", function (e) {
    var value = e.target.checked ? "true" : "false";
    localStorage.setItem("fh_reduce_motion", value); document.documentElement.dataset.reduceMotion = value;
  });
  document.getElementById("saveProfile").addEventListener("click", function () {
    var name = document.getElementById("profileName").value.trim();
    if (!name) { App.toast("显示名称不能为空"); return; }
    App.api.patch("/auth/me", { displayName: name }).then(function (user) { setCurrentUser(user); App.toast("账号资料已保存"); }).catch(function (e) { App.toast("保存失败：" + e.message); });
  });
  document.getElementById("saveWorkspace").addEventListener("click", function () {
    var name = document.getElementById("workspaceNameInput").value.trim();
    if (!name || !App.remoteWorkspaceId) { App.toast("请输入工作区名称"); return; }
    App.api.patch("/workspaces/" + App.remoteWorkspaceId, { name: name }).then(function (w) {
      App.workspaceName = w.name || name;
      var select = document.getElementById("workspaceSelect");
      if (select.selectedIndex >= 0) select.options[select.selectedIndex].textContent = App.workspaceName;
      App.router.resolve(); App.toast("工作区设置已保存");
    }).catch(function (e) { App.toast("保存失败：" + e.message); });
  });
  document.getElementById("createWorkspace").addEventListener("click", function () {
    var input = document.getElementById("newWorkspaceName"); var name = input.value.trim();
    if (!name) { App.toast("请输入新工作区名称"); input.focus(); return; }
    App.api.post("/workspaces", { name: name }).then(function (workspace) {
      var select = document.getElementById("workspaceSelect"); var option = document.createElement("option");
      option.value = workspace.id; option.textContent = workspace.name; select.appendChild(option); select.value = workspace.id;
      App.remoteWorkspaceId = workspace.id; App.workspaceName = workspace.name; App.state.selectedId = null;
      App.state.workspaceMode = "overview";
      App.data.files = []; App.data.byId = {}; App.data.connections = []; renderSidebarInsights([], 0); App.router.resolve();
      input.value = ""; settingsModal.classList.remove("show"); App.toast("已创建工作区：" + workspace.name);
    }).catch(function (e) { App.toast("创建失败：" + e.message); });
  });
  document.getElementById("changePassword").addEventListener("click", function () {
    var current = document.getElementById("currentPassword").value;
    var next = document.getElementById("newPassword").value;
    var confirm = document.getElementById("confirmPassword").value;
    if (next.length < 8) { App.toast("新密码至少需要 8 位"); return; }
    if (next !== confirm) { App.toast("两次输入的新密码不一致"); return; }
    App.api.post("/auth/change-password", { currentPassword: current, newPassword: next }).then(function () {
      settingsModal.classList.remove("show"); App.api.clearSession(); showAuth("login", "密码已更新，请重新登录");
    }).catch(function (e) { App.toast("更新失败：" + e.message); });
  });

  (function initPreferences() {
    var density = localStorage.getItem("fh_density") || "舒适";
    document.getElementById("setDensity").value = density;
    document.documentElement.dataset.density = density === "紧凑" ? "compact" : "comfortable";
    var model = localStorage.getItem("fh_model_preference"); if (model) document.getElementById("setModel").value = model;
    var reduced = localStorage.getItem("fh_reduce_motion") === "true";
    document.getElementById("setReduceMotion").checked = reduced;
    document.documentElement.dataset.reduceMotion = reduced ? "true" : "false";
  })();

  moreMenu.addEventListener("click", function (e) {
    var item = e.target.closest("[data-action]"); if (!item) return;
    closeMenus();
    var action = item.dataset.action;
    if (action === "command") openCmd();
    else if (action === "export") doExport();
    else if (action === "shortcuts") openShortcuts();
    else if (action === "settings") openSettings("appearance");
  });
  userMenu.addEventListener("click", function (e) {
    var item = e.target.closest("[data-action]"); if (!item) return;
    closeMenus();
    if (item.dataset.action === "profile") openSettings("account");
    else if (item.dataset.action === "settings") openSettings("appearance");
    else if (item.dataset.action === "logout") {
      App.api.logout().then(function () { showAuth("login", "已安全退出登录"); });
    }
  });

  /* ===================================================================
     必备功能 E10 · 快捷键体系
     =================================================================== */
  var shortcutsModal = document.getElementById("shortcutsModal");
  var kbData = [
    ["Ctrl / Cmd + K", "打开命令面板"],
    ["Ctrl / Cmd + Z", "撤销画布操作"],
    ["Ctrl / Cmd + Shift + Z", "重做画布操作"],
    ["?", "显示本快捷键面板"],
    ["Esc", "关闭弹窗 / 面板"],
    ["Delete", "删除选中节点"],
    ["Enter", "打开选中文件详情"]
  ];
  function openShortcuts() {
    var kb = document.getElementById("kbList");
    kb.innerHTML = "";
    kbData.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "kb-row";
      row.innerHTML = '<span>' + r[1] + '</span><span class="kb-keys"><kbd>' + r[0] + '</kbd></span>';
      kb.appendChild(row);
    });
    shortcutsModal.classList.add("show");
  }
  document.getElementById("shortcutsClose").addEventListener("click", function () { shortcutsModal.classList.remove("show"); });
  document.getElementById("shortcutsCancel").addEventListener("click", function () { shortcutsModal.classList.remove("show"); });
  shortcutsModal.addEventListener("click", function (e) { if (e.target === shortcutsModal) shortcutsModal.classList.remove("show"); });

  /* ===================================================================
     必备功能 E8 · 回收站
     =================================================================== */
  var trashModal = document.getElementById("trashModal");
  document.getElementById("trashNav").addEventListener("click", openTrash);
  function openTrash() { trashModal.classList.add("show"); renderTrash(); }
  function renderTrash() {
    var list = document.getElementById("trashList");
    var remote = App.api && App.remoteWorkspaceId;
    if (remote) {
      list.innerHTML = '<div class="cmd-empty">加载回收站…</div>';
      App.api.get("/workspaces/" + App.remoteWorkspaceId + "/trash").then(function (res) {
        renderTrashItems((res && res.items) || []);
      }).catch(function () { renderTrashItems(App.trash); });
    } else {
      renderTrashItems(App.trash);
    }
  }
  function renderTrashItems(items) {
    var list = document.getElementById("trashList");
    list.innerHTML = "";
    if (!items.length) { list.innerHTML = '<div class="cmd-empty">回收站为空</div>'; return; }
    items.forEach(function (n) {
      var el = document.createElement("div");
      el.className = "trash-item";
      el.innerHTML = '<div><div class="t-name">' + n.name + '</div><div class="t-meta">' + (n.typeLabel || n.type) + ' · 删除于刚刚</div></div>' +
        '<div class="t-actions"><button class="t-btn restore">恢复</button><button class="t-btn del">彻底删除</button></div>';
      var isRemote = App.api && App.remoteWorkspaceId && n.id.indexOf("file_") === 0;
      el.querySelector(".restore").addEventListener("click", function () {
        if (isRemote) {
          App.api.post("/files/" + n.id + "/restore", {}).then(function () { syncRemoteFiles().then(renderTrash); }).catch(function () {});
        } else {
          var i = App.trash.indexOf(n); if (i >= 0) App.trash.splice(i, 1);
          App.data.files.push(n); App.data.byId[n.id] = n;
          App.router.go("#/"); renderTrash();
        }
        App.toast("已恢复：" + n.name);
      });
      el.querySelector(".del").addEventListener("click", function () {
        if (isRemote) {
          App.api.del("/files/" + n.id + "/purge").then(function () { renderTrash(); }).catch(function () {});
        } else {
          var i = App.trash.indexOf(n); if (i >= 0) App.trash.splice(i, 1);
          renderTrash();
        }
        App.toast("已彻底删除");
      });
      list.appendChild(el);
    });
  }
  document.getElementById("trashClose").addEventListener("click", function () { trashModal.classList.remove("show"); });
  document.getElementById("trashCancel").addEventListener("click", function () { trashModal.classList.remove("show"); });
  trashModal.addEventListener("click", function (e) { if (e.target === trashModal) trashModal.classList.remove("show"); });

  /* ===================================================================
     必备功能 E9 · 导出 / 备份
     =================================================================== */
  var exportModal = document.getElementById("exportModal");
  var exportBtn = document.getElementById("exportBtn");
  if (exportBtn) exportBtn.addEventListener("click", doExport);
  document.getElementById("exportClose").addEventListener("click", function () { exportModal.classList.remove("show"); });
  document.getElementById("exportCancel").addEventListener("click", function () { exportModal.classList.remove("show"); });
  exportModal.addEventListener("click", function (e) { if (e.target === exportModal) exportModal.classList.remove("show"); });
  document.getElementById("exportConfirm").addEventListener("click", function () {
    var selected = exportModal.querySelector('input[name="exportFormat"]:checked');
    exportModal.classList.remove("show"); doExport(selected ? selected.value : "json");
  });
  function doExport(format) {
    if (!format) { closeMenus(); exportModal.classList.add("show"); return; }
    format = String(format).toLowerCase();
    if (["json", "png", "pdf"].indexOf(format) < 0) { App.toast("不支持的导出格式"); return; }
    if (!App.remoteWorkspaceId) { App.toast("工作区尚未加载"); return; }
    App.api.post("/workspaces/" + App.remoteWorkspaceId + "/export", { format: format }).then(function (x) {
      return App.api.raw(x.download).then(function (r) { if (!r.ok) throw new Error("下载失败"); return r.blob(); }).then(function (blob) {
        var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = x.name; a.click(); URL.revokeObjectURL(a.href);
        App.toast("已导出 " + format.toUpperCase() + " 备份");
      });
    }).catch(function (e) { App.toast(e.message); });
  }

  /* ===================================================================
     必备功能 E7 · 新手引导
     =================================================================== */
  var onboard = document.getElementById("onboard");
  var obTitle = document.getElementById("onboardTitle");
  var obStep = document.getElementById("onboardStep");
  var obSteps = [
    { t: "欢迎来到 FileHub", s: "这是一个把文件、图片、代码与文件夹统一收纳到可拖拽画布的可视化工作区。" },
    { t: "自由排版", s: "在中央画布中拖动任意文件图标，按你的思路排布空间秩序。" },
    { t: "建立关联", s: "鼠标悬停节点右侧出现连接手柄，拖到另一节点即可建立关联连线。" },
    { t: "AI 智能总结", s: "点击节点，右侧面板会通过 LangChain 或本地降级链路生成文件摘要与标签。" },
    { t: "打开编辑", s: "点「打开编辑」进入详情视图，可预览 / 编辑 / 查看版本。开始探索吧！" }
  ];
  var obIdx = 0;
  function renderOnboard() {
    obTitle.textContent = obSteps[obIdx].t;
    obStep.textContent = obSteps[obIdx].s;
    document.getElementById("onboardNext").textContent = obIdx === obSteps.length - 1 ? "开始使用" : "下一步";
  }
  function startOnboard() {
    var seen = false;
    try { seen = localStorage.getItem("fh_onboard") === "1"; } catch (e) {}
    if (!seen) { obIdx = 0; renderOnboard(); onboard.classList.add("show"); }
  }
  document.getElementById("onboardNext").addEventListener("click", function () {
    if (obIdx < obSteps.length - 1) { obIdx++; renderOnboard(); }
    else { onboard.classList.remove("show"); try { localStorage.setItem("fh_onboard", "1"); } catch (e) {} }
  });
  document.getElementById("onboardSkip").addEventListener("click", function () {
    onboard.classList.remove("show"); try { localStorage.setItem("fh_onboard", "1"); } catch (e) {}
  });

  /* ===================================================================
     全局键盘快捷键
     =================================================================== */
  document.addEventListener("keydown", function (e) {
    var meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === "k" || e.key === "K")) { e.preventDefault(); openCmd(); return; }
    if (e.key === "?" && !meta) { e.preventDefault(); openShortcuts(); return; }
    if (e.key === "Escape") {
      [cmdMask, settingsModal, shortcutsModal, trashModal, exportModal, notifPanel, modal].forEach(function (m) { m.classList.remove("show"); });
      return;
    }
    // 撤销 / 重做（仅在工作区视图）
    if (meta && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) { if (App.workspaceRedo) App.workspaceRedo(); }
      else { if (App.workspaceUndo) App.workspaceUndo(); }
    }
  });

  // ---- 真实认证入口 ----
  var authScreen = document.getElementById("authScreen");
  var loginForm = document.getElementById("loginForm");
  var registerForm = document.getElementById("registerForm");
  function setAuthMode(mode) {
    var registering = mode === "register";
    loginForm.hidden = registering; registerForm.hidden = !registering;
    document.getElementById("authTitle").textContent = registering ? "创建账号" : "登录";
    document.getElementById("authSubtitle").textContent = registering ? "创建你的第一个 FileHub 工作区" : "继续进入你的知识工作区";
    document.getElementById("loginError").textContent = ""; document.getElementById("registerError").textContent = "";
  }
  function showAuth(mode, message) {
    closeMenus(); setAuthMode(mode || "login");
    if (message) document.getElementById("authSubtitle").textContent = message;
    authScreen.classList.add("show"); authScreen.setAttribute("aria-hidden", "false");
    App.remoteWorkspaceId = null; App.currentUser = null;
  }
  function hideAuth() { authScreen.classList.remove("show"); authScreen.setAttribute("aria-hidden", "true"); }
  function authSuccess(session) {
    setCurrentUser(session.user); hideAuth();
    return loadWorkspaceData().then(function () { startOnboard(); });
  }
  document.querySelectorAll("[data-auth-mode]").forEach(function (button) { button.addEventListener("click", function () { setAuthMode(button.dataset.authMode); }); });
  loginForm.addEventListener("submit", function (e) {
    e.preventDefault(); var error = document.getElementById("loginError"); error.textContent = "";
    var submit = loginForm.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = "正在登录…";
    App.api.login(document.getElementById("loginEmail").value.trim(), document.getElementById("loginPassword").value)
      .then(authSuccess).catch(function (err) { error.textContent = err.message === "invalid credentials" ? "邮箱或密码不正确" : err.message; })
      .finally(function () { submit.disabled = false; submit.textContent = "登录"; });
  });
  registerForm.addEventListener("submit", function (e) {
    e.preventDefault(); var error = document.getElementById("registerError"); error.textContent = "";
    var password = document.getElementById("registerPassword").value;
    if (password !== document.getElementById("registerConfirm").value) { error.textContent = "两次输入的密码不一致"; return; }
    var submit = registerForm.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = "正在创建…";
    App.api.register(document.getElementById("registerEmail").value.trim(), password, document.getElementById("registerName").value.trim())
      .then(authSuccess).catch(function (err) { error.textContent = err.message === "email already exists" ? "该邮箱已经注册" : err.message; })
      .finally(function () { submit.disabled = false; submit.textContent = "创建账号"; });
  });
  document.getElementById("demoLogin").addEventListener("click", function () {
    var button = this; button.disabled = true; button.textContent = "正在准备演示数据…";
    App.api.demoAuth().then(authSuccess).catch(function (err) { document.getElementById("loginError").textContent = err.message; })
      .finally(function () { button.disabled = false; button.textContent = "进入演示工作区"; });
  });
  window.addEventListener("filehub:auth-required", function () { showAuth("login", "会话已过期，请重新登录"); });

  // ---- 注册路由并启动 ----
  function closeOverlays() {
    [cmdMask, settingsModal, shortcutsModal, trashModal, exportModal, notifPanel].forEach(function (m) { m.classList.remove("show"); });
  }
  function mountView(fn) {
    var view = document.getElementById("view");
    view.innerHTML = "";
    if (App._cleanup) { try { App._cleanup(); } catch (e) {} App._cleanup = null; }
    App._cleanup = fn(view) || null;
    syncTopNav();
    closeOverlays();
    // 视图进入动画：强制重排以重启 keyframes
    view.classList.remove("view-enter");
    void view.offsetWidth;
    view.classList.add("view-enter");
  }
  App.router.add("/", function () { mountView(App.views.workspace); });
  App.router.add("/detail/:id", function (params) { mountView(function (v) { App.views.detail(v, params); }); });
  // 功能实验室：画廊 + 单个原型
  App.router.add("/lab", function () { mountView(function (v) { App.features.renderGallery(v); }); });
  App.router.add("/lab/:id", function (params) { mountView(function (v) { App.features.renderFeature(v, params[0]); }); });

  renderNotif();

  // ---- 后端同步（信封解包 + 标签数组 + 画布） ----
  function mapRemoteFile(f, i) {
    var tagList = (f.tags || []).map(function (t) { return { t: t.name, c: t.color || "blue" }; });
    var bytes = Number(f.size || 0), size = bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : bytes >= 1024 ? Math.round(bytes / 1024) + " KB" : bytes + " B";
    var updatedAt = f.updatedAt || f.updated_at || "";
    return Object.assign({}, f, {
      x: f.x || 60 + (i % 4) * 220,
      y: f.y || 80 + Math.floor(i / 4) * 150,
      tags: tagList,
      typeLabel: f.type,
      meta: f.type + " · " + size,
      updated: updatedAt
    });
  }

  function syncRemoteFiles() {
    if (!App.api || !App.remoteWorkspaceId) return Promise.resolve();
    return App.api.get("/workspaces/" + App.remoteWorkspaceId + "/files?pageSize=200").then(function (first) {
      if (first.total > first.items.length) {
        return App.api.get("/workspaces/" + App.remoteWorkspaceId + "/files?page=2&pageSize=200").then(function (second) {
          first.items = first.items.concat(second.items || []); return first;
        });
      }
      return first;
    }).then(function (res) {
      var files = (res && res.items) || [];
      App.data.files = files.map(mapRemoteFile);
      App.data.byId = {};
      App.data.files.forEach(function (f) { App.data.byId[f.id] = f; });
      renderSidebarInsights(App.data.files, res.total);
      App.router.resolve();
    });
  }

  function syncRemoteCanvas() {
    if (!App.api || !App.remoteWorkspaceId) return Promise.resolve();
    return App.api.get("/workspaces/" + App.remoteWorkspaceId + "/canvas").then(function (canvas) {
      if (canvas && canvas.nodes && canvas.nodes.length) {
        var pos = {};
        canvas.nodes.forEach(function (n) { pos[n.id] = { x: n.x, y: Math.max(112, n.y) }; });
        App.data.files.forEach(function (f) { if (pos[f.id]) { f.x = pos[f.id].x; f.y = pos[f.id].y; } });
      }
      var savedIds = canvas && canvas.nodes ? canvas.nodes.map(function (n) { return n.id; }).filter(function (id) { return !!App.data.byId[id]; }) : [];
      if (savedIds.length > 40) {
        savedIds = App.data.files.filter(function (f) { return f.favorite; }).slice(0, 12).map(function (f) { return f.id; });
        if (!savedIds.length) savedIds = App.data.files.slice(0, 8).map(function (f) { return f.id; });
        savedIds.forEach(function (id, index) { App.data.byId[id].x = 70 + (index % 4) * 250; App.data.byId[id].y = 80 + Math.floor(index / 4) * 160; });
      }
      if (!savedIds.length) savedIds = App.data.files.filter(function (f) { return f.favorite; }).slice(0, 8).map(function (f) { return f.id; });
      App.canvasNodeIds = savedIds;
      if (canvas && canvas.connections && canvas.connections.length) {
        App.data.connections = canvas.connections.map(function (p) { return [p[0], p[1]]; });
      }
      App.router.resolve();
    });
  }

  // Expose canvas persistence for the workspace view.
  App.persistCanvas = function () {
    if (!App.api || !App.remoteWorkspaceId) return Promise.resolve();
    var ids = Array.isArray(App.canvasNodeIds) ? App.canvasNodeIds : [];
    var nodes = ids.map(function (id) { return App.data.byId[id]; }).filter(Boolean).map(function (f) { return { id: f.id, x: f.x, y: f.y }; });
    var connections = (App.data.connections || []).filter(function (p) { return ids.indexOf(p[0]) >= 0 && ids.indexOf(p[1]) >= 0; }).map(function (p) { return [p[0], p[1]]; });
    return App.api.get("/workspaces/" + App.remoteWorkspaceId + "/canvas").then(function (cur) {
      var revision = (cur && cur.revision) || 0;
      return App.api.put("/workspaces/" + App.remoteWorkspaceId + "/canvas", { revision: revision, nodes: nodes, connections: connections, viewport: {} });
    }).catch(function () { /* offline: keep local state */ });
  };

  function loadWorkspaceData() {
    return Promise.all([App.api.get("/auth/me"), App.api.get("/workspaces")]).then(function (result) {
      setCurrentUser(result[0]);
      var workspaces = (result[1] && result[1].items) || [];
      if (!workspaces.length) throw new Error("账号暂无可用工作区");
      var select = document.getElementById("workspaceSelect"); select.innerHTML = "";
      workspaces.forEach(function (w) { var option = document.createElement("option"); option.value = w.id; option.textContent = w.name; select.appendChild(option); });
      App.remoteWorkspaceId = workspaces[0].id; App.workspaceName = workspaces[0].name; select.value = App.remoteWorkspaceId;
      select.onchange = function () {
        App.remoteWorkspaceId = select.value; App.workspaceName = select.options[select.selectedIndex].textContent;
        App.state.selectedId = null; App.state.workspaceMode = "overview"; App.data.connections = []; App.canvasNodeIds = [];
        syncRemoteFiles().then(syncRemoteCanvas).then(function () { App.toast("已切换到 " + App.workspaceName); });
      };
      return syncRemoteFiles().then(syncRemoteCanvas);
    });
  }

  if (App.api && App.api.hasSession()) {
    loadWorkspaceData().then(function () {
      App.router.start();
      startOnboard();
    }).catch(function () {
      App.router.start();
      App.api.clearSession();
      showAuth("login", "会话已失效，请重新登录");
    });
  } else {
    App.router.start();
    showAuth("login");
  }
})();
