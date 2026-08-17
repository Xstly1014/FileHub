# FileHub 原型

## 启动前端

```powershell
cd D:\WorkSpace-java\workbuddy\filehub
python -m http.server 8080
```

浏览器打开 `http://localhost:8080`。不启动后端也可以使用全部画布和功能实验室交互；AI 问答会自动使用演示降级答案。

## 启动 LangChain AI 桥接服务

在 D 盘准备环境并配置密钥（不要把真实密钥写进代码）：

```powershell
cd D:\WorkSpace-java\workbuddy\filehub\backend
py -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
Copy-Item .env.example .env
# 编辑 .env：
#   1) OPENAI_API_KEY  填入你自己的密钥（.env.example 里只有占位符 replace-me）
#   2) FILEHUB_JWT_SECRET  填一个强随机串（服务在未配置时会拒绝启动）
#      生成方式：python -c "import secrets;print(secrets.token_urlsafe(48))"
.\.venv\Scripts\python server.py
```

服务默认监听 `http://127.0.0.1:8787`，前端会跨域调用该地址；生产环境应由网关统一转发。

API 文档：`http://127.0.0.1:8787/api/v1/docs`。接口统一前缀 `/api/v1`（旧 `/api` 前缀保留为过渡别名）。运行目录固定在 `D:\WorkSpace-java\workbuddy\filehub\runtime`，包含 SQLite、上传文件和导出文件。首次打开前端会自动创建本地 demo 用户以兼容当前无登录页的原型。

所有运行时文件、虚拟环境和后续索引均应放在 D 盘。升级事项见 [BACKEND_TODO.md](BACKEND_TODO.md)。

## 运行后端测试

```powershell
cd D:\WorkSpace-java\workbuddy\filehub\backend
.\.venv\Scripts\python -m unittest discover -s tests -v
```

测试覆盖认证（JWT/刷新轮换/改密吊销）、文件（上传/版本/回收站/下载）、画布（乐观锁/撤销重做）、分享过期、导出鉴权、去重、图谱、时间线、通知、WebSocket 鉴权等，见 `docs/API_AUDIT.md` 对应修复项。

## Docker 启动（推荐）

在 `D:\WorkSpace-java\workbuddy\filehub` 执行：

```powershell
docker compose up -d --build
docker compose ps
```

访问 `http://localhost:8080`，API 文档访问 `http://localhost:8787/docs`。Compose 会启动 `web`、`api` 和 `qdrant`，并将 `runtime` 挂载到项目目录（D 盘）。停止服务：

```powershell
docker compose down
```
