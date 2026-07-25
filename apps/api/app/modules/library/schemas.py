from pydantic import BaseModel, Field


class LibraryFileOut(BaseModel):
    name: str
    kind: str = Field(description="text | audio | cues | original | meta | other")
    size: int = 0
    path: str = Field(description="相对 data 的路径")


class LibraryItemOut(BaseModel):
    source_id: int
    title: str
    category: str
    folder_name: str
    folder_path: str = Field(description="相对 data 的目录路径")
    absolute_path: str
    type: str = ""
    status: str = ""
    files: list[LibraryFileOut] = Field(default_factory=list)


class LibraryCategoryOut(BaseModel):
    key: str
    label: str
    path: str
    absolute_path: str
    item_count: int = 0
    items: list[LibraryItemOut] = Field(default_factory=list)


class LibraryOut(BaseModel):
    root_path: str
    absolute_root: str
    categories: list[LibraryCategoryOut] = Field(default_factory=list)
    total_items: int = 0


class LibraryRebuildOut(BaseModel):
    ok: bool = True
    synced: int = 0
    removed: int = 0
    message: str = ""
