from typing import Literal, Optional

from pydantic import BaseModel, Field

DbMode = Literal["sqlite", "postgres"]


class DbSettingsOut(BaseModel):
    mode: DbMode
    sqlite_path: str
    postgres_url_masked: str = ""
    postgres_configured: bool = False
    postgres_host: str = ""
    postgres_port: str = "5432"
    postgres_database: str = ""
    postgres_username: str = ""
    effective_url_masked: str = ""
    connected: bool
    message: str = ""
    schema_ready: bool = False
    missing_tables: list[str] = Field(default_factory=list)
    schema_message: str = ""


class DbSettingsUpdate(BaseModel):
    mode: DbMode = "sqlite"
    sqlite_path: str = Field(default="kongku.db")
    postgres_url: Optional[str] = None
    postgres_host: Optional[str] = None
    postgres_port: Optional[str] = None
    postgres_database: Optional[str] = None
    postgres_username: Optional[str] = None
    postgres_password: Optional[str] = None


class DbTestRequest(BaseModel):
    mode: DbMode = "sqlite"
    sqlite_path: str = Field(default="kongku.db")
    postgres_url: Optional[str] = None
    postgres_host: Optional[str] = None
    postgres_port: Optional[str] = None
    postgres_database: Optional[str] = None
    postgres_username: Optional[str] = None
    postgres_password: Optional[str] = None


class DbTestOut(BaseModel):
    ok: bool
    message: str = ""


class DbInitOut(BaseModel):
    ok: bool
    message: str = ""
    created_tables: list[str] = Field(default_factory=list)
    schema_ready: bool = False
    missing_tables: list[str] = Field(default_factory=list)
    vector_extension: bool = False
