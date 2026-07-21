"""空库 API 入口：只负责组装各功能模块路由，不含业务逻辑。"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.database import init_db
from app.modules.health.router import router as health_router
from app.modules.overview.router import router as overview_router
from app.modules.settings_ai.router import router as settings_ai_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="空库 API", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 按功能模块挂载；后续新功能只加一行 include_router
    app.include_router(health_router)
    app.include_router(overview_router, prefix="/api")
    app.include_router(settings_ai_router, prefix="/api")

    return app


app = create_app()
