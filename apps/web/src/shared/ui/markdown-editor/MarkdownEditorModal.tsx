import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal, Space } from "antd";
import { api } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import styles from "./MarkdownEditor.module.css";

export type MarkdownEditorModalProps = {
  open: boolean;
  mode: "create" | "edit";
  sourceId?: number | null;
  initialTitle?: string;
  onClose: () => void;
  /** 保存成功：create 时返回新 sourceId；edit 时回传原 id */
  onSaved?: (info: { sourceId: number; title: string; created: boolean }) => void;
};

export function MarkdownEditorModal({
  open,
  mode,
  sourceId = null,
  initialTitle = "",
  onClose,
  onSaved,
}: MarkdownEditorModalProps) {
  const { message, modal } = App.useApp();
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const [title, setTitle] = useState(initialTitle);
  const [contentKey, setContentKey] = useState(0);
  const [initialMarkdown, setInitialMarkdown] = useState("");
  const [activeSourceId, setActiveSourceId] = useState<number | null>(sourceId);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const reset = useCallback(() => {
    setTitle(initialTitle || "");
    setInitialMarkdown("");
    setActiveSourceId(sourceId);
    setDirty(false);
    setContentKey((k) => k + 1);
  }, [initialTitle, sourceId]);

  useEffect(() => {
    if (!open) return;
    reset();
    if (mode === "edit" && sourceId != null) {
      setLoading(true);
      void api
        .getSourceContent(sourceId)
        .then((res) => {
          setTitle(res.title || "");
          setInitialMarkdown(res.content || "");
          setActiveSourceId(res.source_id);
          setContentKey((k) => k + 1);
          setDirty(false);
        })
        .catch((err) => message.error(formatError(err)))
        .finally(() => setLoading(false));
    }
  }, [mode, open, reset, sourceId, message]);

  const save = useCallback(async () => {
    const content = editorRef.current?.getMarkdown()?.trim() || "";
    if (!content) {
      message.warning("内容不能为空");
      return;
    }
    setSaving(true);
    try {
      if (mode === "create" && activeSourceId == null) {
        const row = await api.pasteSource({ title: title.trim(), content });
        setActiveSourceId(row.id);
        setDirty(false);
        message.success("笔记已保存到喂养队列（可在喂养页入库）");
        onSaved?.({ sourceId: row.id, title: row.title || title, created: true });
        return;
      }
      const id = activeSourceId ?? sourceId;
      if (id == null) {
        message.error("缺少来源 id");
        return;
      }
      const res = await api.updateSourceContent(id, {
        title: title.trim(),
        content,
      });
      setTitle(res.title);
      setDirty(false);
      message.success("已保存");
      onSaved?.({ sourceId: res.source_id, title: res.title, created: false });
    } catch (err) {
      message.error(formatError(err));
    } finally {
      setSaving(false);
    }
  }, [activeSourceId, message, mode, onSaved, sourceId, title]);

  const requestClose = () => {
    if (!dirty) {
      onClose();
      return;
    }
    modal.confirm({
      title: "有未保存的更改",
      content: "关闭将丢失本次修改，确定关闭？",
      okText: "关闭",
      cancelText: "继续编辑",
      onOk: () => onClose(),
    });
  };

  return (
    <Modal
      open={open}
      title={mode === "create" ? "写笔记" : "编辑笔记"}
      onCancel={requestClose}
      width={920}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={requestClose}>关闭</Button>
          <Button type="primary" loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </Space>
      }
      styles={{ body: { paddingTop: 12 } }}
    >
      <div className={styles.modalBody}>
        <Input
          className={styles.titleInput}
          placeholder="标题（可留空，将取正文首行）"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
          disabled={loading}
        />
        <div className={styles.editorShell}>
          {loading ? (
            <div style={{ padding: 24, color: "#94a3b8" }}>加载中…</div>
          ) : (
            <MarkdownEditor
              key={contentKey}
              ref={editorRef}
              initialMarkdown={initialMarkdown}
              dirty={dirty}
              onDirtyChange={setDirty}
              onSave={save}
              saving={saving}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
