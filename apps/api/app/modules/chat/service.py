"""知识对话：检索 + 拒答闸门 + LLM + 会话落库。"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.llm import (
    LlmNotConfigured,
    chat_completion,
    cosine_similarity,
    embed_texts,
    load_embedding,
)
from app.modules.chat.models import ChatMessage, ChatSession
from app.modules.chat.schemas import (
    ChatCitation,
    ChatIn,
    ChatMessageListOut,
    ChatMessageOut,
    ChatOut,
    ChatSessionCreate,
    ChatSessionListOut,
    ChatSessionOut,
)
from app.modules.knowledge.models import Chunk, Entry, EntryCategory
from app.modules.settings_ai.service import settings_ai_service

TOP_K = 6
# 关键词：至少命中分数；向量：cosine 相似度下限
KEYWORD_MIN_SCORE = 1.5
VECTOR_MIN_SCORE = 0.28
SNIPPET_CHARS = 220

REFUSAL_TEXT = (
    "根据当前知识库中的内容，我无法有依据地回答这个问题。"
    "请换一个与已入库资料相关的问题，或先去喂养相关材料。"
)

SYSTEM_PROMPT = """你是「空库」知识助手。请主要依据下方【资料片段】回答用户问题。
规则：
1. 优先用资料中的表述总结作答，可适当组织语言，但不要编造资料未提及的事实。
2. 仅当资料与问题明显无关时，才回复一句：资料不足，无法有依据地回答。
3. 回答简洁、用中文。
4. 不要编造书名、页码或未出现的出处。
"""

_STOPWORDS = {
    "什么",
    "怎么",
    "如何",
    "怎样",
    "是否",
    "为什么",
    "为何",
    "请问",
    "一下",
    "这个",
    "那个",
    "可以",
    "没有",
    "如果",
    "因为",
    "所以",
    "我们",
    "你们",
    "他们",
    "一个",
    "一种",
    "一些",
    "意思",
    "说说",
    "讲讲",
    "看看",
    "是不是",
    "有没有",
    "是什",
    "什么意",
    "么意思",
    "是什么",
    "气是",
    "么意",
}


def _tokenize_query(message: str) -> list[str]:
    text = re.sub(r"[，。！？、；：\"'“”‘’（）()【】\[\]《》<>\s]+", " ", (message or "").strip())
    parts = re.findall(r"[\u4e00-\u9fff]{2,}|[a-z0-9_]{2,}", text, flags=re.I)
    tokens: list[str] = []
    seen: set[str] = set()

    def add(tok: str) -> None:
        t = tok.strip().lower()
        if len(t) < 2 or t in _STOPWORDS or t in seen:
            return
        seen.add(t)
        tokens.append(t)

    for p in parts:
        add(p)
        if re.fullmatch(r"[\u4e00-\u9fff]+", p):
            # 2~3 字窗口，过滤停用词
            for n in (2, 3):
                if len(p) < n:
                    continue
                for i in range(len(p) - n + 1):
                    add(p[i : i + n])
    return tokens[:48]


def _keyword_score(text: str, tokens: list[str]) -> float:
    if not tokens:
        return 0.0
    low = text.lower()
    score = 0.0
    for t in tokens:
        if t not in low:
            continue
        # 更长词权重更高；出现次数有上限
        count = min(3, low.count(t))
        score += count * (1.0 + min(3.0, len(t) / 4.0))
    return score


_NOISE_HINTS = ("copyright", "isbn", "印刷", "责任编辑", "all rights reserved", "cip数据")


def _is_noisy_chunk(text: str) -> bool:
    low = (text or "").lower()
    hits = sum(1 for h in _NOISE_HINTS if h in low)
    return hits >= 2


class ChatService:
    def _title_from_message(self, message: str) -> str:
        text = re.sub(r"\s+", " ", (message or "").strip())
        if not text:
            return "新对话"
        return text[:40] + ("…" if len(text) > 40 else "")

    def _msg_out(self, row: ChatMessage) -> ChatMessageOut:
        citations: list[ChatCitation] = []
        raw = (row.citations_json or "").strip()
        if raw:
            try:
                data = json.loads(raw)
                if isinstance(data, list):
                    citations = [ChatCitation.model_validate(x) for x in data]
            except Exception:
                citations = []
        return ChatMessageOut(
            id=row.id,
            session_id=row.session_id,
            role=row.role,
            content=row.content or "",
            refused=bool(row.refused),
            citations=citations,
            created_at=row.created_at,
        )

    async def list_sessions(self, db: AsyncSession) -> ChatSessionListOut:
        result = await db.execute(
            select(ChatSession).order_by(ChatSession.updated_at.desc(), ChatSession.id.desc())
        )
        rows = list(result.scalars().all())
        return ChatSessionListOut(items=[ChatSessionOut.model_validate(r) for r in rows])

    async def create_session(
        self, db: AsyncSession, payload: ChatSessionCreate | None = None
    ) -> ChatSessionOut:
        payload = payload or ChatSessionCreate()
        row = ChatSession(
            title=(payload.title or "新对话").strip()[:120] or "新对话",
            category_id=payload.category_id,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return ChatSessionOut.model_validate(row)

    async def delete_session(self, db: AsyncSession, session_id: int) -> None:
        row = await db.get(ChatSession, session_id)
        if not row:
            raise HTTPException(status_code=404, detail="会话不存在")
        await db.execute(delete(ChatMessage).where(ChatMessage.session_id == session_id))
        await db.delete(row)
        await db.commit()

    async def list_messages(self, db: AsyncSession, session_id: int) -> ChatMessageListOut:
        session = await db.get(ChatSession, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="会话不存在")
        result = await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.id.asc())
        )
        rows = list(result.scalars().all())
        return ChatMessageListOut(items=[self._msg_out(r) for r in rows])

    async def _ensure_session(
        self, db: AsyncSession, *, session_id: int | None, category_id: int | None, message: str
    ) -> ChatSession:
        if session_id is not None:
            row = await db.get(ChatSession, session_id)
            if not row:
                raise HTTPException(status_code=404, detail="会话不存在")
            return row
        row = ChatSession(title=self._title_from_message(message), category_id=category_id)
        db.add(row)
        await db.flush()
        return row

    async def _append_turn(
        self,
        db: AsyncSession,
        session: ChatSession,
        *,
        user_text: str,
        answer: str,
        refused: bool,
        citations: list[ChatCitation],
        category_id: int | None,
    ) -> None:
        # 首条用户消息时刷新标题
        existing = await db.execute(
            select(ChatMessage.id).where(ChatMessage.session_id == session.id).limit(1)
        )
        if existing.scalar_one_or_none() is None:
            session.title = self._title_from_message(user_text)
        if category_id is not None:
            session.category_id = category_id
        session.updated_at = datetime.now(timezone.utc)

        cites_raw = json.dumps(
            [c.model_dump() for c in citations],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        db.add(
            ChatMessage(
                session_id=session.id,
                role="user",
                content=user_text,
                refused=False,
                citations_json="",
            )
        )
        db.add(
            ChatMessage(
                session_id=session.id,
                role="assistant",
                content=answer,
                refused=refused,
                citations_json=cites_raw,
            )
        )
        await db.commit()
        await db.refresh(session)

    async def chat(self, db: AsyncSession, payload: ChatIn) -> ChatOut:
        if not await settings_ai_service.is_configured(db):
            raise HTTPException(status_code=400, detail="尚未配置 API Key，请先到设置页填写")

        message = payload.message.strip()
        if not message:
            raise HTTPException(status_code=400, detail="问题不能为空")

        session = await self._ensure_session(
            db,
            session_id=payload.session_id,
            category_id=payload.category_id,
            message=message,
        )

        hits, mode = await self._retrieve(db, message, category_id=payload.category_id)
        if not hits:
            out = ChatOut(
                answer=REFUSAL_TEXT,
                refused=True,
                citations=[],
                retrieval=mode,
                session_id=session.id,
            )
            await self._append_turn(
                db,
                session,
                user_text=message,
                answer=out.answer,
                refused=True,
                citations=[],
                category_id=payload.category_id,
            )
            return out

        context_blocks: list[str] = []
        citations: list[ChatCitation] = []
        for i, (chunk, entry, score) in enumerate(hits, start=1):
            title = entry.title or f"条目 #{entry.id}"
            snippet = (chunk.text or "").strip().replace("\n", " ")
            if len(snippet) > SNIPPET_CHARS:
                snippet = snippet[:SNIPPET_CHARS].rstrip() + "…"
            context_blocks.append(f"[{i}] 《{title}》\n{chunk.text}")
            citations.append(
                ChatCitation(
                    entry_id=entry.id,
                    title=title,
                    snippet=snippet,
                    score=round(float(score), 4),
                )
            )

        user_content = (
            "【资料片段】\n"
            + "\n\n".join(context_blocks)
            + "\n\n【用户问题】\n"
            + message
        )
        try:
            answer = await chat_completion(
                db,
                [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
            )
        except LlmNotConfigured as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"模型调用失败：{exc}") from exc

        refused = answer.strip().startswith("资料不足")
        if refused:
            out = ChatOut(
                answer=REFUSAL_TEXT,
                refused=True,
                citations=citations,
                retrieval=mode,
                session_id=session.id,
            )
        else:
            out = ChatOut(
                answer=answer or REFUSAL_TEXT,
                refused=not bool(answer),
                citations=citations,
                retrieval=mode,
                session_id=session.id,
            )

        await self._append_turn(
            db,
            session,
            user_text=message,
            answer=out.answer,
            refused=out.refused,
            citations=out.citations,
            category_id=payload.category_id,
        )
        return out

    async def _retrieve(
        self,
        db: AsyncSession,
        message: str,
        *,
        category_id: int | None,
    ) -> tuple[list[tuple[Chunk, Entry, float]], str]:
        q = (
            select(Chunk, Entry)
            .join(Entry, Entry.id == Chunk.entry_id)
            .order_by(Chunk.entry_id, Chunk.ord)
        )
        if category_id is not None:
            q = q.join(EntryCategory, EntryCategory.entry_id == Entry.id).where(
                EntryCategory.category_id == category_id
            )

        rows = list((await db.execute(q)).all())
        if not rows:
            return [], "keyword"

        # 尝试向量
        query_vecs = await embed_texts(db, [message])
        if query_vecs and query_vecs[0]:
            qv = query_vecs[0]
            scored: list[tuple[Chunk, Entry, float]] = []
            for chunk, entry in rows:
                vec = load_embedding(chunk.embedding)
                if not vec:
                    continue
                sim = cosine_similarity(qv, vec)
                if sim >= VECTOR_MIN_SCORE:
                    scored.append((chunk, entry, sim))
            scored.sort(key=lambda x: x[2], reverse=True)
            if scored:
                return scored[:TOP_K], "vector"

        # 关键词降级
        tokens = _tokenize_query(message)
        scored_kw: list[tuple[Chunk, Entry, float]] = []
        for chunk, entry in rows:
            if _is_noisy_chunk(chunk.text or ""):
                continue
            score = _keyword_score(chunk.text or "", tokens)
            # 标题命中加权
            score += _keyword_score(entry.title or "", tokens) * 1.2
            if score >= KEYWORD_MIN_SCORE:
                scored_kw.append((chunk, entry, score))
        scored_kw.sort(key=lambda x: x[2], reverse=True)
        return scored_kw[:TOP_K], "keyword"


chat_service = ChatService()
