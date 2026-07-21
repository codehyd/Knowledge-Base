"""大模型服务商与型号目录。

维护约定：增删厂商/型号只改本文件，前端通过 GET /api/settings/ai/providers 拉取。
"""

from __future__ import annotations

from typing import Any


def _m(model_id: str, label: str, desc: str = "", *, recommended: bool = False) -> dict[str, Any]:
    return {
        "id": model_id,
        "label": label,
        "desc": desc,
        "recommended": recommended,
    }


LLM_PROVIDERS: list[dict[str, Any]] = [
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "docs_url": "https://api-docs.deepseek.com/",
        "chat_models": [
            _m(
                "deepseek-v4-flash",
                "DeepSeek V4 Flash",
                "更快更省，日常对话 / 摘要推荐",
                recommended=True,
            ),
            _m(
                "deepseek-v4-pro",
                "DeepSeek V4 Pro",
                "更强推理与长文，适合复杂归类归纳",
            ),
            _m(
                "deepseek-chat",
                "deepseek-chat（旧别名）",
                "兼容别名，将指向 V4 Flash；建议尽快改用 v4-flash",
            ),
            _m(
                "deepseek-reasoner",
                "deepseek-reasoner（旧别名）",
                "兼容别名；建议改用 v4-pro / v4-flash",
            ),
        ],
        "embed_models": [
            _m(
                "deepseek-v4-flash",
                "DeepSeek V4 Flash",
                "无独立 embedding 时可先用对话模型做向量（效果一般）",
                recommended=True,
            ),
            _m("deepseek-v4-pro", "DeepSeek V4 Pro", "同上，成本更高"),
        ],
    },
    {
        "id": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "docs_url": "https://platform.openai.com/docs",
        "chat_models": [
            _m("gpt-4o-mini", "GPT-4o mini", "便宜日用", recommended=True),
            _m("gpt-4o", "GPT-4o", "更强多模态/对话"),
            _m("o4-mini", "o4-mini", "偏推理（若账号可用）"),
        ],
        "embed_models": [
            _m(
                "text-embedding-3-small",
                "text-embedding-3-small",
                "检索推荐",
                recommended=True,
            ),
            _m("text-embedding-3-large", "text-embedding-3-large", "更高质量向量"),
        ],
    },
    {
        "id": "siliconflow",
        "name": "硅基流动 SiliconFlow",
        "base_url": "https://api.siliconflow.cn/v1",
        "docs_url": "https://docs.siliconflow.cn/",
        "chat_models": [
            _m(
                "deepseek-ai/DeepSeek-V3",
                "DeepSeek-V3（托管）",
                "按控制台实际可用模型为准",
                recommended=True,
            ),
            _m("Qwen/Qwen2.5-72B-Instruct", "Qwen2.5-72B", "通义系开源托管"),
            _m("moonshotai/Kimi-K2-Instruct", "Kimi K2（若上架）", "以控制台列表为准"),
        ],
        "embed_models": [
            _m(
                "BAAI/bge-m3",
                "BGE-M3",
                "中文检索常用",
                recommended=True,
            ),
            _m("netease-youdao/bce-embedding-base_v1", "BCE Embedding", "中文备选"),
        ],
    },
    {
        "id": "moonshot",
        "name": "月之暗面 Kimi",
        "base_url": "https://api.moonshot.cn/v1",
        "docs_url": "https://platform.moonshot.cn/docs",
        "chat_models": [
            _m("moonshot-v1-8k", "moonshot-v1-8k", "短上下文", recommended=True),
            _m("moonshot-v1-32k", "moonshot-v1-32k", "中等上下文"),
            _m("moonshot-v1-128k", "moonshot-v1-128k", "长上下文"),
            _m("kimi-latest", "kimi-latest", "若账号开放则以控制台为准"),
        ],
        "embed_models": [
            _m("moonshot-v1-8k", "复用对话模型", "无专用 embedding 时的占位选择"),
        ],
    },
    {
        "id": "qwen",
        "name": "通义千问（DashScope 兼容模式）",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "docs_url": "https://help.aliyun.com/zh/model-studio/",
        "chat_models": [
            _m("qwen-plus", "qwen-plus", "均衡", recommended=True),
            _m("qwen-turbo", "qwen-turbo", "更快更省"),
            _m("qwen-max", "qwen-max", "更强"),
        ],
        "embed_models": [
            _m(
                "text-embedding-v3",
                "text-embedding-v3",
                "阿里云向量",
                recommended=True,
            ),
            _m("text-embedding-v2", "text-embedding-v2", "旧版向量"),
        ],
    },
    {
        "id": "zhipu",
        "name": "智谱 GLM",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "docs_url": "https://open.bigmodel.cn/dev/api",
        "chat_models": [
            _m("glm-4-flash", "GLM-4-Flash", "快、省", recommended=True),
            _m("glm-4-air", "GLM-4-Air", "均衡"),
            _m("glm-4-plus", "GLM-4-Plus", "更强"),
        ],
        "embed_models": [
            _m("embedding-3", "embedding-3", "智谱向量", recommended=True),
            _m("embedding-2", "embedding-2", "旧版向量"),
        ],
    },
    {
        "id": "custom",
        "name": "自定义（OpenAI 兼容）",
        "base_url": "",
        "docs_url": "",
        "chat_models": [
            _m("custom", "手动填写模型名", "任意兼容接口", recommended=True),
        ],
        "embed_models": [
            _m("custom", "手动填写模型名", "任意兼容接口", recommended=True),
        ],
        "allow_custom_base_url": True,
        "allow_custom_model": True,
    },
]


def list_providers() -> list[dict[str, Any]]:
    return LLM_PROVIDERS


def find_provider(provider_id: str) -> dict[str, Any] | None:
    for item in LLM_PROVIDERS:
        if item["id"] == provider_id:
            return item
    return None


def infer_provider_id(base_url: str) -> str:
    url = (base_url or "").lower()
    mapping = [
        ("deepseek.com", "deepseek"),
        ("openai.com", "openai"),
        ("siliconflow", "siliconflow"),
        ("moonshot", "moonshot"),
        ("dashscope.aliyuncs.com", "qwen"),
        ("bigmodel.cn", "zhipu"),
    ]
    for needle, pid in mapping:
        if needle in url:
            return pid
    return "custom"
