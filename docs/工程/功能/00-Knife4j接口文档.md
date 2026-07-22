# 功能 · Knife4j 接口文档

> 对应 Java 生态常见的 Knife4j（`/doc.html`）开发文档体验。  
> Python/FastAPI **没有官方 Knife4j starter**，本项目采用：FastAPI 生成 OpenAPI + 内置 `knife4j-openapi3-ui` 前端静态资源。

## 1. 目标

- 主入口：`http://<host>:<api>/doc.html`
- `/docs`、`/redoc` 自动跳转到 `/doc.html`
- 左侧按中文 **tag 分组**（健康检查 / 概览统计 / 模型配置 …）
- 支持在线调试（与 Swagger 类似，UI 为 Knife4j）

## 2. 实现要点

| 项 | 路径 / 做法 |
|----|-------------|
| UI 静态资源 | `apps/api/app/static/knife4j/`（来自 `knife4j-openapi3-ui`） |
| 装配代码 | `apps/api/app/core/knife4j.py` → `setup_knife4j(app)` |
| OpenAPI | FastAPI 原生；额外暴露 `/v3/api-docs` 兼容 Knife4j 默认拉取 |
| 配置发现 | `/v3/api-docs/swagger-config` |
| 路由 tags | 使用中文 tag + `summary`/`description`，写入 OpenAPI |

## 3. 新增接口时约定

1. `APIRouter(tags=["中文分组名"])`  
2. 在 `app/core/knife4j.py` 的 `OPENAPI_TAGS` 中登记该分组说明（可选但推荐）  
3. 每个路由补 `summary`（列表页显示）  
4. 打开 `/doc.html` 确认分组与试调

## 4. 验收

- [ ] 访问 `/doc.html` 可见 Knife4j 界面  
- [ ] 分组为中文，接口可展开试调  
- [ ] `/docs` 跳转到 `/doc.html`  
- [ ] Compose 经 Nginx 反代后，`:8080/doc.html` 可打开  

## 5. 资源更新（可选）

若需升级 Knife4j UI 版本：从 Maven 下载新版 `knife4j-openapi3-ui-*.jar`，解压 `META-INF/resources/` 覆盖 `app/static/knife4j/`。
