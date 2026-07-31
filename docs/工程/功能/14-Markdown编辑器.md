# 功能 14 · 笔记库与 Markdown 编辑器

> 产品：[14-扩展-Markdown编辑器](../../产品/14-扩展-Markdown编辑器.md)  
> UI：侧栏「笔记」`/notes`

## 1. 功能目标

- `data/vault` 多级文件夹管理 `.md`
- 全页编辑器（TipTap）；`/` 命令与快捷键
- 保存写回 vault + `extracted.txt` + 自动 ingest / `index_entry`

## 2. 技术要点

| 项 | 做法 |
|----|------|
| 后端 | `apps/api/app/modules/vault/`：`/api/vault/*` |
| Source | `vault_path` 相对路径；`storage_path` 指向 vault 文件 |
| 资源 | `list_library` 增加 `vault / 笔记库` |
| 前端 | `features/notes/NotesPage.tsx` + `shared/ui/markdown-editor` |

## 3. API

- `GET /api/vault/tree`
- `POST /api/vault/folders` · `POST /api/vault/notes`
- `GET/PUT /api/vault/notes/{source_id}`（PUT 自动入库）
- `PATCH /api/vault/nodes` · `DELETE` 笔记/文件夹
- `POST /api/vault/import`（非 vault 笔记导入）

## 4. 验收

- [x] 侧栏「笔记」全页：左树右编，可建多级文件夹
- [x] 设置 → 我的资源 → 笔记库可见
- [x] 保存后对话可检索（committed + 切片）
- [x] 知识/喂养主入口跳转 `/notes`，不再用 Modal 主路径

## 5. 完成后再做

Skill `SKILL.md` 编辑复用本组件。
