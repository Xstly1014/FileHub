/* ===================================================================
   FileHub · 数据模型
   设计蓝图的"后端占位"：所有文件节点、关联、AI 总结、版本均为示例数据。
   TODO: 后续由 LangChain / 真实文件系统接口替换 nodes / connections。
   =================================================================== */
window.App = window.App || {};

App.data = (function () {
  var NODE_W = 150, NODE_H = 96;

  // 文件节点（坐标沿用设计稿在 840x844 画布内的位置）
  var files = [
    {
      id: "A", name: "项目代码", type: "DIR", typeLabel: "文件夹",
      meta: "文件夹 · 12 项", x: 48, y: 120, size: "—", updated: "3 天前",
      tags: [{ t: "代码", c: "blue" }, { t: "重要", c: "gray" }], favorite: true,
      summary: "项目源代码根目录，包含 Spring Boot 后端、React 前端与 Docker 部署脚本。\n\nTODO: 后续接入目录树解析、代码摘要与依赖图谱。",
      content: "# 项目代码\n\n本文件夹包含 CampusShare 全栈源码：\n\n- `backend/` Spring Boot + MyBatis\n- `frontend/` React + TypeScript + Vite\n- `deploy/` Docker 编排\n\n## 目录结构\n\n```\nbackend/  前端网关与用户服务\nfrontend/  React 客户端\ndeploy/    Docker 编排脚本\n```\n\nTODO: 接入真实目录树解析与文件预览。"
    },
    {
      id: "B", name: "需求文档.pdf", type: "PDF", typeLabel: "PDF",
      meta: "PDF · 2.4 MB", x: 340, y: 100, size: "2.4 MB", updated: "2 天前",
      tags: [{ t: "需求", c: "blue" }, { t: "v2.0", c: "gray" }], favorite: false,
      summary: "本文档为产品需求说明（PRD v2.0），定义了可视化文件管理工作区的核心目标与范围：支持多格式文件上传、画布内自由排版、文件间关联连线，以及基于 AI 的文档摘要与元数据提取。\n\n关键模块：上传解析、画布引擎、关联图谱、AI 总结。",
      content: "# 1. 项目背景\n\n可视化文件管理工作区旨在把散落的文档、图片、代码与文件夹统一收纳到一个可拖拽的画布中。用户通过自由排版建立空间关联，点击任一节点即可唤出 AI 总结与详情编辑。\n\n# 2. 核心功能\n\n- 多格式上传（PDF / MD / Word / 图片 / 文件夹）\n- 画布内自由拖拽排版\n- 文件间关联连线\n- 基于 AI 的智能总结\n\n# 3. 技术选型\n\n采用 LangChain 编排检索增强生成（RAG）流程，对上传文件做切片、向量化与摘要抽取，预留接口便于后续替换模型与链路。"
    },
    {
      id: "C", name: "README.md", type: "MD", typeLabel: "Markdown",
      meta: "Markdown · 4 KB", x: 610, y: 180, size: "4 KB", updated: "5 天前",
      tags: [{ t: "文档", c: "blue" }], favorite: false,
      summary: "项目说明文档，介绍启动方式与目录结构。\n\nTODO: 后续由 AI 自动生成维护指南。",
      content: "# CampusShare\n\n校园社交平台全栈项目。\n\n## 快速开始\n\n```\n# 后端\ndef start:\n  cd backend && mvn spring-boot:run\n\n# 前端\nnpm install && npm run dev\n```\n\nTODO: 由 AI 自动维护此文档。"
    },
    {
      id: "D", name: "设计方案.docx", type: "DOC", typeLabel: "Word",
      meta: "Word · 1.1 MB", x: 120, y: 360, size: "1.1 MB", updated: "1 周前",
      tags: [{ t: "设计", c: "blue" }, { t: "v1.3", c: "gray" }], favorite: true,
      summary: "UI/UX 设计方案，含信息架构与交互原型。\n\nTODO: 后续接入设计稿版本对比。",
      content: "# 设计方案 v1.3\n\n## 信息架构\n\n顶部全局导航 + 左侧资源管理 + 中央画布 + 右侧上下文面板。\n\n## 交互原型\n\n- 拖拽建立空间秩序\n- 连线表达语义关联\n- 点击唤起 AI 总结\n\nTODO: 接入设计稿版本对比与标注。"
    },
    {
      id: "E", name: "架构图.png", type: "PNG", typeLabel: "图片",
      meta: "PNG · 860 KB", x: 470, y: 400, size: "860 KB", updated: "1 周前",
      tags: [{ t: "架构", c: "blue" }], favorite: false,
      summary: "系统架构总览图，展示前端、Agent 后端与存储的关系。\n\nTODO: 后续支持图片内文字识别与摘要。",
      content: "# 架构图说明\n\n![架构图]()\n\n## 分层\n\n- 表现层：React 画布\n- 智能层：LangChain Agent\n- 存储层：对象存储 + 向量库\n\nTODO: 支持图片 OCR 与摘要。"
    }
  ];

  // 初始关联（对齐设计稿虚线：A-D、B-C）
  var connections = [["A", "D"], ["B", "C"]];

  var byId = {};
  files.forEach(function (f) { byId[f.id] = f; });

  // 版本（示例）
  function versionsFor(f) {
    return [
      { name: f.name + " · v" + (f.tags.find(function (t) { return /v\d/.test(t.t); }) ? f.tags.find(function (t) { return /v\d/.test(t.t); }).t : "1.0"), meta: "当前版本 · " + f.updated, current: true },
      { name: f.name + " · 初稿", meta: "自动保存 · 更早", current: false },
      { name: f.name + " · 导入版", meta: "上传时生成", current: false }
    ];
  }

  return {
    NODE_W: NODE_W,
    NODE_H: NODE_H,
    files: files,
    connections: connections,
    byId: byId,
    versionsFor: versionsFor
  };
})();
