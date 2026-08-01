from pydantic import BaseModel, Field


class HealthOut(BaseModel):
    ok: bool = Field(description="API 进程是否可用")
    service: str = "kongku-api"
    version: str = Field(default="", description="API 版本（与桌面端对齐）")
    features: list[str] = Field(
        default_factory=list,
        description="已挂载能力，供桌面端判断是否为过期 sidecar",
    )
    database: bool = Field(description="数据库是否可连接")
    database_message: str = Field(
        default="",
        description="数据库不可用时的说明；可用时为空",
    )
