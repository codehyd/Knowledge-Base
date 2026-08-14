from pathlib import Path

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db

from app.modules.vault.schemas import (
    VaultFolderIn,
    VaultGraphOut,
    VaultImportIn,
    VaultLinkTargetsOut,
    VaultNodeOut,
    VaultNodePatchIn,
    VaultNoteCreateIn,
    VaultNoteOut,
    VaultNoteSaveIn,
    VaultTreeOut,
)
from app.modules.vault.service import vault_service

router = APIRouter(prefix="/vault", tags=["笔记库"])

_MEDIA = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


@router.get("/tree", response_model=VaultTreeOut, summary="笔记库文件树")
async def get_tree(db: AsyncSession = Depends(get_db)) -> VaultTreeOut:
    return await vault_service.tree(db)


@router.get(
    "/graph",
    response_model=VaultGraphOut,
    summary="知识库关系图",
    description=(
        "笔记双链 [[wikilink]] + 已入库条目（书籍/视频/网页）+ 分类枢纽。"
        "视频/书籍会扫描转写与抽取正文中的双链。"
    ),
)
async def get_graph(db: AsyncSession = Depends(get_db)) -> VaultGraphOut:
    return await vault_service.graph(db)


@router.get(
    "/link-targets",
    response_model=VaultLinkTargetsOut,
    summary="双链补全目标",
    description="按标题/路径/文件名搜索 vault 笔记，供 [[ 补全与点击解析。",
)
async def get_link_targets(
    q: str = Query(default="", description="搜索关键字"),
    limit: int = Query(default=20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
) -> VaultLinkTargetsOut:
    return await vault_service.link_targets(db, q=q, limit=limit)


@router.post("/folders", response_model=VaultNodeOut, summary="新建文件夹")
async def create_folder(
    payload: VaultFolderIn, db: AsyncSession = Depends(get_db)
) -> VaultNodeOut:
    return await vault_service.create_folder(db, payload)


@router.post("/notes", response_model=VaultNoteOut, summary="新建笔记")
async def create_note(
    payload: VaultNoteCreateIn, db: AsyncSession = Depends(get_db)
) -> VaultNoteOut:
    return await vault_service.create_note(db, payload)


@router.get("/notes/{source_id}", response_model=VaultNoteOut, summary="读取笔记")
async def get_note(source_id: int, db: AsyncSession = Depends(get_db)) -> VaultNoteOut:
    return await vault_service.get_note(db, source_id)


@router.put("/notes/{source_id}", response_model=VaultNoteOut, summary="保存笔记并自动入库")
async def save_note(
    source_id: int,
    payload: VaultNoteSaveIn,
    db: AsyncSession = Depends(get_db),
) -> VaultNoteOut:
    return await vault_service.save_note(db, source_id, payload)


@router.post("/notes/{source_id}/assets", summary="上传笔记内嵌图片")
async def upload_note_asset(
    source_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    data = await file.read()
    return await vault_service.upload_asset(
        db, source_id, file.filename or "image.png", data
    )


@router.get("/files/{path:path}", summary="读取笔记资源（_assets）")
async def get_vault_file(path: str) -> FileResponse:
    file_path = vault_service.resolve_asset(path)
    media = _MEDIA.get(Path(file_path.name).suffix.lower(), "application/octet-stream")
    return FileResponse(file_path, media_type=media)


@router.patch("/nodes", response_model=VaultNodeOut, summary="重命名或移动节点")
async def patch_node(
    payload: VaultNodePatchIn, db: AsyncSession = Depends(get_db)
) -> VaultNodeOut:
    return await vault_service.patch_node(db, payload)


@router.delete("/notes/{source_id}", summary="删除笔记")
async def delete_note(source_id: int, db: AsyncSession = Depends(get_db)) -> dict:
    return await vault_service.delete_note(db, source_id)


@router.post("/register", response_model=VaultNoteOut, summary="重新登记未关联的笔记文件")
async def register_path(
    path: str, db: AsyncSession = Depends(get_db)
) -> VaultNoteOut:
    return await vault_service.register_path(db, path)


@router.delete("/paths", summary="按路径删除笔记或文件夹（含未登记 orphan）")
async def delete_path(path: str, db: AsyncSession = Depends(get_db)) -> dict:
    return await vault_service.delete_path(db, path)


@router.delete("/folders", summary="删除文件夹（含其下笔记）")
async def delete_folder(path: str, db: AsyncSession = Depends(get_db)) -> dict:
    return await vault_service.delete_folder(db, path)


@router.post("/import", response_model=VaultNoteOut, summary="将已有笔记导入笔记库")
async def import_note(
    payload: VaultImportIn, db: AsyncSession = Depends(get_db)
) -> VaultNoteOut:
    return await vault_service.import_source(db, payload)
