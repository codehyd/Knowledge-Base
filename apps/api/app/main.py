"""空库 API 入口：只负责组装各功能模块路由，不含业务逻辑。"""

from contextlib import asynccontextmanager

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

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

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

    return app


app = create_app()
