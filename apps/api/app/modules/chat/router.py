from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.chat.schemas import (
    ChatIn,
    ChatMessageListOut,
    ChatOut,
    ChatSessionCreate,
    ChatSessionListOut,
    ChatSessionOut,
)
from app.modules.chat.service import chat_service

router = APIRouter(tags=["知识对话"])


@router.get(
    "/chat/sessions",
    response_model=ChatSessionListOut,
    summary="会话列表",
)
async def list_sessions(db: AsyncSession = Depends(get_db)) -> ChatSessionListOut:
    return await chat_service.list_sessions(db)


@router.post(
    "/chat/sessions",
    response_model=ChatSessionOut,
    summary="新建会话",
)
async def create_session(
    payload: ChatSessionCreate = ChatSessionCreate(),
    db: AsyncSession = Depends(get_db),
) -> ChatSessionOut:
    return await chat_service.create_session(db, payload)


@router.get(
    "/chat/sessions/{session_id}/messages",
    response_model=ChatMessageListOut,
    summary="会话消息",
)
async def list_messages(
    session_id: int, db: AsyncSession = Depends(get_db)
) -> ChatMessageListOut:
    return await chat_service.list_messages(db, session_id)


@router.delete(
    "/chat/sessions/{session_id}",
    status_code=204,
    summary="删除会话",
)
async def delete_session(session_id: int, db: AsyncSession = Depends(get_db)) -> Response:
    await chat_service.delete_session(db, session_id)
    return Response(status_code=204)


@router.post(
    "/chat",
    response_model=ChatOut,
    summary="知识库问答",
    description="基于已入库切片检索作答；证据不足则拒答。可选 session_id 落库历史（不增加多轮 LLM 上下文）。",
)
async def chat(payload: ChatIn, db: AsyncSession = Depends(get_db)) -> ChatOut:
    return await chat_service.chat(db, payload)
