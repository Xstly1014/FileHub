# FileHub 接口实现审计与批判报告

> 审计日期：2026-08-17
> 审计范围：`filehub/backend/server.py`（约 60 个端点）+ 前端 `js/api.js`、`js/ai.js`、`js/app.js`、`js/features.js` 的接口调用侧
> 性质：**只记录、不实现**。本文档刻意保持苛刻——现在的实现是一个"能跑通的桥接层"，距离"可以放心交付的产品级 API"还有很大距离。

---

## 一、现状盘点

### 1.1 后端已提供的接口（按域分组）

| 域 | 端点 | 真实程度 |
|---|---|---|
| 认证 | register / login / refresh / me(GET/PATCH) / logout | 基本真实，但 refresh **是坏的**（见 P0-2） |
| 工作区 | CRUD `/api/workspaces` | 真实，但删除不清理任何级联数据 |
| 文件 | list / upload / detail / patch / trash / restore / purge / content(GET/PUT) / versions(list/detail/restore) | 大部分真实，细节 bug 多 |
| 回收站 | list / empty | 真实 |
| 画布 | canvas(GET/PUT/POST) / undo / redo | undo/redo 是**空壳** |
| 布局 | layouts/force | **空壳**，返回写死的假结果 |
| 搜索 | search / favorites | 半真实（FTS 裸拼接，会 500） |
| 标签 | tags CRUD / attach / detach | 半真实（create 有假 ID bug） |
| 洞察 | backlinks / health / timeline / graph / dedup(scan/ignore/merge) | timeline 永远为空、graph 永远无边、ignore/merge 是空壳 |
| 锚点 | anchors CRUD | 真实 |
| 模板 | templates CRUD / apply | 真实，但 apply 只回显 payload 不落地 |
| 导入导出 | export / import / exports 下载 | 半真实（导出下载**无鉴权**） |
| 分享 | share / shares 访问 / delete | 半真实（过期时间**从不校验**） |
| 评论 | comments CRUD | 真实 |
| 通知 | list / read / read-all | 表存在，但**没有任何代码会写入通知**，永远为空 |
| AI | chat / summarize / tags / links / capsule / health-score / dedup-score | chat/summarize/tags 真调 LLM，其余是写死的 fallback |
| 同步 | sync/snapshot / changes / resolve | changes/resolve 是**空壳**，收什么都不持久化 |
| 其他 | health / pwa/manifest / WebSocket | WS **无鉴权** |

### 1.2 前端实际用到的接口

前端只消费了全部接口中极小的一部分：

- `GET /api/workspaces`、`GET /api/workspaces/{id}/files`（启动同步，app.js:416-425）
- `POST /api/ai/chat`（features.js:289，**未带 Authorization 头**）
- `POST /api/ai/summarize` / `ai/tags` / `ai/links`（ai.js）

**其余约 50 个端点没有任何前端调用方。** 画布保存、编辑保存、上传、标签、评论、分享、模板、回收站、WebSocket……后端写了，前端一个都没接。上传弹窗更是纯假的——拖拽文件只是往本地数组里塞一个示例节点（app.js:128-152），根本没有发起 multipart 上传。

**结论：后端和前端目前是两座几乎不相连的岛。所谓"接入后端"只完成了"读文件列表 + AI 问答"两条线。**

---

## 二、问题清单（按严重度）

### P0 —— 安全 / 数据正确性，必须最先修

