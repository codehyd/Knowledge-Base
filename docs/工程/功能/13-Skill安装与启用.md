# 13 · Skill 安装与启用

> 产品契约见 [产品/13-扩展-Skill安装与市场](../../产品/13-扩展-Skill安装与市场.md)。

## 1. 目标

- 本地 zip / 内置样例安装 Skill（类 VS Code 扩展）
- 启用后对话注入流程说明；**事实仍只认库内检索**
- 附带 `knowledge/` 可选导入喂养队列（非旁路答题）

## 2. 后端

| 路径 | 说明 |
|------|------|
| `apps/api/app/modules/skills/` | 包校验、状态、路由 |
| `data/skills/<id>/` | 已安装包 |
| `data/skills/skills-state.json` | 启用状态等 |

主要接口（Knife4j 分组「技能 Skill」）：

- `GET /api/skills`
- `POST /api/skills/install`（multipart）
- `PATCH /api/skills/{id}` · `DELETE /api/skills/{id}?remove_imported=true`（默认清理导入材料）
- `POST /api/skills/{id}/import-knowledge`
- `GET /api/skills/imported-leftovers` · `POST /api/skills/purge-imported`

不预置官方演示包；用户自行上传 zip。  
「我的资源」是喂养/入库后的目录镜像，本身无删除按钮；Skill 导入物用上述清理接口或知识/喂养页删除。

对话：`chat/service.py` 在 system prompt 后拼接已启用且含 `chat.prompt` 的 SKILL.md。

## 3. 前端

- 路由 `/skills` · `features/skills/SkillsPage.tsx`
- 侧栏「技能」入口

## 4. 验收

| 项 | 期望 |
|----|------|
| 本地 zip 安装合法包 | 列表可见且默认可启用 |
| 空库 + 启用任意 workflow Skill，问未喂养领域 | **拒答** |
| 禁用 Skill 后再问库内题 | 仍可按库答，不再强制该结构 |
| 上传含 `.py` 的 zip | 安装失败 |
| `knowledge_policy` 非 `library_only` | 安装失败 |
| 安装并导入附带材料 | 喂养队列出现笔记；未入库前检索不到正文结论 |

## 5. 不做（本阶段）

- 技能市场浏览 / 更新通道
- Skill 内任意可执行代码
