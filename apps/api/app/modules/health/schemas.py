from pydantic import BaseModel


class HealthOut(BaseModel):
    ok: bool
    service: str = "kongku-api"
