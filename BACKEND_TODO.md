# FileHub 后续升级 TODO

> 依据 `docs/API_AUDIT.md` 已完成一轮安全/正确性加固（P0/P1 全部修复 + P2 大部分 +
> 缺失功能主链路闭环），并通过 39 个后端测试验收。以下为**仍然开放**的升级项。

## 已完成（本轮）
- 标准 JWT + refresh 轮换/吊销（P0-2/P0-10/P1-9）、token_version 即时吊销
- WebSocket ticket 鉴权（P0-3）、导出下载鉴权（P0-4）、分享过期/权限（P0-5）
- JWT 密钥 fail-fast（P0-9）、上传大小/类型限制 + 流式落盘 + 下载/预览（P1-11）
- 上传 summary 列错位（P0-6）、版本还原先快照（P0-7）、安全删除路径白名单（P0-8）
- camelCase 响应 + 标签数组（P1-1）、tag/recent 过滤（P1-2）、FTS 转义（P1-3）、分页（P1-4）
- 空壳接口真实化：undo/redo、force-layout、dedup、sync、graph、timeline、notifications（P1-5）
- 删除 0 行返回 404（P1-6）、create_tag 假 ID（P1-7）、工作区级联删除（P1-8）
- 统一 API client + 401 单飞刷新（P1-9/P1-10）、AI 引用真实化（P1-12）
- 外键 + WAL + 轻量迁移（P2-5）、无 import 副作用（P2-6）、统一响应/错误码/traceId（P2-2/P2-3）
- `/api/v1` 版本化、CORS 加 8888、移除未使用的 qdrant 服务（P2-15）
- 前端接入真实上传、画布保存、内容保存、回收站；AI 摘要回写

## 仍开放（较重，建议由开发 agent 落地）
- [ ] 用 LangChain `RecursiveCharacterTextSplitter` + embedding + Qdrant/pgvector 建立持久化 RAG（当前为关键词检索，引用已真实命中）。
- [ ] AI 流式 SSE 已提供 `/ai/chat/stream`，前端 UI 尚未接流式渲染。
- [ ] PDF/DOCX/图片的解析（OCR / 文档抽取），上传后进入异步解析队列。
- [ ] 多用户工作区成员/权限模型（当前 workspaces 单用户独占）。
- [ ] 前端真实登录/注册/登出页（当前沿用 demo 账号静默注册）。
- [ ] 通知中心 UI 与后端 `/notifications` 打通（后端已产生通知，前端面板仍用演示数据）。
- [ ] 操作审计 UI、配额/存储限额、prometheus 指标、CI（lint/test）。
- [ ] 回收站 TTL 自动清理已实现（`purge_expired_trash`，默认 30 天，启动时执行）。

当前服务是已加固的最小桥接层：密钥只从 `backend/.env` 读取，前端无密钥。
