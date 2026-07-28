from fastapi import APIRouter, BackgroundTasks, Depends, Response
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
from app.modules.chat.tasks import run_chat_job

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
    description=(
        "受理后立刻落库用户消息与 pending 助手占位，后台检索生成；"
        "客户端可切页，稍后用会话消息接口轮询直至 status!=pending。"
    ),
)
async def chat(
    payload: ChatIn,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> ChatOut:
    out = await chat_service.begin_chat(db, payload)
    if out.status == "pending" and out.pending_message_id is not None:
        background_tasks.add_task(run_chat_job, out.pending_message_id)
    return out
