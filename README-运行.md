# 空库 · 运行说明

## 推荐：开发快速启动（优先）

不必每次构建 api/web 镜像，只起数据库，前后端本机跑：

```bash
chmod +x scripts/dev-up.sh
./scripts/dev-up.sh
```

- 网页：http://127.0.0.1:5173  
- API 文档：http://127.0.0.1:8000/docs  

脚本会：

1. 若本机已有 `postgres:16-alpine`，直接复用（不再拉大镜像）  
2. 否则用 DaoCloud 加速拉 `pgvector`  
3. 本机启动 FastAPI + Vite  

## 全量 Docker 一键启动

镜像默认走 **DaoCloud** 代理，并启用 BuildKit 缓存、国内 pip/npm 源：

```bash
cp .env.example .env   # 首次
chmod +x scripts/compose-up.sh
./scripts/compose-up.sh
```

或：

```bash
DOCKER_BUILDKIT=1 docker compose up -d --build
```

- 网页：http://localhost:8080  
- API：http://localhost:8000/docs  

### 加速相关环境变量（`.env`）

| 变量 | 含义 |
|------|------|
| `DOCKER_HUB_PROXY` | 默认 `docker.m.daocloud.io`；海外可清空后直连 Hub |
| `POSTGRES_IMAGE` | 可指定 `postgres:16-alpine`（快）或带 pgvector 的镜像 |

## 手动本机开发

```bash
docker compose -f docker-compose.dev.yml up -d
cd apps/api && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
DATABASE_URL=postgresql+asyncpg://kongku:kongku@127.0.0.1:5432/kongku uvicorn app.main:app --reload --port 8000
```

另开终端：

```bash
cd apps/web && npm run dev
```

## 架构约定

见 [docs/工程/02-架构约定.md](./docs/工程/02-架构约定.md)。

## 常见问题

| 现象 | 处理 |
|------|------|
| 拉镜像很慢 | 确认 `.env` 有 `DOCKER_HUB_PROXY=docker.m.daocloud.io`；或改用 `./scripts/dev-up.sh` |
| 8080/5173 被占用 | 改端口或先关掉占用进程 |
| API 起不来 | `docker compose logs db api`；开发模式看终端报错 |
| 无 vector 扩展 | 开发用普通 Postgres 可先跑通；上线检索前换成 pgvector 镜像 |
| Key 测试失败 | DeepSeek Base URL 一般为 `https://api.deepseek.com/v1` |
