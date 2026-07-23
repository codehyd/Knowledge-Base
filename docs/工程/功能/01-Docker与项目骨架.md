# 功能 01 · 项目骨架（历史 Docker）

> **个人版现状**：默认 **Electron + SQLite**，见 [README-运行.md](../../../README-运行.md)。  
> Compose / Dockerfile 已挪到 `archive/docker/`，本文仅保留历史说明，供以后 NAS/交付参考。
>
> 前置：[从0到1](../01-从0到1.md)  
> 产品：[04-工具与运行](../../产品/04-工具与运行.md)

## 1. 功能目标（历史）

固化可复现的 Compose 工程：一键起 Web + API + DB，数据卷持久，运行说明可读。

## 2. 技术要点

| 项 | 做法 |
|----|------|
| 编排 | `docker-compose.yml`：`db` / `api` / `web` |
| 数据库镜像 | `pgvector/pgvector:pg16`，初始化启用 vector 扩展 |
| 卷 | `pgdata`、`./data/uploads`、`./data/exports` |
| 网络 | 内部 DNS：`api`→`db`；对外只暴露 web（或 web+api） |
| 健康检查 | db `pg_isready`；api `/health` |

## 3. 实现步骤

1. 补全 Dockerfile（api：Python slim；web：多阶段 build → nginx 托管 `dist`）
2. `docker-compose` 环境变量从 `.env` 注入，**不要**写死 Key
3. API 启动执行 `CREATE EXTENSION IF NOT EXISTS vector`
4. 写 `README-运行.md`：复制 env → up → 打开端口 → 常见问题（端口占用、权限）
5. （可选）根路径由 nginx 反代 `/api` → `api:8000`

## 4. 目录约定

```text
data/uploads/   # 原件
data/exports/   # 导出临时 ZIP
data/tmp/       # 转写/解析临时文件，可定期清
```

## 5. 验收

- [ ] 新机器仅 Docker + 本文档即可拉起
- [ ] 重启后上传目录与 DB 数据仍在
- [ ] 日志中无 Key 明文打印

## 6. 完成后再做

[02-模型配置与Key](./02-模型配置与Key.md)
