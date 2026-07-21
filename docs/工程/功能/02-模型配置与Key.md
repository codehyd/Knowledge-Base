# 功能 02 · 模型配置与 API Key

> UI：[figma/05-模型配置](../../../figma/05-模型配置.png)  
> 产品：[04-工具与运行](../../产品/04-工具与运行.md)

## 1. 功能目标

用户在界面配置 OpenAI 兼容的 Base URL / API Key / 对话模型 / Embedding 模型；可「测试连接」；未配置时阻断 AI 入库与对话。

## 2. 技术要点

| 项 | 做法 |
|----|------|
| 存储 | 表 `ai_settings`（含 `provider`）；Key 脱敏返回；导出禁止带出 |
| 服务商目录 | `providers.py` 维护厂商与型号；`GET /api/settings/ai/providers` |
| DeepSeek 默认 | 对话/向量默认 `deepseek-v4-flash`；列表含 `deepseek-v4-pro` |
| 客户端 | `httpx` 调 `{base}/models` 探活 |
| 前端 | 先选服务商 → 再选对话/Embedding 型号；支持「其它手动输入」 |

## 3. 实现步骤

1. **API**
   - `GET /api/settings/ai`（Key 脱敏返回，如 `sk-***`）
   - `PUT /api/settings/ai` 保存
   - `POST /api/settings/ai/test` → 调兼容接口，返回 ok/延迟/错误信息
2. **门禁中间件或依赖**：`require_llm()` — 无 Key 则 400，文案「请先配置 API Key」
3. **Web 设置页**：表单字段对齐 figma；成功/失败 toast
4. 首次启动若 `.env` 有 Key，可导入为初始设置（仍允许界面覆盖）

## 4. 接口示意

```http
PUT /api/settings/ai
{ "base_url": "...", "api_key": "...", "chat_model": "deepseek-chat", "embed_model": "..." }

POST /api/settings/ai/test
→ { "ok": true, "latency_ms": 312 }
```

## 5. 验收

- [ ] 错误 Key 测试失败且有明确错误
- [ ] 正确 Key 显示已连接
- [ ] 清空 Key 后，对话/解析接口拒绝
- [ ] 备份/导出接口响应中不含明文 Key

## 6. 完成后再做

[03-空库首页与引导](./03-空库首页与引导.md)
