from pydantic import BaseModel, Field


class VaultNodeOut(BaseModel):
    id: str = Field(description="相对 vault 的路径，文件夹无后缀 / 笔记为 .md 路径")
    name: str
    kind: str = Field(description="folder | note")
    path: str = Field(description="相对 vault 的路径")
    source_id: int | None = None
    title: str = ""
    status: str = ""
    children: list["VaultNodeOut"] = Field(default_factory=list)


class VaultTreeOut(BaseModel):
    root: str = "library/笔记库"
    absolute_root: str = ""
    nodes: list[VaultNodeOut] = Field(default_factory=list)


class VaultFolderIn(BaseModel):
    parent: str = Field(default="", description="相对 vault 的父目录，空=根")
    name: str = Field(min_length=1, max_length=120)


class VaultNoteCreateIn(BaseModel):
    parent: str = Field(default="", description="相对 vault 的父目录，空=根")
    title: str = Field(default="未命名笔记", max_length=200)


class VaultNoteOut(BaseModel):
    source_id: int
    title: str
    path: str
    content: str
    status: str = ""
    committed: bool = False
    char_count: int = 0
    source_lake: str | None = Field(default=None, description="Lake 编辑器源文档（实验，双份存储）")


class VaultNoteSaveIn(BaseModel):
    title: str = Field(default="", max_length=500)
    content: str = Field(default="")
    source_lake: str | None = Field(
        default=None,
        description="Lake 编辑器源文档；None 不动伴生文件，空串删除，非空写入",
    )


class VaultNodePatchIn(BaseModel):
    path: str = Field(min_length=1, description="当前相对路径（文件夹或 .md）")
    new_parent: str | None = Field(default=None, description="移动到的父目录；null 不改")
    new_name: str | None = Field(default=None, description="新名称；null 不改")


class VaultImportIn(BaseModel):
    source_id: int
    parent: str = Field(default="", description="导入到 vault 的父目录")


class VaultGraphNodeOut(BaseModel):
    id: str = Field(description="稳定节点 id：note:path / entry:id / cat:name")
    title: str
    path: str = ""
    source_id: int | None = None
    entry_id: int | None = None
    kind: str = Field(
        default="note",
        description="note|book|video|url|web|category|other",
    )
    degree: int = 0


class VaultGraphEdgeOut(BaseModel):
    source: str
    target: str
    kind: str = Field(
        default="wikilink",
        description="wikilink|in_category",
    )
    resolved: bool = True
    label: str = ""


class VaultBrokenLinkOut(BaseModel):
    source: str
    target: str
    label: str = ""


class VaultGraphOut(BaseModel):
    nodes: list[VaultGraphNodeOut] = Field(default_factory=list)
    edges: list[VaultGraphEdgeOut] = Field(default_factory=list)
    broken_links: list[VaultBrokenLinkOut] = Field(default_factory=list)


VaultNodeOut.model_rebuild()