**P0-1 `.env.example` 里躺着真实 API Key**
[.env.example](file:///d:/WorkSpace-java/workbuddy/filehub/backend/.env.example) 第 2 行是一个真实的 `sk-...` 密钥。`.gitignore` 只忽略了 `.env`，`.env.example` 一旦进版本库就等于密钥泄露。示例文件必须放 `replace-me` 占位符，且这个密钥应当立即吊销。

**P0-2 `/api/auth/refresh` 是坏的，永远 401**
`token()` 生成 refresh token 时 `kind="refresh"`（server.py:86-89），而 `token_user()` 里 `kind != "access"` 直接返回 None（server.py:96）。于是 `refresh()` 里 `token_user(body.get("refreshToken"))` 永远失败。**刷新令牌流程从未真正工作过。** 前端把 `fh_refresh` 存了但从来没用，算是"巧合地没踩到雷"。理想做法：refresh token 走 DB 比对（表都建好了却不用），access/refresh 用不同校验路径，并支持轮换（rotation）与吊销。

**P0-3 WebSocket 完全无鉴权**
`/api/ws/workspaces/{workspace_id}`（server.py:597-603）不接受任何 token，任何人知道/猜到 workspace id 就能连进去，向该工作区的所有在线用户广播任意伪造事件（presence、编辑、通知……）。这是实时协同场景下的投毒入口。理想做法：连接握手阶段校验 ticket（短期一次性令牌）或首帧鉴权，鉴权失败立即 close(4401)。

**P0-4 导出文件下载无鉴权**
`GET /api/exports/{name}`（server.py:446-450）不校验任何身份。导出文件是整个工作区的完整 JSON（含全部文件内容），文件名只是 `workspace_id-时间戳.json`，可枚举性不低。分享链接至少还有 token，导出反而裸奔。理想做法：签名下载 URL（带过期）或要求 Bearer + 归属校验。

**P0-5 分享链接不校验过期时间、不校验权限**
`shares` 表存了 `expires_at` 和 `permission`，但 `public_share()`（server.py:466-470）的 SQL 里根本没有 `expires_at` 条件，permission 也从未被读取。**过期分享永不过期，权限字段是摆设。**

**P0-6 上传把 200KB 内容写进了 summary 字段**
`upload_file` 的 INSERT（server.py:218）按列序把 `content[:200000]` 塞进了 `summary` 列。summary 本应是 AI 摘要/短摘录，现在每个上传文件的 summary 都是 20 万字符的原文。所有返回 summary 的列表接口都会因此膨胀。这是列序手写错位导致的真 bug。

**P0-7 版本还原会丢失当前内容**
`restore_version`（server.py:275-279）直接用旧版本覆盖 `files.content`，**不先把当前内容存成新版本**。用户误点"还原"就永久丢失现有编辑。正确语义：还原 = 以旧版本内容为蓝本创建一个新版本。

**P0-8 `purge_file` / `empty_trash` 的 `shutil.rmtree(Path(path).parent)` 是危险模式**
导入的文件 `path=""`（server.py:457），`Path("").parent` 是 `Path(".")`——也就是对当前工作目录调 `rmtree`。目前靠 `ignore_errors=True` 静默失败兜底，但这是一个"等着出事"的写法。应当只允许删除 `FILES/{fid}` 目录，且校验路径前缀。

**P0-9 JWT secret 弱默认值且不强制配置**
`FILEHUB_JWT_SECRET` 默认 `"filehub-local-change-me"`（server.py:30），`.env` 里也没配。所有部署共享同一个可猜测的签名密钥 = 任何人可伪造任意用户的 access token。启动时未配置就应拒绝启动（fail-fast）。

**P0-10 自研 token 不是 JWT，且无法吊销 access token**
`user_id.kind.exp.hmac` 四段式（server.py:86-98）：user_id 明文可见、无 jti、无签发方/受众、access token 一旦签发 60 分钟内无法吊销（改密码、封号都没用）。既然已经依赖了 FastAPI 生态，直接用标准 JWT（或干脆 session + DB）都优于现状。

### P1 —— 正确性 / 契约 / 可用性硬伤

**P1-1 前后端契约混乱，字段命名两套体系**
请求体用 camelCase（`displayName`、`workspaceId`），响应体却是数据库原样的 snake_case（`display_name`、`updated_at`、`created_at`）。前端被迫在 app.js:421 手工映射 `updated: f.updated_at`。标签更离谱：`list_files` 用 `group_concat` 把标签拼成逗号字符串返回，前端再 `split(",")` 拆回来（app.js:421）——标签名里只要含逗号就全乱了。理想：统一 camelCase 响应模型（pydantic response_model），标签返回数组。

**P1-2 `list_files` 的 `tag` 和 `recent` 参数是装饰品**
签名里收了 `tag` 和 `recent`（server.py:207），函数体里从未使用。按标签筛选这个 PRD 核心交互在后端根本不存在。

**P1-3 搜索接口会把用户输入直接拼进 FTS5 MATCH**
`search()`（server.py:320-321）执行 `search_documents MATCH q + "*"`。用户输入含空格、引号、`AND/OR/NOT`、括号时 FTS5 直接语法错误 → 未捕获 → **500**。`list_files` 的 `query` LIKE 也没转义 `%`/`_`。理想：FTS 查询转义/分词，或退回 LIKE 兜底，错误时返回空结果 + 提示而不是 500。

**P1-4 分页没有总数、没有参数下限上限**
所有列表接口只返回裸数组，没有 `total/hasMore`，前端无法做真分页；`page=0` 会产生负 OFFSET 直接 500；`pageSize` 无上限，可以传 10 亿把服务拖死。理想：统一 `{items, total, page, pageSize}`，参数 `ge=1, le=200`。

**P1-5 空壳接口冒充真接口，误导所有调用方**
- `canvas/undo`、`canvas/redo`：原样返回最新画布（server.py:305-307）
- `layouts/force`：返回写死的 `"status": "completed"`（server.py:310-311）
- `dedup/{id}/ignore`、`dedup/{id}/merge`：不写库，回声参数（server.py:386-391）
- `sync/changes`、`sync/resolve`：收什么都不落地（server.py:576-581）
- `graph`：edges 永远 `[]`（server.py:371-373），尽管连线数据就在 canvas_snapshots 里
- `timeline`：timeline_events 表**没有任何写入方**，永远空
- `notifications`：同上，没有任何业务会产生通知
- `ai/capsule`、`ai/health-score`、`ai/dedup-score`：写死返回值

这些端点在 Swagger 里看起来"都有"，实际上前端接进去全是空数据。**宁可没有，不可假有**——假接口比缺接口更坏，因为它消耗集成方的信任和时间。至少应返回 501，或在 OpenAPI 中显式标注 `@deprecated/experimental`。

**P1-6 删除操作普遍"假装成功"**
`patch_tag`、`delete_tag`、`patch_comment`、`delete_comment`、`delete_share` 等在 0 行受影响时仍返回 `{"ok": true}`，也不返回 404。调用方无法区分"删掉了"和"本来就不存在/不是你的"。

**P1-7 `create_tag` 返回不存在的 ID**
`INSERT OR IGNORE`（server.py:331）：标签重名时插入被忽略，但接口仍返回新生成的 `tid`——一个数据库里不存在的 ID。前端拿着这个 ID 去 detach 会永远无效。

**P1-8 删除工作区不清理任何东西**
`delete_workspace`（server.py:201-203）只删 workspaces 一行。files（含磁盘文件）、canvas_snapshots、anchors、tags 关联、comments、shares、timeline 全部成为孤儿。schema 里**一条外键约束都没有**（`PRAGMA foreign_keys=ON` 开了个寂寞）。

**P1-9 前端会话 60 分钟后必死**
access token 60 分钟过期；api.js 的 401 重试仅在"完全没有 token"时触发（`!auth()`），token 过期时 `auth()` 非空 → 不重试 → 抛错。`fh_refresh` 存了从未使用（而且用了也是 P0-2 的 401）。结果：用户开着页面 1 小时后，所有后端功能静默失效。理想：401 → 用 refresh 换新 → 重放原请求，单飞（single-flight）防并发刷新。

**P1-10 features.js 的 AI 聊天不带鉴权**
features.js:289 裸 `fetch` `/api/ai/chat`，不带 Authorization → 必然 401 → 走演示降级。也就是说**功能实验室的 AI 聊天永远连不上真 AI**，即使后端可用。同一个应用里三处鉴权写法（api.js、ai.js、features.js 裸 fetch），demo 账号密码硬编码了两份。

**P1-11 上传：无大小限制、无类型校验、全量读进内存**
`await upload.read()`（server.py:218）一次性读入整个文件，没有 `max_size`，一个 2GB 文件就能打爆内存。也没有 MIME 白名单、没有分片、没有进度。PDF/DOCX/图片没有任何解析（PRD 明确要求多格式），二进制文件存了磁盘却**没有任何下载/预览端点**能把原件取回来——存了等于扔了。

**P1-12 AI 上下文构建粗暴，引用是假的**
`ai_chat`（server.py:523-531）：
- 传了 `workspaceId` 就无视请求里的 files，直接拉最多 100 个文件；
- 每个文件拼 `summary + content[:1000]`，30 个文件就是 3 万字符裸塞给模型，无检索、无切片、无 token 预算；
- `citations` 固定返回**前 3 个文件**，与答案毫无关系——这是"伪造引用"，比不返回引用更误导用户；
- 异常被吞成一句兜底文案，服务端无任何日志。
BACKEND_TODO 里写的 RAG/Qdrant 一个字都没实现，`qdrant-client` 装了、compose 里 qdrant 容器起了、代码里零调用。

**P1-13 `save_content` 把 content 前 240 字符当 summary**
（server.py:260）摘要和截断是两个概念，这会让所有"AI 摘要"展示位变成正文开头。

**P1-14 并发与事务**
- 每个请求新开 sqlite 连接、无 WAL、同步阻塞调用跑在 async 事件循环里（`upload_file` 是 async 却全程同步 IO）；
- `put_canvas` 的"读 max(revision) → 比较 → 插入"不在事务内，两个客户端同时保存时 revision 冲突检测会失效；
- 没有乐观锁版本号返回给文件/标签等资源的 PATCH。

**P1-15 认证细节**
- 登录/注册无限流，可离线爆破密码；注册无邮箱格式校验（`email: str`）、无验证码、无邮箱验证；
- `PATCH /api/auth/me` 用裸 `dict` 接收，`displayName` 可被设为空字符串（注册时却要求 min_length=1）；
- `logout` 不需要任何鉴权；
- refresh_tokens 表只增不减（每次登录 INSERT 新行，从不清理过期行），也无每设备数量上限；
- 没有改密码、注销账号接口。

### P2 —— 工程质量 / 可维护性

1. **无 API 版本化**：`/api/...` 直接裸奔，未来任何破坏性变更都无处可退。至少 `/api/v1`。
2. **无统一响应封装与错误码**：有的返回裸数组、有的 `{"ok":true}`、有的返回对象；错误只有 FastAPI 默认 `detail` 字符串。理想：`{code, message, data, traceId}` + RFC 7807 problem+json + 业务错误码表。
3. **无请求日志、无审计、无 traceId**：出了问题无从查起。
4. **无测试**：0 个测试文件。认证、画布冲突、分享过期这些关键路径全靠肉眼。
5. **无迁移机制**：schema 靠 `CREATE TABLE IF NOT EXISTS` 一把梭，字段想改就改不动了。应引入 alembic。
6. **`init_db()` 在 import 时执行**：副作用进模块导入，测试无法隔离，Docker 健康检查前就已写盘。
7. **OpenAPI 质量差**：所有端点没有 `response_model`、没有 tag 分组、没有示例，`/docs` 里全是 `dict[str, Any]` 黑盒。
8. **`/api/health` 泄露数据库绝对路径**，且 `langchain: True` 写死（实际可能 import 失败）。
9. **路由风格不一致**：`POST /files/{id}/restore`（RPC 动词）、`DELETE /files/{id}/purge`（动词入路径）、`POST /trash/empty`、PUT 和 POST 同时注册 canvas——REST 语义混乱，团队里必然各写各的。
10. **CORS 默认只允许 8080**：前端换端口（用户偏好固定 8888）就全线跨域失败，且无提示。
11. **无压缩、无缓存头、无 ETag**，`sync/snapshot` 一次性返回全部文件 content，payload 无上限。
12. **AI base_url 默认值硬编码公网裸 HTTP IP**（server.py:517 `http://111.229.22.125:3001/v1`）：密钥走明文 HTTP 发往不可控的第三方地址，应强制显式配置且默认拒绝。
13. **前端无登录页**：靠硬编码 demo 账号静默注册（api.js:11-16），多用户、登出、切换账号全部不存在；PRD 里的通知/协同/分享在"人人都是 demo"下毫无意义。
14. **前端无离线写队列**：PRD E30 要求 PWA 离线同步，现状是"后端不可用就静默用种子数据"，用户在本地的任何编辑都不会进入后端。
15. **docker-compose 起了 qdrant 却无人使用**，白白占资源，还制造"已接向量库"的错觉。

---

## 三、系统性批判（设计层面）

1. **"接口数量繁荣"掩盖了"闭环缺失"。** 60 个端点里真正被前端消费的不超过 6 个。当前最需要的不是再加接口，而是把"上传 → 解析 → 画布持久化 → 编辑保存 → 版本 → AI 摘要回写"这一条主链路真正打通闭环。
2. **假接口是技术债的高利贷。** undo/redo、force-layout、sync、dedup-merge 这些空壳让 Swagger 看起来完整，实际上每个都会让接入者浪费半天。产品原型阶段可以 mock，但 mock 必须显式（501 / `experimental: true` / 文档标注），不能伪装成 200。
3. **安全基线缺失是结构性的**：无鉴权的 WS、无鉴权的导出、不过期的分享、弱默认密钥、坏的 refresh——任何一条单拎出来都足以否定上线。这些不是"以后再说"的项，是"有它们就不该暴露端口"的项。
4. **数据模型与领域目标脱节**：PRD 的核心是"文件关联图谱"，但 edges 没有独立表、没有 API，只存在于画布快照的 JSON 字符串里——意味着反向链接、社区发现、图谱分析全部无从谈起。`connections` 应当是一等公民（表 + CRUD + 事件）。
5. **前端三套鉴权代码、两份硬编码 demo 凭据**，说明缺少一个"单一 API 客户端层"的纪律。

---

## 四、理想实现蓝图（如果重做）

### 4.1 契约层
- `/api/v1` 前缀；OpenAPI 3.1 + 全量 `response_model` + tag 分组 + 示例；用 openapi-typescript 自动生成前端类型，杜绝手工字段映射。
- 统一响应：成功 `{ code: 0, data, traceId }`；失败 RFC 7807 `{ type, code, message, details[], traceId }`；业务错误码表（如 `AUTH_REFRESH_EXPIRED`、`CANVAS_REVISION_CONFLICT`）。
- 列表统一 `{ items, total, page, pageSize }`，游标分页用于 timeline/versions 这类流式数据。
- 命名全 camelCase；时间统一 ISO-8601 UTC；ID 统一 `file_xxx` 前缀格式。

### 4.2 认证与协同
- 标准 JWT（access 15min + refresh 30d 轮换、可吊销）或直接接入 OIDC；登录限流 + 失败锁定；注册邮箱验证。
- WebSocket：HTTP 升级时带一次性 ticket 鉴权；心跳 ping/pong；断线重连 + 消息序号（seq）补发；事件 schema 化（`canvas.patch`、`file.updated`、`presence.*`）。
- 画布同步从"全量快照 + revision"升级为操作日志（op-log）或 Yjs CRDT，undo/redo 建立在 op 栈上而不是假端点。

### 4.3 文件主链路
- 上传：预签名/分片 + 大小与类型白名单 + SHA256 秒传去重；异步解析队列（PDF/DOCX/MD/代码/OCR 图片），解析状态可查询（`processing → indexed → failed`），前端有进度与失败重试。
- 原件可下载/可预览（范围请求 + Content-Type 正确 + 图片缩略图）。
- 版本：还原先快照当前内容；版本列表分页；可选 delta 存储。
- `connections` 独立成表与 API，backlinks 用真实引用索引而非 `LIKE %文件名%`。

### 4.4 AI 层
- 真正的 RAG：上传即切片 + embedding 入 Qdrant；chat 走检索 → 重排 → 生成，引用必须来自真实命中片段（chunk 级 citation），SSE 流式输出。
- 摘要/标签/健康度/去重统一为 LangChain Runnable + 结构化输出（pydantic schema 约束模型返回），带超时、重试、降级标记与日志；fallback 必须显式 `mode: "fallback"` 且前端 UI 区分展示。
- 所有 AI 调用有 token 预算与内容脱敏。

### 4.5 工程化
- alembic 迁移；pytest + httpx 契约测试（每个端点至少 happy + 401 + 404）；structlog 结构化日志 + traceId 贯穿；prometheus 指标；CI 跑 lint/test。
- 观测：健康检查区分 liveness/readiness（含 DB、Qdrant、LLM 可达性），不泄露内部路径。
- 前端：真实登录页 + 单一 API client（401 自动刷新重放、请求去重、离线写队列 + Background Sync）。

---

## 五、缺失功能清单（PRD 有、接口无）

| 缺失 | 说明 |
|---|---|
| 登录/注册/登出 UI 对应的前端流程 | 只有硬编码 demo 静默注册 |
| 工作区切换/多工作区 UI | 前端永远取第一个工作区 |
| 画布保存/恢复接入 | canvas PUT/GET 无人调用，编辑全在内存 |
| 真实上传 | 上传弹窗是纯前端假交互 |
| 文件原件预览/下载 | 二进制存了取不回 |
| 关联连线（edges）CRUD | 图谱核心缺失 |
| 通知产生链路 | 表在，无写入方 |
| 时间线写入 | 同上 |
| 分享过期/权限执行 | 字段在，不生效 |
| 多用户协作（工作区成员/权限） | workspaces 单用户独占 |
| 回收站 TTL 自动清理 | PRD E8 要求 |
| 全文搜索高亮/片段返回 | 只返回文件行 |
| AI 流式输出 | 全部一次性返回 |
| 配额/存储限制 | 无 |
| 操作审计日志 | 无 |

---

## 六、行动项（建议顺序）

**第一批（安全止血）**
- [ ] 吊销并移除 .env.example 中的真实密钥（P0-1）
- [ ] 修复 refresh 校验逻辑或改为 DB 比对（P0-2）
- [ ] WebSocket 鉴权（P0-3）；导出下载鉴权（P0-4）；分享校验 expires_at/permission（P0-5）
- [ ] JWT secret 未配置即拒绝启动（P0-9）
- [ ] 上传大小限制 + rmtree 路径白名单（P0-8、P1-11）

**第二批（正确性）**
- [ ] 修复 upload 的 summary 列错位（P0-6）、版本还原先快照（P0-7）、create_tag 假 ID（P1-7）
- [ ] 列表分页封装 + 参数校验；FTS 输入转义（P1-3、P1-4）
- [ ] 删除级联（外键 + 磁盘清理）（P1-8）
- [ ] 所有空壳接口标注 501/experimental（P1-5）

**第三批（主链路闭环）**
- [ ] 前端接入真实上传、画布保存、内容保存、回收站
- [ ] 统一 API client + 401 刷新重放（P1-9、P1-10）
- [ ] 响应模型 camelCase 化 + 标签数组化（P1-1）
- [ ] 真实 RAG + 流式 + 真实引用（P1-12）

**第四批（工程化）**
- [ ] 测试、迁移、日志、指标、API 版本化

---

*本文档只做记录与批判，不包含任何实现。所有结论均可在 server.py / api.js / ai.js / app.js / features.js 中按行号复核。*
