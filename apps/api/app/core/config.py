from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # 可空：空则在无 runtime-db.json 时回落到默认 SQLite（见 runtime_db.resolve_database_url）
    # Compose / 云部署仍可通过 DATABASE_URL 指定 Postgres
    database_url: str = ""
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_api_key: str = ""
    llm_chat_model: str = "deepseek-v4-flash"
    llm_embed_model: str = "deepseek-v4-flash"
    api_cors_origins: str = "http://localhost:5173,http://localhost:8080"
    # 本机开发默认仓库根下 data/；Compose 内通过 DATA_DIR=/data 覆盖
    data_dir: str = "data"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.api_cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
