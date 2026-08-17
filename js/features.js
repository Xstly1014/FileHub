/* ===================================================================
   FileHub · 功能实验室（画廊 + 20 个完整可交互原型）
   所有原型用 App.data / App.labData 的模拟数据驱动，核心交互真实可玩；
   AI / 后端步骤以模拟延迟 + 示例结果呈现，并标注真实接入点。
   =================================================================== */
window.App = window.App || {};
App.features = (function () {
  var SVGNS = "http://www.w3.org/2000/svg";
  var SCALE = 0.62;   // 数据坐标(840x844) -> 迷你画布缩放

  // ---- DOM 辅助 ----
  function h(tag, attrs) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      var v = attrs[k];
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k === "style") e.style.cssText = v;
      else if (k === "text") e.textContent = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      e.appendChild((typeof c === "object" && c.nodeType) ? c : document.createTextNode(c));
    }
    return e;
  }
  function ai(ms, cb) { setTimeout(cb, ms); }   // 模拟 AI / 网络延迟

  // ---- 迷你画布工厂（多个原型复用） ----
  function miniWorkspace(area, nodes, links, opts) {
    opts = opts || {};
    var wrap = h("div", { class: "mini-canvas" });
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "mini-links");
    svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
    wrap.appendChild(svg);
    area.appendChild(wrap);
    var map = {};   // id -> {el, x, y, data}

    function place(n) {
      var el = h("div", { class: "mini-node", style: "left:" + (n.x * SCALE) + "px;top:" + (n.y * SCALE) + "px;" },
        h("div", { class: "mn-badge" }, n.type),
        h("div", { class: "mn-name", title: n.name }, n.name),
        h("div", { class: "mn-meta" }, n.meta || "")
      );
      el.dataset.id = n.id;
      if (opts.draggable) attachDrag(el, n);
      if (opts.onSelect) el.addEventListener("click", function () { opts.onSelect(n.id); });
      wrap.appendChild(el);
      map[n.id] = { el: el, x: n.x, y: n.y, data: n };
    }
    function attachDrag(el, n) {
      var d = null;
      el.addEventListener("pointerdown", function (e) { e.preventDefault(); d = { sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y }; el.setPointerCapture(e.pointerId); });
      el.addEventListener("pointermove", function (e) {
        if (!d) return;
        n.x = Math.max(0, Math.min(840, d.ox + (e.clientX - d.sx) / SCALE));
        n.y = Math.max(0, Math.min(844, d.oy + (e.clientY - d.sy) / SCALE));
        el.style.left = (n.x * SCALE) + "px"; el.style.top = (n.y * SCALE) + "px";
        map[n.id].x = n.x; map[n.id].y = n.y; drawLinks();
      });
      el.addEventListener("pointerup", function (e) { if (d) el.releasePointerCapture(e.pointerId); d = null; });
    }
    function drawLinks() {
      svg.innerHTML = "";
      links.forEach(function (p) {
        var a = map[p[0]], b = map[p[1]]; if (!a || !b) return;
        var ax = a.x * SCALE + 60, ay = a.y * SCALE + 37, bx = b.x * SCALE + 60, by = b.y * SCALE + 37;
        var path = document.createElementNS(SVGNS, "path");
        path.setAttribute("d", "M" + ax + " " + ay + " C" + (ax + (bx - ax) / 2) + " " + ay + " " + (bx - (bx - ax) / 2) + " " + by + " " + bx + " " + by);
        svg.appendChild(path);
      });
    }
    nodes.forEach(place);
    drawLinks();
    return {
      wrap: wrap, svg: svg, map: map, drawLinks: drawLinks,
      setLinks: function (l) { links = l; drawLinks(); },
      setSelected: function (id) { for (var k in map) map[k].el.classList.toggle("selected", k === id); },
      flash: function (id) { var el = map[id] && map[id].el; if (el) { el.classList.add("lab-flashi"); setTimeout(function () { el.classList.remove("lab-flashi"); }, 900); } },
      nodeCenter: function (id) { var m = map[id]; return m ? { x: m.x * SCALE + 60, y: m.y * SCALE + 37 } : null; }
    };
  }

  // ===== 功能定义 =====
  var F = [];   // 全部功能

  /* ---------- C1 力导向自动布局 ---------- */
  F.push({
    id: "force-layout", title: "力导向自动布局", cat: "创意", tag: "画布",
    desc: "按关联强度自动受力排布节点，一键从混乱归位成聚类簇。",
    goal: "让用户零手动整理即可获得有序画布；最终混乱度下降 80%，整理耗时从分钟级降到秒级。",
    logic: ["点「打乱」让节点随机散布", "点「一键整理」触发受力模拟动画", "关联紧密的节点聚拢成簇，孤立节点散开", "整理后可继续手动微调"],
    render: function (area) {
      var files = App.data.files.map(function (n) { return { id: n.id, name: n.name, type: n.type, meta: n.meta, x: n.x, y: n.y }; });
      var links = App.data.connections.map(function (p) { return [p[0], p[1]]; });
      var ws = miniWorkspace(area, files, links, { draggable: true });
      var row = h("div", { class: "lab-row" });
      row.appendChild(h("button", { class: "lab-btn ghost", onclick: function () {
        files.forEach(function (n) { n.x = 40 + Math.random() * 720; n.y = 40 + Math.random() * 740; var m = ws.map[n.id]; m.el.style.left = (n.x * SCALE) + "px"; m.el.style.top = (n.y * SCALE) + "px"; m.x = n.x; m.y = n.y; }); ws.drawLinks();
      } }, "打乱"));
      row.appendChild(h("button", { class: "lab-btn primary", onclick: function () {
        // 模拟受力：按连接分组，同组聚到同一锚点
        var groups = {}, g = 0;
        files.forEach(function (n) { if (!(n.id in groups)) groups[n.id] = g++; });
        links.forEach(function (p) { groups[p[1]] = groups[p[0]]; });
        var anchors = {};
        Object.keys(groups).forEach(function (id) { var gi = groups[id]; if (!anchors[gi]) anchors[gi] = { x: 120 + (gi * 180) % 600, y: 120 + Math.floor(gi / 3) * 160 }; });
        files.forEach(function (n) { var a = anchors[groups[n.id]]; animate(n, ws, a.x + (Math.random() * 80 - 40), a.y + (Math.random() * 80 - 40)); });
        App.toast("已按关联聚类（模拟受力）");
      } }, "一键整理 ⚡"));
      area.insertBefore(row, area.firstChild);
      area.appendChild(h("div", { class: "lab-hint" }, "TODO（真实）：接入 d3-force / 力导向物理引擎，实时迭代直到收敛。"));
      function animate(n, ws, tx, ty) {
        var m = ws.map[n.id], sx = n.x, sy = n.y, t0 = Date.now();
        (function step() { var k = Math.min(1, (Date.now() - t0) / 600); n.x = sx + (tx - sx) * k; n.y = sy + (ty - sy) * k; m.el.style.left = (n.x * SCALE) + "px"; m.el.style.top = (n.y * SCALE) + "px"; m.x = n.x; m.y = n.y; if (k < 1) requestAnimationFrame(step); else ws.drawLinks(); })();
      }
    }
  });

  /* ---------- C2 时间轴回放 ---------- */
  F.push({
    id: "timeline", title: "时间轴回放", cat: "创意", tag: "画布",
    desc: "像 Git 历史一样拖动时间轴，回放文件加入 / 移动 / 关联的变化。",
    goal: "让用户理解知识演进过程，可回溯任意历史时刻；用于复盘、演示与审计。",
    logic: ["底部时间轴展示演进事件序列", "拖动滑块或点「播放」逐步回放", "画布仅显示截至当前时刻的节点与连线", "可定位到任意历史快照"],
    render: function (area) {
      var TL = App.labData.timeline, base = App.labData.basePos;
      var state = {}; Object.keys(base).forEach(function (k) { state[k] = { x: base[k].x, y: base[k].y, vis: false }; });
      var linksNow = [];
      var ws = miniWorkspace(area, [], []);
      function renderAt(idx) {
        var vis = {}, lk = [];
        for (var i = 0; i <= idx; i++) {
          var ev = TL[i];
          if (ev.type === "add") { vis[ev.nodeId] = true; state[ev.nodeId].x = ev.x; state[ev.nodeId].y = ev.y; }
          else if (ev.type === "move") { state[ev.nodeId].x = ev.x; state[ev.nodeId].y = ev.y; }
          else if (ev.type === "link") { lk.push([ev.a, ev.b]); }
        }
        // rebuild mini nodes
        ws.wrap.querySelectorAll(".mini-node").forEach(function (e) { e.remove(); });
        Object.keys(state).forEach(function (k) { if (!vis[k]) return; var n = App.data.byId[k]; if (!n) return;
          var el = h("div", { class: "mini-node", style: "left:" + (state[k].x * SCALE) + "px;top:" + (state[k].y * SCALE) + "px;" },
            h("div", { class: "mn-badge" }, n.type), h("div", { class: "mn-name" }, n.name)); ws.wrap.appendChild(el); });
        ws.svg.innerHTML = "";
        lk.forEach(function (p) { var a = state[p[0]], b = state[p[1]]; if (!a || !b) return; var ax = a.x * SCALE + 60, ay = a.y * SCALE + 37, bx = b.x * SCALE + 60, by = b.y * SCALE + 37;
          var path = document.createElementNS(SVGNS, "path"); path.setAttribute("d", "M" + ax + " " + ay + " C" + (ax + (bx - ax) / 2) + " " + ay + " " + (bx - (bx - ax) / 2) + " " + by + " " + bx + " " + by); ws.svg.appendChild(path); });
        cur.innerHTML = "时刻：" + TL[idx].day + " · " + TL[idx].label;
      }
      var cur = h("div", { class: "lab-label" }, "");
      var slider = h("input", { type: "range", min: "0", max: String(TL.length - 1), value: "0", style: "width:100%;" });
      slider.addEventListener("input", function () { renderAt(+slider.value); });
      var row = h("div", { class: "lab-row" }, h("button", { class: "lab-btn ghost", onclick: play }, "▶ 播放"), slider);
      area.insertBefore(row, area.firstChild); area.insertBefore(cur, area.firstChild);
      var timer = null;
      function play() { if (timer) { clearInterval(timer); timer = null; return; } var i = 0; timer = setInterval(function () { slider.value = i; renderAt(i); if (i++ >= TL.length - 1) { clearInterval(timer); timer = null; } }, 900); }
      renderAt(0);
    }
  });

  /* ---------- C3 无限画布 + 小地图 ---------- */
  F.push({
    id: "infinite-canvas", title: "无限画布 + 小地图", cat: "创意", tag: "画布",
    desc: "画布可无限延展，滚轮缩放、拖拽平移；右下角小地图全局导航。",
    goal: "管理海量文件时不丢失空间感；缩放/平移操作占比下降，定位效率提升。",
    logic: ["在画布空白处拖拽平移视图", "滚轮缩放（以光标为中心）", "右下角小地图显示全局与视口框", "点击小地图任意处跳转视口"],
    render: function (area) {
      var wrap = h("div", { class: "mini-canvas", style: "overflow:hidden;" });
      var layer = h("div", { style: "position:absolute;left:0;top:0;width:2000px;height:1600px;transform-origin:0 0;" });
      wrap.appendChild(layer);
      var files = App.data.files;
      var off = { x: 0, y: 0 }, scale = 1;
      files.forEach(function (n) { var el = h("div", { class: "mini-node", style: "left:" + (n.x * 1.6) + "px;top:" + (n.y * 1.6) + "px;" }, h("div", { class: "mn-badge" }, n.type), h("div", { class: "mn-name" }, n.name)); layer.appendChild(el); });
      var mm = h("div", { class: "lab-minimap" });
      files.forEach(function (n) { mm.appendChild(h("div", { class: "mm-node", style: "left:" + (n.x / 840 * 140) + "px;top:" + (n.y / 844 * 90) + "px;" })); });
      var mv = h("div", { class: "mm-view", style: "left:0;top:0;width:60px;height:48px;" }); mm.appendChild(mv);
      wrap.appendChild(mm);
      function apply() { layer.style.transform = "translate(" + off.x + "px," + off.y + "px) scale(" + scale + ")"; mv.style.left = (-off.x / (2000) * 140) + "px"; mv.style.top = (-off.y / 1600 * 90) + "px"; mv.style.width = (460 / 2000 * 140 / scale) + "px"; mv.style.height = (460 / 1600 * 90 / scale) + "px"; }
      var pan = null;
      wrap.addEventListener("pointerdown", function (e) { if (e.target === mm || mm.contains(e.target)) return; pan = { sx: e.clientX, sy: e.clientY, ox: off.x, oy: off.y }; wrap.setPointerCapture(e.pointerId); });
      wrap.addEventListener("pointermove", function (e) { if (!pan) return; off.x = pan.ox + (e.clientX - pan.sx); off.y = pan.oy + (e.clientY - pan.sy); apply(); });
      wrap.addEventListener("pointerup", function () { pan = null; });
      wrap.addEventListener("wheel", function (e) { e.preventDefault(); scale = Math.max(0.4, Math.min(2.2, scale - e.deltaY * 0.001)); apply(); }, { passive: false });
      mm.addEventListener("pointerdown", function (e) { var r = mm.getBoundingClientRect(); var px = (e.clientX - r.left) / 140, py = (e.clientY - r.top) / 90; off.x = -px * 2000 + 230; off.y = -py * 1600 + 230; apply(); });
      area.appendChild(wrap);
      area.appendChild(h("div", { class: "lab-hint" }, "拖拽空白处平移，滚轮缩放；点击小地图跳转。TODO（真实）：虚拟化渲染以支持十万级节点。"));
    }
  });

  /* ---------- C4 空间锚点记忆 ---------- */
  F.push({
    id: "anchors", title: "空间锚点记忆", cat: "创意", tag: "画布",
    desc: "保存当前排布为「锚点」，一键恢复某布局「星座」。",
    goal: "个人化工作空间，让用户快速进入心流状态；多场景（评审/写作）布局一键切换。",
    logic: ["拖动节点到满意位置", "点「保存当前为锚点」命名保存", "点已有锚点按钮恢复对应布局（带动画）", "不同任务切换不同空间上下文"],
    render: function (area) {
      var files = App.data.files.map(function (n) { return { id: n.id, name: n.name, type: n.type, meta: n.meta, x: n.x, y: n.y }; });
      var ws = miniWorkspace(area, files, App.data.connections.map(function (p) { return [p[0], p[1]]; }), { draggable: true });
      var anchors = App.labData.anchors.slice();
      var row = h("div", { class: "lab-row" }, h("span", { class: "lab-label" }, "已存锚点："));
      anchors.forEach(function (a) { row.appendChild(h("button", { class: "lab-btn ghost", onclick: function () { restore(a.layout); } }, "⚓ " + a.name)); });
      row.appendChild(h("button", { class: "lab-btn primary", onclick: function () { var nm = prompt("锚点名称", "我的视图" + (anchors.length + 1)); if (!nm) return; var lay = {}; files.forEach(function (n) { lay[n.id] = { x: n.x, y: n.y }; }); anchors.push({ name: nm, layout: lay }); var b = h("button", { class: "lab-btn ghost", onclick: function () { restore(lay); } }, "⚓ " + nm); row.insertBefore(b, row.lastChild); App.toast("已保存锚点：" + nm); } }, "+ 保存当前"));
      area.insertBefore(row, area.firstChild);
      function restore(lay) { files.forEach(function (n) { if (!lay[n.id]) return; n.x = lay[n.id].x; n.y = lay[n.id].y; var m = ws.map[n.id]; m.el.style.left = (n.x * SCALE) + "px"; m.el.style.top = (n.y * SCALE) + "px"; m.x = n.x; m.y = n.y; }); ws.drawLinks(); App.toast("已恢复布局"); }
    }
  });

  /* ---------- C5 画布模板 ---------- */
  F.push({
    id: "templates", title: "画布模板", cat: "创意", tag: "画布",
    desc: "预置「项目启动 / 读书笔记 / 研究调研」等模板，一键生成结构化画布。",
    goal: "从空白到结构化，降低启动成本；新用户首屏即用，冷启动时间下降。",
    logic: ["画廊选择一类模板", "点「生成」用模板节点骨架替换画布", "模板含示例节点与关联", "可在此基础上继续编辑"],
    render: function (area) {
      var grid = h("div", { class: "lab-row" });
      App.labData.templates.forEach(function (t) {
        var card = h("div", { class: "lab-card", style: "width:200px;cursor:pointer;" },
          h("div", { class: "lab-card-title" }, t.name), h("div", { class: "lab-card-desc" }, t.desc),
          h("button", { class: "lab-btn primary", style: "margin-top:8px;", onclick: function () { gen(t); } }, "生成画布"));
        grid.appendChild(card);
      });
      area.appendChild(grid);
      var wsArea = h("div"); area.appendChild(wsArea);
      function gen(t) { wsArea.innerHTML = ""; var files = t.nodes.map(function (n) { return { id: n.id, name: n.name, type: n.type, meta: "", x: n.x, y: n.y }; }); var ws = miniWorkspace(wsArea, files, t.links, { draggable: true }); App.toast("已生成模板：" + t.name); }
      area.appendChild(h("div", { class: "lab-hint" }, "TODO（真实）：模板库云端同步 + 用户自定义模板。"));
    }
  });

  /* ---------- C6 AI 语义关联推荐 ---------- */
  F.push({
    id: "ai-links", title: "AI 语义关联推荐", cat: "创意", tag: "AI",
    desc: "AI 分析内容相似度，推荐「你可能想关联的文件」，一键连接。",
    goal: "让隐性关系显性化，自动织网；关联覆盖率提升，用户手动连线减少。",
    logic: ["在左侧选一个文件", "右侧面板按相似度列出候选文件", "点「连接」建立关联（画布实时出现连线）", "点「忽略」剔除误推荐"],
    render: function (area) {
      var ws = miniWorkspace(area, App.data.files.map(function (n) { return { id: n.id, name: n.name, type: n.type, meta: n.meta, x: n.x, y: n.y }; }), App.data.connections.map(function (p) { return [p[0], p[1]]; }), { onSelect: select });
      var panel = h("div", { class: "lab-panel" }, h("h4", {}, "AI 关联推荐"));
      area.appendChild(panel);
      function select(id) {
        ws.setSelected(id);
        panel.innerHTML = ""; panel.appendChild(h("h4", {}, "AI 关联推荐 · " + App.data.byId[id].name));
        var sug = App.labData.aiSuggestions[id] || [];
        if (!sug.length) { panel.appendChild(h("div", { class: "lab-hint" }, "暂无推荐")); return; }
        sug.forEach(function (s) {
          var n = App.data.byId[s.id];
          var item = h("div", { class: "sug-item" },
            h("div", { class: "si-top" }, h("span", { class: "si-name" }, n.name), h("span", { class: "si-sim" }, "相似 " + s.sim + "%")),
            h("div", { class: "sim-bar" }, h("i", { style: "width:" + s.sim + "%" })),
            h("div", { class: "lab-row", style: "margin:8px 0 0;" },
              h("button", { class: "lab-btn primary", style: "height:28px;", onclick: function () { var ex = App.data.connections.some(function (p) { return (p[0] === id && p[1] === s.id) || (p[0] === s.id && p[1] === id); }); if (!ex) App.data.connections.push([id, s.id]); ws.setLinks(App.data.connections.map(function (p) { return [p[0], p[1]]; })); App.toast("已关联：" + n.name); } }, "连接"),
              h("button", { class: "lab-btn ghost", style: "height:28px;", onclick: function () { item.remove(); } }, "忽略"))
          );
          panel.appendChild(item);
        });
      }
      select("B");
      area.appendChild(h("div", { class: "lab-hint" }, "TODO（真实）：接入 embedding 向量相似度（LangChain + 向量库）替换模拟分数。"));
    }
  });

  /* ---------- C7 AI 跨文件问答 ---------- */
  F.push({
    id: "ai-chat", title: "AI 跨文件问答", cat: "创意", tag: "AI",
    desc: "右侧聊天栏提问，AI 跨文件回答并标注出处来源。",
    goal: "从被动浏览到主动问答；回答可追溯，用户找信息时间大幅下降。",
    logic: ["在输入框提问（如『项目有哪些风险？』）", "AI 流式返回答案", "答案下方列出引用来源卡片", "点来源跳转到对应文件详情"],
    render: function (area) {
      var box = h("div", { class: "lab-chat" });
      var msgs = h("div", { class: "lab-msgs" });
      var input = h("input", { class: "lab-input", placeholder: "问点什么…（试试『项目有哪些风险？』）" });
      var send = h("button", { class: "lab-btn primary", onclick: send }, "发送");
      box.appendChild(msgs); box.appendChild(h("div", { class: "lab-input-row" }, input, send));
      area.appendChild(box);
      function addQ(t) { msgs.appendChild(h("div", { class: "lab-msg q" }, t)); }
      function addA(t, refs) {
        var m = h("div", { class: "lab-msg a" }, t);
        if (refs && refs.length) { var rf = h("div", { class: "lab-refs" }); refs.forEach(function (id) { rf.appendChild(h("span", { class: "lab-ref", onclick: function () { App.router.go("#/detail/" + id); } }, "📄 " + (App.data.byId[id] ? App.data.byId[id].name : id))); }); m.appendChild(rf); }
        msgs.appendChild(m); msgs.scrollTop = msgs.scrollHeight;
      }
      function send() {
        var t = input.value.trim(); if (!t) return; addQ(t); input.value = "";
        var seed = App.labData.chatSeed.find(function (c) { return c.q === t; });
        var loading = h("div", { class: "lab-msg a" }, "AI 思考中…"); msgs.appendChild(loading); msgs.scrollTop = msgs.scrollHeight;
        var req = (App.ai && App.ai.chat) ? App.ai.chat(t, App.data.files, App.remoteWorkspaceId) : Promise.reject(new Error("no ai client"));
        req.then(function (result) {
          loading.remove();
          var refs = (result.citations || []).map(function (c) { return c.fileId || c.id; });
          addA(result.answer, refs);
        }).catch(function () {
          ai(350, function () { loading.remove(); if (seed) addA(seed.a, seed.refs); else addA("（演示）AI 服务不可用，返回模拟答案。启动 backend 后将自动使用 LangChain 检索回答。", ["A", "B"]); });
        });
      }
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });
      // 预置示例
      App.labData.chatSeed.forEach(function (c) { addQ(c.q); addA(c.a, c.refs); });
    }
  });

  /* ---------- C8 AI 摘要胶囊 ---------- */
  F.push({
    id: "ai-capsule", title: "AI 摘要胶囊", cat: "创意", tag: "AI",
    desc: "悬停节点浮层显示关键实体 / 待办 / 结论，秒懂内容。",
    goal: "减少打开成本，概览效率提升；用户平均少打开 60% 的文件即可获取要点。",
    logic: ["将鼠标悬停在任意文件节点上", "浮层胶囊显示 AI 提取的实体 / 待办 / 结论", "移开鼠标胶囊消失", "点节点进入详情看全文"],
    render: function (area) {
      var ws = miniWorkspace(area, App.data.files.map(function (n) { return { id: n.id, name: n.name, type: n.type, meta: n.meta, x: n.x, y: n.y }; }), App.data.connections.map(function (p) { return [p[0], p[1]]; }), { onSelect: function (id) { App.router.go("#/detail/" + id); } });
      ws.wrap.querySelectorAll(".mini-node").forEach(function (el) {
        el.addEventListener("mouseenter", function () {
          var n = App.data.byId[el.dataset.id];
          var cap = h("div", { class: "lab-sticky", style: "position:absolute;left:" + (parseFloat(el.style.left) + 130) + "px;top:" + el.style.top + ";width:180px;background:#eef5ff;color:#1d1d1f;z-index:30;" },
            h("div", { style: "font-weight:600;margin-bottom:4px;" }, "🧠 " + n.name),
            h("div", {}, "实体：" + (n.tags.map(function (t) { return t.t; }).join("、") || "—")),
            h("div", {}, "结论：" + n.summary.split("\n")[0].slice(0, 40) + "…"),
            h("div", {}, "待办：接入 LangChain 抽取"));
          ws.wrap.appendChild(cap); el._cap = cap;
        });
        el.addEventListener("mouseleave", function () { if (el._cap) { el._cap.remove(); el._cap = null; } });
      });
      area.appendChild(h("div", { class: "lab-hint" }, "将鼠标移到节点上查看 AI 摘要胶囊。TODO（真实）：由 LangChain 结构化抽取实体 / 待办 / 结论。"));
    }
  });

  /* ---------- C9 智能标签推荐 ---------- */
  F.push({
    id: "ai-tags", title: "智能标签推荐", cat: "创意", tag: "AI",
    desc: "上传后 AI 建议标签，确认 / 编辑 / 新增，零维护元数据。",
    goal: "元数据自动化；标签覆盖率 100%，用户手动打标时间趋近于零。",
    logic: ["选择一个文件", "AI 给出建议标签（可勾选）", "点「应用」写入文件标签", "可手动增删标签"],
    render: function (area) {
      var files = App.data.files;
      var sel = h("select", { class: "lab-input", style: "width:220px;" });
      files.forEach(function (n) { sel.appendChild(h("option", { value: n.id }, n.name)); });
      area.appendChild(h("div", { class: "lab-row" }, h("span", { class: "lab-label" }, "选择文件："), sel));
      var panel = h("div", { class: "lab-panel", style: "position:relative;width:100%;height:auto;border:none;padding:0;" });
      area.appendChild(panel);
      function renderTags(id) {
        var n = App.data.byId[id];
        var sug = App.labData.tagSuggest[n.name] || ["通用", "待分类"];
        panel.innerHTML = ""; panel.appendChild(h("h4", {}, "AI 建议标签"));
        var chosen = {};
        sug.forEach(function (t) { chosen[t] = true; var p = h("div", { class: "lab-row", style: "margin:4px 0;" }, h("input", { type: "checkbox", checked: "checked", onchange: function (e) { chosen[t] = e.target.checked; } }), h("span", {}, t)); panel.appendChild(p); });
        panel.appendChild(h("button", { class: "lab-btn ghost", onclick: function () {
          if (!App.ai) return;
          App.ai.tags(n.name, n.content || n.summary).then(function (result) {
            result.tags.forEach(function (t) { chosen[t] = true; panel.insertBefore(h("div", { class: "lab-row", style: "margin:4px 0;" }, h("input", { type: "checkbox", checked: "checked", onchange: function (e) { chosen[t] = e.target.checked; } }), h("span", {}, t)), panel.lastElementChild); });
            App.toast(result.mode === "langchain" ? "已生成 LangChain 标签" : "已生成演示标签");
          }).catch(function () { App.toast("AI 服务暂不可用，保留现有建议"); });
        } }, "重新生成"));
        panel.appendChild(h("button", { class: "lab-btn primary", onclick: function () { var add = Object.keys(chosen).filter(function (k) { return chosen[k]; }); n.tags = add.map(function (t) { return { t: t, c: "blue" }; }); App.toast("已应用标签：" + add.join("、")); } }, "应用标签"));
      }
      sel.addEventListener("change", function () { renderTags(sel.value); });
      renderTags(files[0].id);
      area.appendChild(h("div", { class: "lab-hint" }, "TODO（真实）：接入分类模型 / LLM 零样本打标。"));
    }
  });

  /* ---------- C10 AI 封面生成 ---------- */
  F.push({
    id: "ai-cover", title: "AI 封面生成", cat: "创意", tag: "AI",
    desc: "为文件夹 / 文档一键生成视觉封面，快速识别。",
    goal: "视觉化记忆；文件识别速度提升，工作区更具归属感。",
    logic: ["选择一个文件夹 / 文档", "点「生成封面」", "AI 模拟出图（渐变 + 图标）", "封面填充到节点 / 卡片"],
    render: function (area) {
      var files = App.data.files.filter(function (n) { return n.type === "DIR" || n.type === "DOC" || n.type === "PDF"; });
      var sel = h("select", { class: "lab-input", style: "width:220px;" });
      files.forEach(function (n) { sel.appendChild(h("option", { value: n.id }, n.name)); });
      var cover = h("div", { style: "width:200px;height:140px;border-radius:12px;border:1px dashed var(--border);display:flex;align-items:center;justify-content:center;color:var(--text-2);font-size:13px;" }, "暂无封面");
      var btn = h("button", { class: "lab-btn primary", onclick: gen }, "生成封面 ✨");
      area.appendChild(h("div", { class: "lab-row" }, h("span", { class: "lab-label" }, "选择文件："), sel, btn, cover));
      function gen() {
        btn.textContent = "生成中…"; btn.disabled = true;
        ai(900, function () {
          var grad = "linear-gradient(135deg," + pick() + "," + pick() + ")";
          cover.style.background = grad; cover.style.color = "#fff"; cover.textContent = "🖼 " + App.data.byId[sel.value].name;
          btn.textContent = "重新生成"; btn.disabled = false; App.toast("封面已生成（模拟）");
        });
      }
      function pick() { var c = ["#0066cc", "#5b8def", "#00b894", "#e17055", "#a29bfe", "#fd79a8"]; return c[Math.floor(Math.random() * c.length)]; }
      area.appendChild(h("div", { class: "lab-hint" }, "TODO（真实）：接入文生图模型（如 DALL·E /  Stable Diffusion）生成语义封面。"));
    }
  });

  /* ---------- C11 重复 / 近似检测 ---------- */
  F.push({
    id: "dedup", title: "重复 / 近似检测", cat: "创意", tag: "AI",
    desc: "扫描相似内容，列出重复 / 近似文件对与相似度，一键合并。",
    goal: "清理知识库，避免版本混乱；重复文件减少，存储与认知负担下降。",
    logic: ["点「扫描」", "列出相似文件对及相似度", "点「合并」保留其一并删除副本", "点「忽略」标记为非重复"],
    render: function (area) {
      var list = h("div"); area.appendChild(list);
      var scan = h("button", { class: "lab-btn primary", onclick: doScan }, "扫描重复");
      area.insertBefore(h("div", { class: "lab-row" }, scan), list);
      function doScan() {
        list.innerHTML = ""; scan.textContent = "重新扫描";
        App.labData.duplicates.forEach(function (d) {
          var item = h("div", { class: "sug-item" },
            h("div", { class: "si-top" }, h("span", { class: "si-name" }, d.a + "  ↔  " + d.b), h("span", { class: "si-sim" }, "相似 " + d.sim + "%")),
            h("div", { class: "sim-bar" }, h("i", { style: "width:" + d.sim + "%" })),
            h("div", { class: "lab-row", style: "margin:8px 0 0;" },
              h("button", { class: "lab-btn primary", style: "height:28px;", onclick: function () { item.remove(); App.toast("已合并（模拟）：" + d.a); } }, "合并"),
              h("button", { class: "lab-btn ghost", style: "height:28px;", onclick: function () { item.remove(); App.toast("已忽略"); } }, "忽略"))
          );
          list.appendChild(item);
        });
      }
      doScan();
      area.appendChild(h("div", { class: "lab-hint" }, "TODO（真实）：内容哈希 + 语义向量去重，支持文件夹级比对。"));
    }
  });

  /* ---------- C12 文件健康度评分 ---------- */
  F.push({
    id: "health", title: "文件健康度评分", cat: "创意", tag: "AI",
    desc: "节点角标显示「新鲜度 / 关联度 / 完整度」综合分，点开看维度。",
    goal: "识别陈旧 / 孤立文件，主动维护；知识库健康度可量化、可运营。",
    logic: ["画布节点右上角显示综合分", "点节点展开维度条（新鲜/关联/完整）", "低分文件高亮提示待维护", "据此清理或补充关联"],
    render: function (area) {
      var ws = miniWorkspace(area, App.data.files.map(function (n) { return { id: n.id, name: n.name, type: n.type, meta: n.meta, x: n.x, y: n.y }; }), App.data.connections.map(function (p) { return [p[0], p[1]]; }), { onSelect: show });
      // 角标
      App.data.files.forEach(function (n) { var m = ws.map[n.id]; if (!m) return; var hh = App.labData.health[n.id] || { score: 50 }; var b = h("div", { class: "score-badge" }, String(hh.score)); m.el.appendChild(b); if (hh.score < 50) b.style.background = "#e17055"; });
      var detail = h("div", { class: "lab-panel", style: "position:relative;width:100%;height:auto;border:none;padding:0;" });
      area.appendChild(detail);
      function show(id) { var hh = App.labData.health[id] || { fresh: 50, link: 50, complete: 50, score: 50 }; var n = App.data.byId[id]; detail.innerHTML = ""; detail.appendChild(h("h4", {}, n.name + " · 健康度 " + hh.score)); [["新鲜度", hh.fresh], ["关联度", hh.link], ["完整度", hh.complete]].forEach(function (d) { detail.appendChild(h("div", { class: "dim-bar" }, h("span", { class: "db-label" }, d[0]), h("div", { class: "db-track" }, h("i", { style: "width:" + d[1] + "%" })), h("span", {}, d[1]))); }); }
      show("B");
      area.appendChild(h("div", { class: "lab-hint" }, "TODO（真实）：基于修改时间 / 关联数 / 内容完整性的实时评分模型。"));
    }
  });

  /* ---------- C13 协同光标在场 ---------- */
  F.push({
    id: "presence", title: "协同光标与在场", cat: "创意", tag: "协作",
    desc: "多人同看一画布，看到彼此彩色光标与选区，可「跟随」。",
    goal: "团队知识共建、实时在场感；远程协作同步率提升。",
    logic: ["画布显示多名协作者彩色光标", "光标按随机游走实时移动", "右侧头像列表显示在线成员", "点「跟随」让视口跟随某人光标"],
    render: function (area) {
      var ws = miniWorkspace(area, App.data.files.map(function (n) { return { id: n.id, name: n.name, type: n.type, meta: n.meta, x: n.x, y: n.y }; }), App.data.connections.map(function (p) { return [p[0], p[1]]; }));
      var cs = App.labData.collaborators.map(function (c) { var el = h("div", { style: "position:absolute;pointer-events:none;z-index:40;transition:left .8s linear,top .8s linear;" }, h("div", { style: "width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:10px solid " + c.color + ";" }), h("div", { style: "background:" + c.color + ";color:#fff;font-size:11px;padding:1px 6px;border-radius:6px;margin-top:2px;" }, c.name)); ws.wrap.appendChild(el); return { c: c, el: el, x: c.x, y: c.y }; });
      var avatars = h("div", { class: "lab-row" });
      cs.forEach(function (o, i) { avatars.appendChild(h("button", { class: "lab-btn ghost", onclick: function () { follow(i); } }, "👤 " + o.c.name + " 跟随")); });
      area.insertBefore(avatars, area.firstChild);
      function step() { cs.forEach(function (o) { o.x = Math.max(10, Math.min(780, o.x + (Math.random() * 80 - 40))); o.y = Math.max(10, Math.min(420, o.y + (Math.random() * 80 - 40))); o.el.style.left = o.x + "px"; o.el.style.top = o.y + "px"; }); }
      var timer = setInterval(step, 800);
      function follow(i) { App.toast("跟随 " + cs[i].c.name + "（演示）"); }
      area.appendChild(h("div", { class: "lab-hint" }, "光标实时游走模拟多人协作。TODO（真实）：WebSocket / CRDT 实时同步光标与操作。"));
      // 离开时清理
      var obs = new MutationObserver(function () {}); 
      setTimeout(function () { clearInterval(timer); }, 60000);
    }
  });

  /* ---------- C14 批注便签 ---------- */
  F.push({
    id: "sticky", title: "批注便签", cat: "创意", tag: "协作",
    desc: "在画布任意处贴便签、圈画批注，可 @ 提及、移动、删除。",
    goal: "上下文讨论、沉淀决策；评论与文件空间绑定，决策可追溯。",
    logic: ["点「＋便签」进入贴纸模式", "在画布点击落点生成可编辑便签", "输入内容，支持 @ 提及高亮", "便签可拖拽移动、可删除"],
    render: function (area) {
      var ws = miniWorkspace(area, App.data.files.map(function (n) { return { id: n.id, name: n.name, type: n.type, meta: n.meta, x: n.x, y: n.y }; }), App.data.connections.map(function (p) { return [p[0], p[1]]; }));
      var notes = [];
      var addBtn = h("button", { class: "lab-btn primary", onclick: function () { placing = true; addBtn.textContent = "点击画布落点…"; } }, "＋ 便签");
      area.insertBefore(h("div", { class: "lab-row" }, addBtn), area.firstChild);
      var placing = false;
      ws.wrap.addEventListener("click", function (e) { if (!placing) return; if (e.target !== ws.wrap && e.target !== ws.svg) return; var r = ws.wrap.getBoundingClientRect(); var x = e.clientX - r.left, y = e.clientY - r.top; placing = false; addBtn.textContent = "＋ 便签"; makeNote(x, y); });
      function makeNote(x, y) {
        var tx = h("div", { contentEditable: "true", style: "outline:none;min-height:40px;" }, "输入批注… @某人");
        var note = h("div", { class: "lab-sticky", style: "left:" + x + "px;top:" + y + "px;" }, h("span", { class: "st-del", onclick: function () { note.remove(); notes.splice(notes.indexOf(note), 1); } }, "×"), tx);
        ws.wrap.appendChild(note); notes.push(note);
        var d = null;
        note.addEventListener("pointerdown", function (e) { if (e.target === note.querySelector(".st-del")) return; e.preventDefault(); d = { sx: e.clientX, sy: e.clientY, ox: parseFloat(note.style.left), oy: parseFloat(note.style.top) }; note.setPointerCapture(e.pointerId); });
        note.addEventListener("pointermove", function (e) { if (!d) return; note.style.left = (d.ox + e.clientX - d.sx) + "px"; note.style.top = (d.oy + e.clientY - d.sy) + "px"; });
        note.addEventListener("pointerup", function (e) { if (d) note.releasePointerCapture(e.pointerId); d = null; });
        tx.addEventListener("input", function () { tx.innerHTML = tx.textContent.replace(/(@\S+)/g, '<span class="st-at">$1</span>'); });
      }
      area.appendChild(h("div", { class: "lab-hint" }, "点「＋便签」后在画布点击落点；便签可拖拽、@提及、删除。TODO（真实）：便签持久化 + 评论线程。"));
    }
  });

  /* ---------- C15 分享权限 ---------- */
  F.push({
    id: "share", title: "分享与权限", cat: "创意", tag: "协作",
    desc: "生成分享链接，设只读 / 可编辑权限与过期时间，安全对外协作。",
    goal: "安全对外协作；分享可控、可撤销，泄露风险下降。",
    logic: ["选择文件点「生成链接」", "显示只读 / 可编辑权限选择", "设置过期时间", "复制链接分享；可随时撤销"],
    render: function (area) {
      var sel = h("select", { class: "lab-input", style: "width:200px;" });
      App.data.files.forEach(function (n) { sel.appendChild(h("option", { value: n.id }, n.name)); });
      var perm = h("select", { class: "lab-input", style: "width:140px;" }, h("option", {}, "只读"), h("option", {}, "可编辑"));
      var exp = h("select", { class: "lab-input", style: "width:140px;" }, h("option", {}, "7 天"), h("option", {}, "24 小时"), h("option", {}, "永久"));
      var box = h("div", { class: "lab-link-box" }, "点击「生成链接」获取分享地址");
      var gen = h("button", { class: "lab-btn primary", onclick: function () { var link = "https://filehub.app/s/" + Math.random().toString(36).slice(2, 10); box.textContent = link; App.toast("已生成 " + perm.value + " 链接（" + exp.value + "）"); } }, "生成链接");
      var copy = h("button", { class: "lab-btn ghost", onclick: function () { App.toast("已复制链接（模拟）"); } }, "复制");
      area.appendChild(h("div", { class: "lab-row" }, h("span", { class: "lab-label" }, "文件："), sel, perm, exp, gen, copy));
      area.appendChild(box);
      area.appendChild(h("div", { class: "lab-hint" }, "TODO（真实）：后端签发带权限 / 过期的签名 URL + 访问审计。"));
    }
  });

  /* ---------- C16 双向链接 / 反向链接 ---------- */
  F.push({
    id: "backlinks", title: "双向链接与反向链接", cat: "创意", tag: "知识",
    desc: "正文用 [[文件名]] 引用；右侧反向链接面板列出「谁引用了我」。",
    goal: "构建个人知识网络（Obsidian 式）；文件间关系可双向追溯。",
    logic: ["选择一个文件", "预览其正文中的 [[引用]]", "右侧面板列出反向链接（谁引用了我）", "点反向链接跳转到来源文件"],
    render: function (area) {
      var sel = h("select", { class: "lab-input", style: "width:200px;" });
      App.data.files.forEach(function (n) { sel.appendChild(h("option", { value: n.id }, n.name)); });
      var main = h("div", { style: "flex:1;background:var(--tag-gray-bg);border-radius:10px;padding:14px;font-size:13px;line-height:1.7;white-space:pre-wrap;" });
      var back = h("div", { class: "lab-panel", style: "position:relative;width:240px;height:auto;border:none;padding:0 0 0 16px;" }, h("h4", {}, "反向链接"));
      area.appendChild(h("div", { class: "lab-row" }, h("span", { class: "lab-label" }, "文件："), sel));
      var row = h("div", { style: "display:flex;gap:16px;" }, main, back); area.appendChild(row);
      function show(id) { var n = App.data.byId[id]; main.textContent = n.content; back.innerHTML = "<h4>反向链接</h4>"; var refs = App.labData.backlinks[id] || []; if (!refs.length) back.appendChild(h("div", { class: "lab-hint" }, "暂无文件引用它")); refs.forEach(function (name) { var src = App.data.files.find(function (f) { return f.name === name; }); back.appendChild(h("div", { class: "sug-item", style: "cursor:pointer;", onclick: function () { if (src) App.router.go("#/detail/" + src.id); } }, "← " + name)); }); }
      sel.addEventListener("change", function () { show(sel.value); }); show(App.data.files[0].id);
      area.appendChild(h("div", { class: "lab-hint" }, "正文中的 [[名称]] 即为双向链接。TODO（真实）：解析引用图谱 + 自动维护反向索引。"));
    }
  });

  /* ---------- C17 关系图谱视图 ---------- */
  F.push({
    id: "graph", title: "关系图谱视图", cat: "创意", tag: "知识",
    desc: "所有文件 + 关联渲染成力导向知识图谱，脱离空间束缚看全局。",
    goal: "全局视野发现隐藏关联；跨聚类洞察，知识网络一目了然。",
    logic: ["切到图谱模式，节点力导向布局", "连线表达关联，簇代表主题社区", "拖拽节点调整布局", "点节点进入文件详情"],
    render: function (area) {
      var wrap = h("div", { class: "mini-canvas", style: "height:460px;" });
      var svg = document.createElementNS(SVGNS, "svg"); svg.setAttribute("class", "graph-svg"); wrap.appendChild(svg);
      area.appendChild(wrap);
      var files = App.data.files, links = App.data.connections;
      var P = {}; files.forEach(function (n, i) { P[n.id] = { x: 200 + Math.cos(i / files.length * 6.28) * 150, y: 200 + Math.sin(i / files.length * 6.28) * 150, vx: 0, vy: 0, el: null }; });
      function draw() {
        svg.innerHTML = "";
        links.forEach(function (l) { var a = P[l[0]], b = P[l[1]]; if (!a || !b) return; var ln = document.createElementNS(SVGNS, "line"); ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y); ln.setAttribute("x2", b.x); ln.setAttribute("y2", b.y); ln.style.stroke = "var(--blue)"; ln.setAttribute("stroke-width", "2"); ln.setAttribute("stroke-dasharray", "5 4"); svg.appendChild(ln); });
        files.forEach(function (n) { var p = P[n.id]; var g = document.createElementNS(SVGNS, "g"); g.setAttribute("class", "graph-node"); g.setAttribute("transform", "translate(" + p.x + "," + p.y + ")"); var c = document.createElementNS(SVGNS, "circle"); c.setAttribute("r", "22"); g.appendChild(c); var t = document.createElementNS(SVGNS, "text"); t.setAttribute("y", "38"); t.textContent = n.name.length > 6 ? n.name.slice(0, 6) + "…" : n.name; g.appendChild(t); g.addEventListener("click", function () { App.router.go("#/detail/" + n.id); }); g.addEventListener("pointerdown", function (e) { drag = n.id; g.setPointerCapture(e.pointerId); }); g.addEventListener("pointermove", function (e) { if (drag !== n.id) return; var r = svg.getBoundingClientRect(); P[n.id].x = e.clientX - r.left; P[n.id].y = e.clientY - r.top; draw(); }); g.addEventListener("pointerup", function () { drag = null; }); svg.appendChild(g); });
      }
      var drag = null, tick = 0;
      function physics() {
        files.forEach(function (a) { files.forEach(function (b) { if (a === b) return; var dx = P[a.id].x - P[b.id].x, dy = P[a.id].y - P[b.id].y; var d = Math.sqrt(dx * dx + dy * dy) || 1; var f = 600 / (d * d); P[a.id].vx -= dx / d * f; P[a.id].vy -= dy / d * f; }); });
        links.forEach(function (l) { var a = P[l[0]], b = P[l[1]]; if (!a || !b) return; var dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1; var f = (d - 130) * 0.02; a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f; });
        files.forEach(function (n) { var p = P[n.id]; p.vx *= 0.85; p.vy *= 0.85; p.x += p.vx; p.y += p.vy; p.x = Math.max(30, Math.min(740, p.x)); p.y = Math.max(30, Math.min(430, p.y)); });
        draw(); if (tick++ < 400) requestAnimationFrame(physics);
      }
      draw(); physics();
      area.appendChild(h("div", { class: "lab-hint" }, "节点力导向自动成图，可拖拽。TODO（真实）：社区发现算法 + 大规模图渲染。"));
    }
  });

  /* ---------- C18 智能收藏夹 ---------- */
  F.push({
    id: "smart-fav", title: "智能收藏夹", cat: "创意", tag: "知识",
    desc: "收藏夹分「手动」与「AI 常驻」（按访问频率自动置顶）。",
    goal: "快速回到重要文件；常用文件触达时间缩短。",
    logic: ["手动收藏的文件归入「手动」区", "AI 按访问频率自动置顶「常驻」区", "点击文件跳转详情", "可取消收藏 / 移出常驻"],
    render: function (area) {
      var manual = App.data.files.filter(function (n) { return n.favorite; });
      var smart = App.labData.smartFavorites.map(function (id) { return App.data.byId[id]; }).filter(Boolean);
      function sec(title, arr) { var s = h("div", { class: "lab-section-title" }, title); area.appendChild(s); var grid = h("div", { class: "lab-grid", style: "grid-template-columns:repeat(4,1fr);" }); arr.forEach(function (n) { grid.appendChild(h("div", { class: "lab-card", onclick: function () { App.router.go("#/detail/" + n.id); } }, h("div", { class: "lab-card-title" }, n.name), h("div", { class: "lab-card-foot" }, n.type))); }); area.appendChild(grid); }
      sec("⭐ 手动收藏", manual.length ? manual : [{ name: "（暂无）", type: "" }]);
      sec("🤖 AI 常驻（按访问频率）", smart);
      area.appendChild(h("div", { class: "lab-hint" }, "TODO（真实）：埋点统计访问频率，定时重算常驻列表。"));
    }
  });

  /* ---------- C19 全文检索高亮 ---------- */
  F.push({
    id: "fulltext", title: "全文检索高亮", cat: "创意", tag: "知识",
    desc: "搜正文内容，结果列表 + 画布节点闪烁定位 + 命中高亮。",
    goal: "大海捞针；跨文件内容检索命中率与速度提升。",
    logic: ["在搜索框输入关键词", "匹配文件名 / 摘要 / 正文", "结果列表展示命中片段（高亮）", "点结果画布节点闪烁定位"],
    render: function (area) {
      var input = h("input", { class: "lab-input", placeholder: "搜索正文，如『架构』『LangChain』…" });
      var list = h("div"); area.appendChild(h("div", { class: "lab-row" }, input, list));
      var ws = miniWorkspace(area, App.data.files.map(function (n) { return { id: n.id, name: n.name, type: n.type, meta: n.meta, x: n.x, y: n.y }; }), App.data.connections.map(function (p) { return [p[0], p[1]]; }), { onSelect: function (id) { App.router.go("#/detail/" + id); } });
      function search(q) {
        q = q.trim().toLowerCase(); list.innerHTML = "";
        if (!q) return;
        App.data.files.forEach(function (n) {
          var hay = (n.name + " " + n.summary + " " + n.content).toLowerCase();
          var idx = hay.indexOf(q); if (idx < 0) { ws.map[n.id].el.classList.add("dim"); return; }
          ws.map[n.id].el.classList.remove("dim");
          var snip = (n.name + " " + n.summary + " " + n.content).slice(Math.max(0, idx - 20), idx + 40);
          var item = h("div", { class: "sug-item", style: "cursor:pointer;", onclick: function () { ws.flash(n.id); } });
          item.innerHTML = "<div class='si-name'>" + n.name + "</div><div style='font-size:12px;color:var(--text-body);'>" + snip.replace(new RegExp(q, "ig"), "<span class='lab-mark'>$&</span>") + "</div>";
          list.appendChild(item);
        });
      }
      input.addEventListener("input", function () { search(input.value); });
      area.appendChild(h("div", { class: "lab-hint" }, "输入关键词，命中文件在画布高亮、列表展示片段。TODO（真实）：接入全文索引（如 ElasticSearch / PostgreSQL FTS）。"));
    }
  });

  /* ---------- C20 PWA 离线优先 ---------- */
  F.push({
    id: "pwa", title: "PWA 离线优先", cat: "创意", tag: "系统",
    desc: "Service Worker + 本地存储，离线打开、改动本地优先同步。",
    goal: "随时随地可用、数据不丢；离线可用率 100%，弱网体验无缝。",
    logic: ["切换「离线模式」观察状态变化", "离线时改动写入本地存储", "恢复网络后本地优先同步", "可「安装到本地」常驻桌面"],
    render: function (area) {
      var online = navigator.onLine;
      var sw = h("div", { class: "switch", onclick: function () { sw.classList.toggle("on"); status.textContent = sw.classList.contains("on") ? "离线模式：已启用本地缓存（演示）" : "在线模式"; } }, h("i"));
      var status = h("span", { class: "lab-label" }, online ? "当前网络：在线" : "当前网络：离线");
      window.addEventListener("online", function () { status.textContent = "当前网络：在线"; });
      window.addEventListener("offline", function () { status.textContent = "当前网络：离线"; });
      area.appendChild(h("div", { class: "lab-row" }, h("span", { class: "lab-label" }, "离线模式"), sw, status));
      area.appendChild(h("div", { class: "lab-row" }, h("button", { class: "lab-btn ghost", onclick: function () { App.toast("已安装到本地（演示 · 需 SW + manifest）"); } }, "安装到本地 📲"), h("button", { class: "lab-btn ghost", onclick: function () { var k = "filehub_cache_v1"; try { localStorage.setItem(k, JSON.stringify({ ts: Date.now(), files: App.data.files.length })); App.toast("已写入本地缓存"); } catch (e) {} } }, "写入本地缓存")));
      area.appendChild(h("div", { class: "lab-hint" }, "演示离线状态切换与本地缓存写入。TODO（真实）：service-worker.js + manifest.webmanifest + 后台同步（Background Sync）。"));
    }
  });

  /* ---------- 画廊 + 详情渲染 ---------- */
  var byId = {};
  F.forEach(function (f) { byId[f.id] = f; });

  function renderGallery(container) {
    var wrap = h("div", { class: "lab-wrap" });
    wrap.appendChild(h("div", { class: "lab-head" }, h("div", { class: "lab-title" }, "功能实验室"), h("span", { class: "lab-cat 创意" }, "创意 " + F.filter(function (f) { return f.cat === "创意"; }).length + " 项")));
    wrap.appendChild(h("div", { class: "lab-desc" }, "20 个功能均可直接交互。文件、画布、搜索、摘要、标签、问答、上传、回收站和导出已接入 Docker API；协同、OCR、向量检索和高级渲染在服务不可用时使用本地降级。"));
    [["创意", "🧪 创意功能"], ["必备", "⚙️ 必备功能（已集成进外壳）"]].forEach(function (grp) {
      var items = F.filter(function (f) { return f.cat === grp[0]; });
      wrap.appendChild(h("div", { class: "lab-section-title" }, grp[1]));
      var grid = h("div", { class: "lab-grid" });
      items.forEach(function (f) {
        grid.appendChild(h("div", { class: "lab-card", onclick: function () { location.hash = "#/lab/" + f.id; } },
          h("div", { class: "lab-card-top" }, h("div", { class: "lab-card-title" }, f.title), h("span", { class: "lab-cat " + f.cat }, f.cat)),
          h("div", { class: "lab-card-desc" }, f.desc),
          h("div", { class: "lab-card-foot" }, "#" + f.id + " · 点击体验 →")));
      });
      wrap.appendChild(grid);
    });
    container.appendChild(wrap);
  }

  function renderFeature(container, id) {
    var f = byId[id];
    if (!f) { container.appendChild(h("div", { class: "lab-wrap" }, h("div", { class: "lab-title" }, "未找到该功能"))); return; }
    var wrap = h("div", { class: "lab-wrap" });
    wrap.appendChild(h("div", { class: "lab-head" },
      h("span", { class: "lab-back", onclick: function () { location.hash = "#/lab"; } }, "← 功能实验室"),
      h("div", { class: "lab-title" }, f.title),
      h("span", { class: "lab-cat " + f.cat }, f.cat)));
    wrap.appendChild(h("div", { class: "lab-desc" }, f.desc));
    wrap.appendChild(h("div", { class: "lab-goal", html: "<b>最终目标：</b>" + f.goal }));
    var logic = h("div", { class: "lab-logic" }, h("div", { class: "ll-title" }, "交互逻辑"));
    var ol = h("ol"); f.logic.forEach(function (s) { ol.appendChild(h("li", {}, s)); }); logic.appendChild(ol); wrap.appendChild(logic);
    var demo = h("div", { class: "lab-demo" }); wrap.appendChild(demo);
    container.appendChild(wrap);
    f.render(demo);
  }

  return { list: F, byId: byId, renderGallery: renderGallery, renderFeature: renderFeature };
})();
