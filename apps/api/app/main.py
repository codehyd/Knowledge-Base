"""空库 API 入口：只负责组装各功能模块路由，不含业务逻辑。"""

from contextlib import asynccontextmanager
import asyncio
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.database import init_db
from app.core.knife4j import setup_knife4j
from app.modules.chat.router import router as chat_router
from app.modules.health.router import router as health_router
from app.modules.knowledge.router import router as knowledge_router
from app.modules.library.router import router as library_router
from app.modules.overview.router import router as overview_router
from app.modules.settings_ai.router import router as settings_ai_router
from app.modules.settings_db.router import router as settings_db_router
from app.modules.open_books.router import router as open_books_router
from app.modules.sources.router import router as sources_router
from app.modules.skills.router import router as skills_router
from app.modules.vault.router import router as vault_router


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

    # 先对外可服务，再后台补索引（with_embed 会打模型，同步跑会拖死启动 /health）
    async def _reindex_missing_bg() -> None:
        try:
            from app.core import database as db_mod
            from app.modules.knowledge.index import reindex_missing

            status = await db_mod.schema_status()
            if not status.get("schema_ready"):
                return
            if db_mod.SessionLocal is None:
                db_mod.init_engine_from_config()
            assert db_mod.SessionLocal is not None
            async with db_mod.SessionLocal() as db:
                stats = await reindex_missing(db, with_embed=True)
            print(f"[kongku] background reindex_missing: {stats}")
        except Exception as exc:
            print(f"[kongku] background reindex_missing skipped: {exc}")

    task = asyncio.create_task(_reindex_missing_bg())
    yield
    if not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


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

    # 本机优先：Electron loadFile → Origin "null"；Vite 开发页 41779；
    # 手动起 API 时也要放行，否则桌面端 / 跨端口会 OPTIONS 400 → Failed to fetch
    origins = list(settings.cors_origins)
    for extra in (
        "null",
        "file://",
        "http://127.0.0.1:41779",
        "http://localhost:41779",
        "http://127.0.0.1:18765",
        "http://localhost:18765",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ):
        if extra not in origins:
            origins.append(extra)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition", "X-Kongku-Filename"],
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
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
    app.include_router(library_router, prefix="/api")
    app.include_router(knowledge_router, prefix="/api")
    app.include_router(chat_router, prefix="/api")
    app.include_router(skills_router, prefix="/api")
    app.include_router(vault_router, prefix="/api")

    # 桌面端：由 API 同源托管前端静态资源，避免 file:// 跨域
    web_dir = os.environ.get("KONGKU_WEB_DIR", "").strip()
    if web_dir:
        from pathlib import Path

        from fastapi import Request
        from fastapi.staticfiles import StaticFiles
        from starlette.middleware.base import BaseHTTPMiddleware

        web_path = Path(web_dir)
        if web_path.is_dir():

            class WebCacheControlMiddleware(BaseHTTPMiddleware):
                """避免 Electron 对固定 localhost 前端强缓存导致升级后仍是旧界面。

                - HTML / 入口：no-store（每次拿最新 index）
                - /assets/* 带 hash：可长期缓存
                - 其余静态：短缓存且必须再验证
                """

                async def dispatch(self, request: Request, call_next):
                    response = await call_next(request)
                    path = request.url.path or "/"
                    # 只处理静态页，别动 /api
                    if path.startswith("/api") or path.startswith("/health"):
                        return response
                    if path == "/" or path.endswith(".html"):
                        response.headers["Cache-Control"] = (
                            "no-store, no-cache, must-revalidate, max-age=0"
                        )
                        response.headers["Pragma"] = "no-cache"
                    elif "/assets/" in path:
                        response.headers["Cache-Control"] = (
                            "public, max-age=31536000, immutable"
                        )
                    else:
                        response.headers["Cache-Control"] = (
                            "no-cache, must-revalidate, max-age=0"
                        )
                    return response

            # 中间件后注册也会包住后续 mount；这里先加中间件再 mount
            app.add_middleware(WebCacheControlMiddleware)
            app.mount(
                "/",
                StaticFiles(directory=str(web_path), html=True),
                name="web",
            )
            print(f"[kongku] serving web UI from {web_path}")

    return app


app = create_app()
