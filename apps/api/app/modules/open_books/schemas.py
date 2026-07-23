from pydantic import BaseModel, Field


class OpenBookSourceInfo(BaseModel):
    id: str
    name: str
    description: str = ""
    languages: list[str] = Field(default_factory=list)


class OpenBookItem(BaseModel):
    id: str
    title: str
    authors: list[str] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=list)
    download_count: int = 0
    cover_url: str = ""
    has_epub: bool = False
    has_text: bool = False
    source: str = "gutenberg"
    detail_url: str = ""
    snippet: str = ""


class OpenBookSearchOut(BaseModel):
    query: str
    source: str
    total: int = 0
    items: list[OpenBookItem] = Field(default_factory=list)
    notice: str = ""


class OpenBookSourcesOut(BaseModel):
    items: list[OpenBookSourceInfo] = Field(default_factory=list)
    default_source: str = "zh_open"


class OpenBookImportIn(BaseModel):
    source: str = Field(default="zh_open", description="书源 id")
    book_id: str = Field(..., description="源内书籍 id")
    direct_ingest: bool = Field(
        default=False,
        description="若为 true 且设置允许，则抽取完成后自动入库",
    )


class OpenBookImportJobOut(BaseModel):
    job_id: str
    status: str
    progress: int = 0
    message: str = ""
    source_id: int | None = None
    title: str = ""
    filename: str = ""
    direct_ingest: bool = False
    error: str = ""


class FeedOpenBookSettingsOut(BaseModel):
    open_ebook_direct_ingest: bool = False
    description: str = (
        "开启后，公版书搜索结果可「直接入库」（下载并抽取后自动写入知识库）。"
        "默认关闭：仅下载到喂养队列，需预览确认后再入库。"
    )
    ctext_api_key_masked: str = ""
    ctext_configured: bool = False
    ctext_keys_url: str = "https://ctext.org/tools/subscribe"
    ctext_docs_url: str = "https://ctext.org/tools/api"
    ctext_hint: str = (
        "用于「中国哲书库」全文下载。Key 由机构订阅发放，可能过期，非个人免费自助申请。"
        "多数场景用「中文公版」即可，不必配置。"
    )
    mirror_repo: str = "xp44mm/hanchuancaolu"
    mirror_ref: str = "master"
    mirror_presets: list[dict] = Field(default_factory=list)
    mirror_hint: str = (
        "「中文公版」会动态读取该 GitHub 仓库的目录作为可搜书目（经 CDN 加速）。"
        "一般选推荐即可；高级用户可填 owner/repo。"
    )


class FeedOpenBookSettingsUpdate(BaseModel):
    open_ebook_direct_ingest: bool | None = None
    ctext_api_key: str | None = Field(
        default=None,
        description="传入非空则更新；传入空字符串则清除；省略则不改",
    )
    mirror_repo: str | None = None
    mirror_ref: str | None = None
