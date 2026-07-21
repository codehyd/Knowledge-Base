from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+asyncpg://kongku:kongku@localhost:5432/kongku"
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_api_key: str = ""
    llm_chat_model: str = "deepseek-v4-flash"
    llm_embed_model: str = "deepseek-v4-flash"
    api_cors_origins: str = "http://localhost:5173,http://localhost:8080"
    data_dir: str = "/data"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.api_cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
