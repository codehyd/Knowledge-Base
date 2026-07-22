"""Knife4j 风格接口文档（对齐 Java 生态的 /doc.html 体验）。

静态资源来自 knife4j-openapi3-ui，OpenAPI JSON 由 FastAPI 生成；
通过 /v3/api-docs 与 springdoc 兼容入口供 Knife4j 前端拉取。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

STATIC_ROOT = Path(__file__).resolve().parent.parent / "static" / "knife4j"

# Knife4j 左侧分组顺序（name 必须与路由 tags 一致）
OPENAPI_TAGS = [
    {
        "name": "健康检查",
        "description": "服务存活与数据库连通性",
    },
    {
        "name": "概览统计",
        "description": "空库首页所需的条目数、Key 是否已配置等",
    },
    {
        "name": "模型配置",
        "description": "AI Provider / API Key / 对话与向量模型；支持连接测试",
    },
    {
        "name": "喂养投递",
        "description": "电子书 / 笔记 / 链接投递、正文抽取与解析队列",
    },
]


def custom_openapi(app: FastAPI):
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
        tags=OPENAPI_TAGS,
    )
    schema["info"]["x-logo"] = {
        "altText": "空库 API",
    }
    # 便于 Knife4j 展示联系人/说明
    schema["info"]["contact"] = {
        "name": "空库工程",
        "url": "https://github.com/",
    }
    app.openapi_schema = schema
    return app.openapi_schema


def setup_knife4j(app: FastAPI) -> None:
    """挂载 Knife4j UI，并关闭默认 /docs（保留 /openapi.json）。"""
    if not STATIC_ROOT.exists():
        raise RuntimeError(f"Knife4j 静态资源缺失: {STATIC_ROOT}")

    app.mount(
        "/webjars",
        StaticFiles(directory=STATIC_ROOT / "webjars"),
        name="knife4j-webjars",
    )
    img_dir = STATIC_ROOT / "img"
    if img_dir.exists():
        app.mount("/img", StaticFiles(directory=img_dir), name="knife4j-img")

    @app.get("/doc.html", include_in_schema=False)
    async def knife4j_index():
        return FileResponse(STATIC_ROOT / "doc.html")

    @app.get("/docs", include_in_schema=False)
    async def docs_redirect():
        return RedirectResponse(url="/doc.html")

    @app.get("/redoc", include_in_schema=False)
    async def redoc_redirect():
        return RedirectResponse(url="/doc.html")

    @app.get("/v3/api-docs", include_in_schema=False)
    async def v3_api_docs():
        return app.openapi()

    @app.get("/v3/api-docs/swagger-config", include_in_schema=False)
    async def v3_swagger_config():
        # 兼容 Knife4j / springdoc 默认拉取路径
        return {
            "configUrl": "/v3/api-docs/swagger-config",
            "oauth2RedirectUrl": "/webjars/oauth/oauth2.html",
            "url": "/v3/api-docs",
            "urls": [{"url": "/v3/api-docs", "name": "default"}],
            "validatorUrl": "",
        }

    app.openapi = lambda: custom_openapi(app)  # type: ignore[method-assign]
