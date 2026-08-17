# FileHub 工作区核心逻辑与方案调研

## 问题结论

旧工作区把工作区内的全部文件直接渲染为画布节点。主工作区存在 293 个文件时，会同时产生三个问题：

- 资料管理退化为难以扫描的卡片墙，排序、筛选和批量操作效率低。
- 视觉画布失去空间记忆，节点位置只是在模拟列表网格。
- 全量关系图、个人工作画布和文件资料库混成同一个概念。

因此，文件属于工作区不再等于文件必须出现在画布上。

## 采用的信息架构

| 视图 | 核心职责 | 数据范围 |
|---|---|---|
| 概览 | 返回最近上下文、重要资料和知识库状态 | 聚合数据 |
| 资料库 | 搜索、筛选、排序、批量管理全部资源 | 工作区全部文件 |
| 画布 | 对照、讨论并连接当前任务需要的资料 | 用户明确加入的文件 |
| 关系图谱 | 发现全局关联和主题聚类 | 工作区全部关系 |

核心状态拆分为：

```text
workspace.files       工作区全部文件
canvas.nodeIds        明确加入当前画布的文件 ID
canvas.connections    画布节点之间的关系
canvas.viewport       缩放和视口位置
library.query/filter  资料库临时检索状态
```

## 方案调研

### React Flow

- 官方定位是 node-based UI、graph、diagram 和 workflow。
- 原生模型就是 nodes、edges、viewport，提供连接、选择、缩放、小地图和自定义节点。
- 与当前 FastAPI `canvas` 快照以及 `connections` 数据模型直接对应。
- 适合作为 React + TypeScript 迁移后的首选画布引擎。

参考：<https://reactflow.dev/learn/concepts/core-concepts/>

### tldraw

- 更偏向自由白板、绘图形状和多人创作。
- 若后续重点转向手绘、批注、自由形状和富白板协作，扩展能力更强。
- FileHub 当前主要对象是结构化文件节点和关系，采用 tldraw 会引入额外的 shape 到业务节点映射层。

参考：<https://tldraw.dev/sdk-features/>

### Obsidian Canvas 模式

- 文件库与 Canvas 分离，用户把需要组织的内容显式放进 Canvas。
- 这一模式避免将整个知识库一次性铺满画布，适合 FileHub 当前的文件规模。

参考：<https://help.obsidian.md/plugins/canvas>

## 当前落地策略

第一阶段保持现有零依赖前端，完成信息架构和核心行为验证：

- 默认进入概览，不再直接渲染数百个节点。
- 侧栏分类和全局搜索进入资料库。
- 资料库支持排序、多选、收藏及批量加入画布。
- 画布仅渲染 `canvasNodeIds`，支持缩放、整理、拖拽、连线、小地图和撤销重做。
- `Delete` 在画布中表示“从画布移除”，不会删除原文件；文件删除只能通过检查器明确执行。
- 旧版超过 40 个节点的全量画布自动迁移为收藏资料精选画布。

## 后续升级 TODO

- [ ] 前端迁移到 React + TypeScript + Zustand。
- [ ] 使用 React Flow 替换当前 DOM 画布，保持现有 nodes/edges/viewport API 契约。
- [ ] 增加多个命名画布，文件可同时属于多个画布。
- [ ] 画布快照增加 `canvas_id`，不再与工作区一对一绑定。
- [ ] 使用 d3-force 或 ELK 做可取消的自动布局。
- [ ] 仅渲染视口附近节点，支持千级节点画布。
- [ ] 协同阶段引入 Yjs，并把 revision 快照升级为 CRDT 操作流。
