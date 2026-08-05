# 功能点 02：模型与 API Key 配置（从零到一）

> 本篇回答：**一个"Key 自备"的 AI 应用，如何安全地保存、展示、使用用户的 API Key？**

---

## 1. 这个功能解决什么问题？

「空库」不卖 AI 额度，所有 LLM 调用都用用户自己的 Key（DeepSeek、OpenAI、硅基流动……）。由此产生四个必须解决的问题：

1. **Key 存哪？** 写死在 `.env` 里，改一次要重启服务；
2. **怎么展示？** 设置页要回显"已配置"，但绝不能把明文 Key 回传给前端；
3. **怎么改？** 用户粘贴脱敏后的 Key 再保存，不能把 `sk-***abcd` 当新 Key 覆盖掉真 Key；
4. **没配 Key 怎么办？** 所有 AI 功能要优雅地"引导去配置"，而不是报 500。

## 2. 先修概念

- **OpenAI 兼容接口**：国内主流模型平台都模仿 OpenAI 的 API 形态（`POST /v1/chat/completions`、`/v1/embeddings`），所以一套 httpx 客户端代码可以通吃所有厂商，只需换 base_url + key + model 三件套。
- **脱敏（masking）**：展示时只露几位字符，如 `sk-***wxyz`，既让用户认出自己的 Key，又不泄露。
- **单行表（singleton row）**：全局配置不做多记录，固定 `id=1` 一行，读到就更新它。

## 3. 从零推导

### 第一步：配置存数据库，不存环境变量

`ai_settings` 表（`apps/api/app/modules/settings_ai/models.py:7-28`）：

```python
class AiSettings(Base):
    """全局 AI 配置（自用单用户：固定 id=1）。"""

    __tablename__ = "ai_settings"

    id = mapped_column(Integer, primary_key=True)
    provider = mapped_column(String(100), default="deepseek")
    base_url = mapped_column(String(500), default="https://api.deepseek.com/v1")
    api_key = mapped_column(Text, default="")
    chat_model = mapped_column(String(200), default="deepseek-v4-flash")
    embed_model = mapped_column(String(200), default="deepseek-v4-flash")
    asr_mode = mapped_column(String(20), default="auto")  # auto|local|cloud|off
    ...
    # 输出 token 上限：主回答 / 知识点 AI 摘段。推理模型的思考过程也占用该额度，需给足
    chat_max_tokens = mapped_column(Integer, default=1200)
    quote_refine_max_tokens = mapped_column(Integer, default=8000)
```

**为什么这样设计**：
- **为什么存 DB 而不是 .env？** 产品要求是"设置页改 Key 立即生效"。环境变量改了要重启进程；数据库写一行，下一次请求自然读到新值。
- **为什么固定 id=1？** 单用户个人工具，不需要多配置组。单例行是最简模型——`_get_or_create()` 读不到就建一行默认的，永远有配置可读。
- **注释里的领域知识**：`quote_refine_max_tokens` 默认 8000 这么大，是因为"推理模型的思考过程也占用该额度"——DeepSeek-R1 这类模型会先把 token 耗在 reasoning 上，余量不足会导致正文被截成空。这个注释把非显而易见的坑写在了字段旁边。
- **ASR 配置与对话配置同表但分离**：语音转写可以用另一家服务商（比如对话用 DeepSeek、转写用硅基流动），所以 asr_base_url/key/model 独立成列。

### 第二步：脱敏与"留空不修改"的闭环

```python
def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "***"
    return f"{key[:3]}***{key[-4:]}"
```

配套的更新逻辑：`if payload.api_key is not None and payload.api_key.strip(): row.api_key = ...`

**为什么这样写**——这是一个完整闭环：
1. **读**：GET 接口返回 `mask_key()` 的结果。留前 3 后 4，是为了让用户在多把 Key 的场景下能区分"这是哪把"；8 位以内的短 Key 全打码，因为前3+后4 会把短 Key 几乎全暴露。
2. **写**：前端表单里回显的是脱敏值，用户不打算换 Key 时会带着 `sk-***wxyz` 提交。后端约定 **"传空/传脱敏值 = 不修改"**，只有传了新的非空明文才覆盖。两个规则配合，保证明文永不出库、也永不被脱敏值污染。

### 第三步：服务商目录做成代码内静态数据

