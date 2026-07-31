import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  DeleteOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
} from "@ant-design/icons";
import { App, Button, Input, Modal, Space, Tooltip } from "antd";
import { api, type VaultNode, type VaultNote } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { MarkdownEditor, type MarkdownEditorHandle } from "@/shared/ui/markdown-editor";
import styles from "./NotesPage.module.css";

function findNote(nodes: VaultNode[], sourceId: number): VaultNode | null {
  for (const n of nodes) {
    if (n.kind === "note" && n.source_id === sourceId) return n;
    if (n.children?.length) {
      const hit = findNote(n.children, sourceId);
      if (hit) return hit;
    }
  }
  return null;
}

export function NotesPage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const editorRef = useRef<MarkdownEditorHandle>(null);

  const [nodes, setNodes] = useState<VaultNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [note, setNote] = useState<VaultNote | null>(null);
  const [title, setTitle] = useState("");
  const [contentKey, setContentKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingNote, setLoadingNote] = useState(false);

  const refreshTree = useCallback(async () => {
    setLoadingTree(true);
    try {
      const res = await api.getVaultTree();
      setNodes(res.nodes || []);
    } catch (err) {
      message.error(formatError(err));
    } finally {
      setLoadingTree(false);
    }
  }, [message]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  const openNote = useCallback(
    async (sourceId: number) => {
      setLoadingNote(true);
      try {
        const res = await api.getVaultNote(sourceId);
        setActiveId(res.source_id);
        setNote(res);
        setTitle(res.title || "");
        setContentKey((k) => k + 1);
        setDirty(false);
        setParams({ id: String(res.source_id) }, { replace: true });
      } catch (err) {
        message.error(formatError(err));
      } finally {
        setLoadingNote(false);
      }
    },
    [message, setParams],
  );

  // /notes?id= / ?new=1 / ?import=
  useEffect(() => {
    const importId = params.get("import");
    const id = params.get("id");
    const isNew = params.get("new") === "1";

    void (async () => {
      if (importId) {
        try {
          const res = await api.importVaultNote({ source_id: Number(importId) });
          await refreshTree();
          setParams({ id: String(res.source_id) }, { replace: true });
          setActiveId(res.source_id);
          setNote(res);
          setTitle(res.title || "");
          setContentKey((k) => k + 1);
          setDirty(false);
          message.success("已导入笔记库");
        } catch (err) {
          message.error(formatError(err));
        }
        return;
      }
      if (isNew) {
        try {
          const res = await api.createVaultNote({
            parent: selectedFolder,
            title: "未命名笔记",
          });
          await refreshTree();
          setParams({ id: String(res.source_id) }, { replace: true });
          setActiveId(res.source_id);
          setNote(res);
          setTitle(res.title || "");
          setContentKey((k) => k + 1);
          setDirty(false);
        } catch (err) {
          message.error(formatError(err));
        }
        return;
      }
      if (id) {
        const num = Number(id);
        if (!Number.isNaN(num) && num !== activeId) {
          await openNote(num);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get("id"), params.get("new"), params.get("import")]);

  const save = useCallback(async () => {
    if (activeId == null) return;
    const content = editorRef.current?.getMarkdown() ?? "";
    setSaving(true);
    try {
      const res = await api.saveVaultNote(activeId, {
        title: title.trim(),
        content,
      });
      setNote(res);
      setTitle(res.title);
      setDirty(false);
      message.success(res.committed ? "已保存并入库" : "已保存");
      void refreshTree();
    } catch (err) {
      message.error(formatError(err));
    } finally {
      setSaving(false);
    }
  }, [activeId, message, refreshTree, title]);

  const onCreateFolder = () => {
    let name = "新建文件夹";
    Modal.confirm({
      title: "新建文件夹",
      content: (
        <Input
          defaultValue={name}
          onChange={(e) => {
            name = e.target.value;
          }}
          placeholder="文件夹名称"
        />
      ),
      okText: "创建",
      onOk: async () => {
        try {
          await api.createVaultFolder({ parent: selectedFolder, name: name.trim() || "新建文件夹" });
          const parent = selectedFolder;
          if (parent) setExpanded((s) => new Set(s).add(parent));
          await refreshTree();
          message.success("已创建文件夹");
        } catch (err) {
          message.error(formatError(err));
          throw err;
        }
      },
    });
  };

  const onCreateNote = async () => {
    try {
      const res = await api.createVaultNote({
        parent: selectedFolder,
        title: "未命名笔记",
      });
      if (selectedFolder) setExpanded((s) => new Set(s).add(selectedFolder));
      await refreshTree();
      await openNote(res.source_id);
    } catch (err) {
      message.error(formatError(err));
    }
  };

  const onDeleteNote = (sourceId: number, noteTitle: string) => {
    modal.confirm({
      title: "删除笔记？",
      content: `将删除「${noteTitle}」及其知识库条目，不可恢复。`,
      okText: "删除",
      okButtonProps: { danger: true },
      onOk: async () => {
        await api.deleteVaultNote(sourceId);
        if (activeId === sourceId) {
          setActiveId(null);
          setNote(null);
          setParams({}, { replace: true });
        }
        await refreshTree();
        message.success("已删除");
      },
    });
  };

  const onDeleteFolder = (path: string) => {
    modal.confirm({
      title: "删除文件夹？",
      content: "将删除该文件夹及其中全部笔记。",
      okText: "删除",
      okButtonProps: { danger: true },
      onOk: async () => {
        await api.deleteVaultFolder(path);
        if (selectedFolder === path || selectedFolder.startsWith(path + "/")) {
          setSelectedFolder("");
        }
        await refreshTree();
        message.success("已删除文件夹");
      },
    });
  };

  const selectNote = (node: VaultNode) => {
    if (node.source_id == null) return;
    if (dirty) {
      modal.confirm({
        title: "有未保存的更改",
        content: "切换笔记将丢失未保存内容，是否继续？",
        okText: "继续",
        onOk: () => void openNote(node.source_id!),
      });
      return;
    }
    void openNote(node.source_id);
  };

  const renderTree = (list: VaultNode[], depth = 0): ReactNode =>
    list.map((node) => {
      if (node.kind === "folder") {
        const open = expanded.has(node.path);
        return (
          <div key={node.path} className={styles.treeFolder}>
            <button
              type="button"
              className={`${styles.treeNode}${
                selectedFolder === node.path ? ` ${styles.treeNodeActive}` : ""
              }`}
              style={{ paddingLeft: 8 + depth * 4 }}
              onClick={() => {
                setSelectedFolder(node.path);
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelectedFolder(node.path);
                onDeleteFolder(node.path);
              }}
            >
              {open ? <FolderOpenOutlined /> : <FolderOutlined />}
              <span>{node.name}</span>
            </button>
            {open ? <div className={styles.treeChildren}>{renderTree(node.children || [], depth + 1)}</div> : null}
          </div>
        );
      }
      return (
        <button
          key={node.path}
          type="button"
          className={`${styles.treeNode}${
            activeId === node.source_id ? ` ${styles.treeNodeActive}` : ""
          }`}
          style={{ paddingLeft: 8 + depth * 4 }}
          onClick={() => selectNote(node)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (node.source_id != null) {
              onDeleteNote(node.source_id, node.title || node.name);
            }
          }}
        >
          <FileTextOutlined />
          <span>{node.title || node.name.replace(/\.md$/i, "")}</span>
        </button>
      );
    });

  const shortcutHint = useMemo(
    () =>
      [
        "Ctrl/⌘+S 保存入库",
        "Ctrl/⌘+B/I 粗/斜",
        "Ctrl/⌘+Alt+1..3 标题",
        "Ctrl/⌘+` 行内代码",
        "/ 插入块",
      ].join(" · "),
    [],
  );

  const activeInTree = activeId != null ? findNote(nodes, activeId) : null;

  return (
    <section className={styles.page}>
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sideHead}>
            <h2 className={styles.sideTitle}>笔记库</h2>
            <Space size={4} className={styles.sideActions}>
              <Tooltip title="新建文件夹">
                <Button
                  type="text"
                  size="small"
                  icon={<FolderAddOutlined />}
                  onClick={onCreateFolder}
                />
              </Tooltip>
              <Tooltip title="新建笔记">
                <Button
                  type="text"
                  size="small"
                  icon={<FileAddOutlined />}
                  onClick={() => void onCreateNote()}
                />
              </Tooltip>
            </Space>
          </div>
          <div className={styles.treeWrap}>
            {loadingTree && nodes.length === 0 ? (
              <div className={styles.treeEmpty}>加载中…</div>
            ) : nodes.length === 0 ? (
              <div className={styles.treeEmpty}>
                还没有笔记。点上方按钮新建，或从知识页导入已有笔记。
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className={`${styles.treeNode}${
                    selectedFolder === "" ? ` ${styles.treeNodeActive}` : ""
                  }`}
                  onClick={() => setSelectedFolder("")}
                >
                  <FolderOpenOutlined />
                  <span>全部（根目录）</span>
                </button>
                {renderTree(nodes)}
              </>
            )}
          </div>
        </aside>

        <div className={styles.editorPane}>
          {activeId == null || !note ? (
            <div className={styles.emptyEditor}>
              <FileTextOutlined style={{ fontSize: 36, opacity: 0.35 }} />
              <div>选择左侧笔记，或新建一篇开始写</div>
              <Button type="primary" icon={<FileAddOutlined />} onClick={() => void onCreateNote()}>
                新建笔记
              </Button>
              <Button type="link" onClick={() => navigate("/knowledge")}>
                回知识浏览
              </Button>
            </div>
          ) : (
            <>
              <div className={styles.editorHead}>
                <Input
                  className={styles.titleInput}
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="标题"
                />
                <span className={styles.meta}>
                  {note.committed ? "已入库" : "未入库"}
                  {activeInTree?.path ? ` · ${activeInTree.path}` : ""}
                </span>
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => onDeleteNote(activeId, title || "笔记")}
                />
                <Button type="primary" loading={saving || loadingNote} onClick={() => void save()}>
                  保存
                </Button>
              </div>
              <div className={styles.editorBody}>
                <MarkdownEditor
                  key={contentKey}
                  ref={editorRef}
                  initialMarkdown={note.content}
                  dirty={dirty}
                  onDirtyChange={setDirty}
                  onSave={save}
                  saving={saving}
                />
              </div>
              <div className={styles.hintBar}>{shortcutHint}</div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
