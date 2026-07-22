from fastapi import APIRouter

from app.modules.health.schemas import HealthOut
from app.modules.health.service import health_service

router = APIRouter(tags=["健康检查"])


@router.get(
    "/health",
    response_model=HealthOut,
    summary="健康检查",
    description=(
        "探测 API 进程与数据库是否可用。"
        "无数据库时仍返回 200，database=false，并给出中文说明。"
    ),
)
async def health() -> HealthOut:
    return await health_service.check()