`providers.py` 文件头注释写明维护约定：

```python
"""大模型服务商与型号目录。
维护约定：增删厂商/型号只改本文件，前端通过 GET /api/settings/ai/providers 拉取。
"""

LLM_PROVIDERS: list[dict[str, Any]] = [
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "docs_url": "https://api-docs.deepseek.com/",
        "keys_url": "https://platform.deepseek.com/api_keys",
        "chat_models": [
            _m("deepseek-v4-flash", "DeepSeek V4 Flash",
               "更快更省，日常对话 / 摘要推荐", recommended=True),
```

**为什么不放数据库？** 厂商型号变化以代码发版节奏更新即可，没必要做成可编辑数据。注意每个条目带 `docs_url`（文档）和 `keys_url`（去哪申请 Key）——这不是数据表，是**引导用户配 Key 的产品功能**：设置页可以直接放"去申请 Key"按钮。`recommended` 标记帮选择困难的用户做决策。

### 第四步：LLM 调用封装——失败即降级

`core/llm.py` 是全部 AI 能力的唯一出口：

```python
class LlmNotConfigured(Exception):
    """未配置 API Key。"""

async def _creds(db: AsyncSession) -> dict[str, str]:
    row = await settings_ai_service._get_or_create(db)
    key = (row.api_key or "").strip()
    if not key:
        raise LlmNotConfigured("尚未配置 API Key，请先到设置页填写")
    ...

async def embed_texts(db: AsyncSession, texts: list[str]) -> list[list[float]] | None:
    """调用 /embeddings；失败返回 None（触发关键词检索降级）。"""
    try:
        creds = await _creds(db)
    except LlmNotConfigured:
        return None
    ...
    except Exception:
        return None
```

**设计决策解读**：
- **专门的异常类型** `LlmNotConfigured` 而非泛泛 RuntimeError：上层路由能精确捕获它，转成"请先配置 Key"的友好 4xx 响应，而不是一个莫名其妙的 500。
- **`embed_texts` 返回 `None` 的协议设计**：返回值类型 `list[list[float]] | None` 本身就是一份契约——`None` = "向量不可用，请降级到关键词检索"；`[]` = "输入为空"。所有失败分支（无 Key、HTTP 错误、网络异常）统一归一为 `None`，**把"embedding 是可选增强"这个产品决策写进了类型签名**。这就是功能点 08 里对话检索能自动降级的原因。

## 4. 完整流程图

```
设置页填 Key → PUT /api/settings/ai
                    │
                    ├─ api_key 非空明文？→ 覆盖 ai_settings 行
                    └─ 空/脱敏值 → 保留原 Key
                    │
                    ▼
           POST /api/settings/ai/test → httpx 真调一次 /chat/completions
                    │
                    ▼
业务使用：llm.py._creds() 从 ai_settings 读凭据
   ├─ 无 Key → LlmNotConfigured → 前端引导去设置页
   ├─ chat_completion → /chat/completions
   └─ embed_texts → /embeddings（失败返回 None → 检索降级关键词）
```

## 5. 关键文件与配置对照

| 文件 | 职责 |
|------|------|
| `apps/api/app/modules/settings_ai/router.py` | `GET /providers`、`GET/PUT /api/settings/ai`、`POST /test` |
| `apps/api/app/modules/settings_ai/providers.py` | 服务商与模型目录（含 docs_url/keys_url） |
| `apps/api/app/modules/settings_ai/models.py` | `ai_settings` 单行表 |
| `apps/api/app/modules/settings_ai/service.py` | `mask_key` 脱敏、`_get_or_create` |
| `apps/api/app/core/llm.py` | chat / embeddings 封装、`LlmNotConfigured`、向量 JSON 序列化与余弦计算 |

| 配置项 | 位置 | 说明 |
|--------|------|------|
| provider / base_url / api_key / chat_model / embed_model | 设置页 → ai_settings 表 | 对话与向量模型凭据 |
| asr_mode / asr_* | 同上 | 语音转写（见功能点 05） |
| chat_max_tokens（默认 1200）/ quote_refine_max_tokens（默认 8000） | 同上 | 生成长度上限；后者大是给推理模型的思考过程留余量 |
| `.env` 的 `LLM_*` | 环境变量 | 初始兜底来源，优先级低于 DB 配置 |
