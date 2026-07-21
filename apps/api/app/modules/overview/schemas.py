from pydantic import BaseModel


class OverviewOut(BaseModel):
    entries: int
    key_configured: bool
    empty_library: bool
