"""空库 API 入口：只负责组装各功能模块路由，不含业务逻辑。"""

from contextlib import asynccontextmanager
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.database import init_db
from app.core.knife4j import setup_knife4j
from app.modules.chat.router import router as chat_router
from app.modules.health.router import router as health_router
from app.modules.knowledge.router import router as knowledge_router
from app.modules.overview.router import router as overview_router
from app.modules.settings_ai.router import router as settings_ai_router
from app.modules.settings_db.router import router as settings_db_router
from app.modules.open_books.router import router as open_books_router
from app.modules.sources.router import router as sources_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    # SQLite：启动时自动建表对齐；Postgres：只探测，表结构由设置页「初始化」按钮触发
    try:
        from app.core import database as db_mod
        from app.core.runtime_db import detect_mode_from_url, resolve_database_url

        mode = detect_mode_from_url(resolve_database_url())
        if mode == "sqlite":
            result = await init_db()
            print(f"[kongku] init_db ok (sqlite): {result.get('message')}")
        else:
            status = await db_mod.schema_status()
            print(
                f"[kongku] postgres connected={status.get('connected')} "
                f"schema_ready={status.get('schema_ready')}"
            )
    except Exception as exc:
        print(f"[kongku] init_db skipped (database unavailable or failed): {exc}")

    # 启动时为尚无切片的已入库条目自动回填（失败不阻塞服务）
    try:
        from app.core import database as db_mod
        from app.modules.knowledge.index import reindex_missing

        status = await db_mod.schema_status()
        if status.get("schema_ready"):
            if db_mod.SessionLocal is None:
                db_mod.init_engine_from_config()
            assert db_mod.SessionLocal is not None
            async with db_mod.SessionLocal() as db:
                await reindex_missing(db, with_embed=True)
    except Exception:
        pass
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    desktop = os.environ.get("KONGKU_DESKTOP", "").strip() in {"1", "true", "TRUE", "yes"}
    app = FastAPI(
        title="空库 API",
        version="0.1.0",
        description=(
            "## 空库 · 个人认知知识库 API\n\n"
            "- 默认空库，自行喂养电子书 / 笔记 / 视频链接\n"
            "- 对话只按库内作答，证据不足则拒答\n"
            "- API Key（如 DeepSeek）自备，可在设置接口中配置\n\n"
            "开发文档入口：**[/doc.html](/doc.html)**（Knife4j）"
        ),
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )

    # 桌面端 loadFile → Origin 为 "null"；仅放行 Vite 源会导致 Failed to fetch
    cors_kwargs: dict = {
        "allow_methods": ["*"],
        "allow_headers": ["*"],
        "expose_headers": ["Content-Disposition", "X-Kongku-Filename"],
    }
    if desktop:
        # 明确放行 Electron file://（Origin: null）与本机开发页
        origins = list(settings.cors_origins)
        for extra in (
            "null",
            "file://",
            "http://127.0.0.1:41779",
            "http://localhost:41779",
            "http://127.0.0.1:18765",
            "http://localhost:18765",
        ):
            if extra not in origins:
                origins.append(extra)
        cors_kwargs.update(
            {
                "allow_origins": origins,
                "allow_credentials": True,
                "allow_origin_regex": r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
            }
        )
    else:
        cors_kwargs.update(
            {
                "allow_origins": settings.cors_origins,
                "allow_credentials": True,
            }
        )
    app.add_middleware(CORSMiddleware, **cors_kwargs)

    # Knife4j：/doc.html + /v3/api-docs（兼容 springdoc 拉取方式）
    setup_knife4j(app)

    # 按功能模块挂载；后续新功能只加一行 include_router
    app.include_router(health_router)
    app.include_router(overview_router, prefix="/api")
    app.include_router(settings_ai_router, prefix="/api")
    app.include_router(settings_db_router, prefix="/api")
    app.include_router(open_books_router, prefix="/api")
    app.include_router(sources_router, prefix="/api")
    app.include_router(knowledge_router, prefix="/api")
    app.include_router(chat_router, prefix="/api")

    # 桌面端：由 API 同源托管前端静态资源，避免 file:// 跨域
    web_dir = os.environ.get("KONGKU_WEB_DIR", "").strip()
    if web_dir:
        from pathlib import Path

        from fastapi.staticfiles import StaticFiles

        web_path = Path(web_dir)
        if web_path.is_dir():
            app.mount(
                "/",
                StaticFiles(directory=str(web_path), html=True),
                name="web",
            )
            print(f"[kongku] serving web UI from {web_path}")

    return app


app = create_app()
