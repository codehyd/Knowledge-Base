from pydantic import BaseModel, Field


class HealthOut(BaseModel):
    ok: bool = Field(description="API 进程是否可用")
    service: str = "kongku-api"
    database: bool = Field(description="数据库是否可连接")
    database_message: str = Field(
        default="",
        description="数据库不可用时的说明；可用时为空",
    )
