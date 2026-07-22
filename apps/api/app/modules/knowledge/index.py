"""条目切片索引：写入 chunks，可选 embedding。"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.llm import dump_embedding, embed_texts
from app.modules.knowledge.chunking import split_text
from app.modules.knowledge.models import Chunk, Entry
from app.modules.sources.models import Source

# index.py → knowledge → modules → app → api → apps → 仓库根
_REPO_ROOT = Path(__file__).resolve().parents[5]


def _data_root() -> Path:
    settings = get_settings()
    root = Path(settings.data_dir)
    if not root.is_absolute():
        root = _REPO_ROOT / root
    return root


def read_entry_text(entry: Entry, source: Source | None) -> str:
    """读取条目关联正文。"""
    if source and source.text_path:
        path = _data_root() / source.text_path
        if path.is_file():
            return path.read_text(encoding="utf-8", errors="ignore")
    if entry.source_id:
        orphan = _data_root() / "uploads" / str(entry.source_id) / "extracted.txt"
        if orphan.is_file():
            return orphan.read_text(encoding="utf-8", errors="ignore")
    return ""


async def index_entry(db: AsyncSession, entry_id: int, *, with_embed: bool = True) -> int:
    """删除旧切片并重建；返回写入条数。"""
    entry = await db.get(Entry, entry_id)
    if not entry:
        return 0

    source = await db.get(Source, entry.source_id) if entry.source_id else None
    text = read_entry_text(entry, source).strip()
    pieces = split_text(text)
    await db.execute(delete(Chunk).where(Chunk.entry_id == entry_id))
    if not pieces:
        await db.commit()
        return 0

    vectors: list[list[float]] | None = None
    if with_embed:
        # 分批 embed，避免超长请求
        vectors = []
        batch_size = 16
        for i in range(0, len(pieces), batch_size):
            batch = pieces[i : i + batch_size]
            emb = await embed_texts(db, batch)
            if emb is None:
                vectors = None
                break
            vectors.extend(emb)

    rows: list[Chunk] = []
    for i, piece in enumerate(pieces):
        emb_raw = ""
        if vectors is not None and i < len(vectors):
            emb_raw = dump_embedding(vectors[i])
        rows.append(
            Chunk(
                entry_id=entry_id,
                ord=i,
                text=piece,
                char_count=len(piece),
                embedding=emb_raw,
            )
        )
    db.add_all(rows)
    await db.commit()
    return len(rows)


async def reindex_missing(db: AsyncSession, *, with_embed: bool = True) -> dict[str, int]:
    """为尚无切片的条目建索引。"""
    subq = select(Chunk.entry_id).distinct()
    result = await db.execute(select(Entry.id).where(Entry.id.notin_(subq)).order_by(Entry.id))
    ids = [int(x) for x in result.scalars().all()]
    indexed = 0
    chunks = 0
    for eid in ids:
        n = await index_entry(db, eid, with_embed=with_embed)
        indexed += 1
        chunks += n
    return {"entries": indexed, "chunks": chunks, "scanned": len(ids)}


async def reindex_all(db: AsyncSession, *, with_embed: bool = True) -> dict[str, int]:
    result = await db.execute(select(Entry.id).order_by(Entry.id))
    ids = [int(x) for x in result.scalars().all()]
    chunks = 0
    for eid in ids:
        chunks += await index_entry(db, eid, with_embed=with_embed)
    return {"entries": len(ids), "chunks": chunks}


async def chunk_stats(db: AsyncSession) -> dict[str, int]:
    entry_count = int((await db.execute(select(func.count()).select_from(Entry))).scalar_one())
    chunk_count = int((await db.execute(select(func.count()).select_from(Chunk))).scalar_one())
    return {"entries": entry_count, "chunks": chunk_count}
