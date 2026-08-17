/* ===================================================================
   FileHub · 功能实验室模拟数据（不接真实后端，仅供前端原型驱动）
   真实接入点统一标注 TODO：LangChain / 文件系统 / 协同 WebSocket / 向量库
   =================================================================== */
window.App = window.App || {};

App.labData = (function () {
  // ---------- C2 时间轴回放：文件演进事件 ----------
  var timeline = [
    { day: "第 1 天", type: "add",  nodeId: "A", label: "导入「项目代码」文件夹",        x: 48,  y: 120 },
    { day: "第 1 天", type: "add",  nodeId: "B", label: "上传「需求文档.pdf」",           x: 340, y: 100 },
    { day: "第 2 天", type: "add",  nodeId: "C", label: "添加「README.md」",             x: 610, y: 180 },
    { day: "第 3 天", type: "add",  nodeId: "D", label: "放入「设计方案.docx」",          x: 120, y: 360 },
    { day: "第 3 天", type: "link", a: "A", b: "D", label: "关联 项目代码 ↔ 设计方案" },
    { day: "第 4 天", type: "add",  nodeId: "E", label: "上传「架构图.png」",             x: 470, y: 400 },
    { day: "第 4 天", type: "link", a: "B", b: "C", label: "关联 需求文档 ↔ README" },
    { day: "第 5 天", type: "move", nodeId: "E", label: "移动 架构图 至右下方",          x: 560, y: 540 }
  ];

  // 节点初始坐标（用于回放基线）—— 与 data.js 对齐
  var basePos = {
    A: { x: 48, y: 120 }, B: { x: 340, y: 100 }, C: { x: 610, y: 180 },
    D: { x: 120, y: 360 }, E: { x: 470, y: 400 }
  };

  // ---------- C13 协同在场：模拟协作者 ----------
  var collaborators = [
    { name: "林", color: "#ff6b6b", x: 300, y: 220 },
    { name: "周", color: "#00b894", x: 520, y: 360 },
    { name: "陈", color: "#fdcb6e", x: 200, y: 480 }
  ];

  // ---------- C12 文件健康度评分（新鲜度/关联度/完整度） ----------
  var health = {
    A: { fresh: 90, link: 80, complete: 70, score: 80 },
    B: { fresh: 70, link: 60, complete: 90, score: 73 },
    C: { fresh: 40, link: 50, complete: 60, score: 50 },
    D: { fresh: 55, link: 85, complete: 75, score: 72 },
    E: { fresh: 30, link: 20, complete: 65, score: 38 }
  };

  // ---------- C16 反向链接：谁引用了我 ----------
  var backlinks = {
    A: ["需求文档.pdf", "设计方案.docx"],
    B: ["README.md"],
    C: ["设计方案.docx"],
    D: ["需求文档.pdf"],
    E: []
  };

  // ---------- C11 重复 / 近似文件检测 ----------
  var duplicates = [
    { a: "需求文档.pdf", b: "需求文档_副本.pdf", sim: 96 },
    { a: "架构图.png",   b: "架构图_v2.png",     sim: 82 },
    { a: "README.md",    b: "readme-copy.md",    sim: 71 }
  ];

  // ---------- C4 空间锚点：保存的布局「星座」 ----------
  var anchors = [
    { name: "启动视图", layout: { A: { x: 48, y: 120 }, B: { x: 340, y: 100 }, C: { x: 610, y: 180 }, D: { x: 120, y: 360 }, E: { x: 470, y: 400 } } },
    { name: "评审视图", layout: { A: { x: 120, y: 320 }, B: { x: 420, y: 120 }, C: { x: 660, y: 260 }, D: { x: 320, y: 540 }, E: { x: 580, y: 580 } } }
  ];

  // ---------- C5 画布模板 ----------
  var templates = [
    {
      name: "项目启动", desc: "需求 / 设计 / 代码 / 架构 四类骨架",
      nodes: [
        { id: "t1", name: "需求文档", type: "PDF", x: 120, y: 120 },
        { id: "t2", name: "设计方案", type: "DOC", x: 380, y: 130 },
        { id: "t3", name: "项目代码", type: "DIR", x: 140, y: 360 },
        { id: "t4", name: "系统架构", type: "PNG", x: 400, y: 380 }
      ],
      links: [["t1", "t2"], ["t2", "t4"], ["t3", "t4"]]
    },
    {
      name: "读书笔记", desc: "书目 / 摘录 / 灵感 / 待办",
      nodes: [
        { id: "b1", name: "书目卡片", type: "DOC", x: 120, y: 120 },
        { id: "b2", name: "精彩摘录", type: "MD",  x: 380, y: 130 },
        { id: "b3", name: "灵感便签", type: "PNG", x: 140, y: 360 },
        { id: "b4", name: "行动待办", type: "DOC", x: 400, y: 380 }
      ],
      links: [["b1", "b2"], ["b2", "b3"], ["b3", "b4"]]
    },
    {
      name: "研究调研", desc: "主题 / 文献 / 数据 / 结论",
      nodes: [
        { id: "r1", name: "研究主题", type: "DOC", x: 120, y: 120 },
        { id: "r2", name: "参考文献", type: "PDF", x: 380, y: 130 },
        { id: "r3", name: "实验数据", type: "PNG", x: 140, y: 360 },
        { id: "r4", name: "结论报告", type: "MD",  x: 400, y: 380 }
      ],
      links: [["r1", "r2"], ["r2", "r3"], ["r3", "r4"]]
    }
  ];

  // ---------- C6 AI 语义关联推荐：候选相似文件 ----------
  var aiSuggestions = {
    B: [{ id: "D", sim: 88 }, { id: "A", sim: 72 }, { id: "E", sim: 65 }],
    C: [{ id: "B", sim: 80 }, { id: "D", sim: 68 }],
    A: [{ id: "E", sim: 75 }, { id: "C", sim: 60 }],
    D: [{ id: "B", sim: 90 }, { id: "A", sim: 70 }],
    E: [{ id: "A", sim: 78 }, { id: "D", sim: 55 }]
  };

  // ---------- C7 AI 跨文件问答：示例对话 ----------
  var chatSeed = [
    {
      q: "这个项目目前有哪些主要风险？",
      a: "根据工作区文件，主要风险集中在三点：① 需求文档与设计方案版本不一致（需求 v2.0 / 设计 v1.3）；② 架构图较旧、与最新代码目录存在偏差；③ README 未同步最新启动命令。建议优先对齐需求与设计并刷新架构图。",
      refs: ["B", "D", "E"]
    },
    {
      q: "项目代码里包含哪些模块？",
      a: "项目代码文件夹涵盖：backend（Spring Boot + MyBatis 用户服务）、frontend（React + TypeScript）、deploy（Docker 编排）。三者通过网关串联，部署脚本见 deploy/。",
      refs: ["A"]
    }
  ];

  // ---------- C9 智能标签推荐 ----------
  var tagSuggest = {
    "新上传资料.md": ["报告", "草稿", "待审"],
    "需求文档.pdf":  ["需求", "PRD", "重要"],
    "架构图.png":    ["架构", "总览"]
  };

  // ---------- C18 智能收藏（按访问频率自动置顶） ----------
  var smartFavorites = ["A", "B", "D"];

  return {
    timeline: timeline,
    basePos: basePos,
    collaborators: collaborators,
    health: health,
    backlinks: backlinks,
    duplicates: duplicates,
    anchors: anchors,
    templates: templates,
    aiSuggestions: aiSuggestions,
    chatSeed: chatSeed,
    tagSuggest: tagSuggest,
    smartFavorites: smartFavorites
  };
})();
