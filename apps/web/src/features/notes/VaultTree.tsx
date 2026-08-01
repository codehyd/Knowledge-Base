import type { MouseEvent, ReactNode } from "react";
import {
  FileAddOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { Button, Space, Tooltip } from "antd";
import type { VaultNode } from "@/shared/api/client";
import type { CtxMenuTarget, NoteTab } from "./types";
import styles from "./NotesPage.module.css";

export type VaultTreeProps = {
  nodes: VaultNode[];
  loadingTree: boolean;
  expanded: Set<string>;
  selectedFolder: string;
  tabs: NoteTab[];
  activeId: number | null;
  onCreateFolder: () => void;
  onCreateNote: () => void;
  onSelectRoot: () => void;
  onToggleFolder: (path: string) => void;
  onSelectNote: (node: VaultNode) => void;
  onContextMenu: (event: MouseEvent, target: CtxMenuTarget) => void;
};

function renderTreeNodes(
  list: VaultNode[],
  depth: number,
  props: Pick<
    VaultTreeProps,
    "expanded" | "selectedFolder" | "tabs" | "activeId" | "onToggleFolder" | "onSelectNote" | "onContextMenu"
  >,
): ReactNode {
  const { expanded, selectedFolder, tabs, activeId, onToggleFolder, onSelectNote, onContextMenu } = props;

  return list.map((node) => {
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
            onClick={() => onToggleFolder(node.path)}
            onContextMenu={(e) =>
              onContextMenu(e, { kind: "folder", path: node.path, name: node.name })
            }
          >
            {open ? <FolderOpenOutlined /> : <FolderOutlined />}
            <span className={styles.treeLabel} title={node.name}>
              {node.name}
            </span>
          </button>
          {open ? (
            <div className={styles.treeChildren}>
              {renderTreeNodes(node.children || [], depth + 1, props)}
            </div>
          ) : null}
        </div>
      );
    }
    const opened = node.source_id != null && tabs.some((t) => t.sourceId === node.source_id);
    return (
      <button
        key={node.path}
        type="button"
        className={`${styles.treeNode}${
          activeId === node.source_id ? ` ${styles.treeNodeActive}` : ""
        }${opened && activeId !== node.source_id ? ` ${styles.treeNodeOpen}` : ""}`}
        style={{ paddingLeft: 8 + depth * 4 }}
        onClick={() => onSelectNote(node)}
        onContextMenu={(e) =>
          onContextMenu(e, {
            kind: "note",
            path: node.path,
            name: node.name,
            sourceId: node.source_id ?? null,
            title: node.title || node.name.replace(/\.md$/i, ""),
          })
        }
      >
        <FileTextOutlined />
        <span
          className={styles.treeLabel}
          title={node.title || node.name.replace(/\.md$/i, "")}
        >
          {node.title || node.name.replace(/\.md$/i, "")}
        </span>
      </button>
    );
  });
}

export function VaultTree({
  nodes,
  loadingTree,
  expanded,
  selectedFolder,
  tabs,
  activeId,
  onCreateFolder,
  onCreateNote,
  onSelectRoot,
  onToggleFolder,
  onSelectNote,
  onContextMenu,
}: VaultTreeProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.sideHead}>
        <div className={styles.sideTitle}>笔记库</div>
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
          <div className={styles.treeEmpty}>还没有笔记。点上方按钮新建一篇开始写。</div>
        ) : (
          <>
            <button
              type="button"
              className={`${styles.rootLabel}${
                selectedFolder === "" ? ` ${styles.rootLabelActive}` : ""
              }`}
              onClick={onSelectRoot}
              onContextMenu={(e) => onContextMenu(e, { kind: "root" })}
              title="在根目录新建笔记或文件夹"
            >
              <span className={styles.rootLabelPath}>library/笔记库</span>
              <span className={styles.rootLabelHint}>根目录</span>
            </button>
            {renderTreeNodes(nodes, 0, {
              expanded,
              selectedFolder,
              tabs,
              activeId,
              onToggleFolder,
              onSelectNote,
              onContextMenu,
            })}
          </>
        )}
      </div>
    </aside>
  );
}
