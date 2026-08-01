import { DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { Button, Input, Modal, Popconfirm, Space, Typography } from "antd";
import type { EntryAnnotation } from "@/shared/api/client";
import {
  anchorLabel,
  isChatAnchor,
  normalizeColor,
  PRESET_COLORS,
  type PendingSel,
} from "./previewHighlight";
import styles from "./TextPreviewModal.module.css";

export function ColorPicker({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (hex: string) => void;
  compact?: boolean;
}) {
  const current = normalizeColor(value);
  return (
    <div className={compact ? styles.selColors : styles.colorRow}>
      {PRESET_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          title={c.label}
          className={`${compact ? styles.selColorDot : styles.colorBtn}${
            current === c.id ? ` ${compact ? styles.selColorActive : styles.colorBtnActive}` : ""
          }`}
          style={
            compact
              ? { background: c.id }
              : { background: c.id, color: "#fff" }
          }
          onClick={() => onChange(c.id)}
        >
          {compact ? null : c.label}
        </button>
      ))}
      <label
        className={compact ? styles.selColorCustom : styles.colorCustom}
        title="自选颜色"
      >
        <input
          type="color"
          value={current}
          onChange={(e) => onChange(normalizeColor(e.target.value))}
          aria-label="自选颜色"
        />
        {compact ? null : <span>自选</span>}
      </label>
    </div>
  );
}

type StackPopupProps = {
  stackPopup: { x: number; y: number; ids: number[] };
  stackPopupItems: EntryAnnotation[];
  onOpenAnnotation: (ann: EntryAnnotation) => void;
  onClose: () => void;
};

export function StackPopup({
  stackPopup,
  stackPopupItems,
  onOpenAnnotation,
  onClose,
}: StackPopupProps) {
  if (!stackPopupItems.length) return null;
  return (
    <div
      className={styles.stackPopup}
      data-stack-popup="1"
      style={{
        left: Math.min(window.innerWidth - 280, Math.max(12, stackPopup.x)),
        top: Math.min(window.innerHeight - 200, Math.max(12, stackPopup.y + 8)),
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className={styles.stackPopupHead}>此处有 {stackPopupItems.length} 条标注</div>
      <ul className={styles.stackPopupList}>
        {stackPopupItems.map((ann) => (
          <li key={ann.id}>
            <button
              type="button"
              className={styles.stackPopupItem}
              onClick={() => {
                onClose();
                onOpenAnnotation(ann);
              }}
            >
              <span
                className={styles.noteDot}
                style={{ background: normalizeColor(ann.color) }}
              />
              <span className={styles.stackPopupText}>
                <strong>
                  {isChatAnchor(ann)
                    ? anchorLabel(ann)
                    : ann.note?.trim() || "仅高亮"}
                </strong>
                <em>
                  {ann.quote.slice(0, 36)}
                  {ann.quote.length > 36 ? "…" : ""}
                </em>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Button size="small" type="text" block onClick={onClose}>
        关闭
      </Button>
    </div>
  );
}

type SelectionPopupProps = {
  pendingSel: PendingSel;
  saving: boolean;
  onConfirmHighlight: () => void;
  onOpenNoteDraft: () => void;
  onClearPending: () => void;
  onColorChange: (color: string) => void;
};

export function SelectionPopup({
  pendingSel,
  saving,
  onConfirmHighlight,
  onOpenNoteDraft,
  onClearPending,
  onColorChange,
}: SelectionPopupProps) {
  return (
    <div
      className={`${styles.selPopup}${pendingSel.placeBelow ? ` ${styles.selPopupBelow}` : ""}`}
      data-sel-popup="1"
      style={{ left: pendingSel.x, top: pendingSel.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className={styles.selPopupLabel}>颜色</span>
      <ColorPicker value={pendingSel.color} onChange={onColorChange} compact />
      <Button
        size="small"
        type="primary"
        loading={saving}
        onClick={() => void onConfirmHighlight()}
      >
        确认高亮
      </Button>
      <Button size="small" onClick={onOpenNoteDraft}>
        写笔记
      </Button>
      <Button size="small" type="text" onClick={onClearPending}>
        取消
      </Button>
    </div>
  );
}

type DraftModalProps = {
  open: boolean;
  draftSel: { start: number; end: number; quote: string } | null;
  draftNote: string;
  draftColor: string;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  onDraftNoteChange: (value: string) => void;
  onDraftColorChange: (color: string) => void;
  onPendingColorChange: (color: string) => void;
};

export function DraftNoteModal({
  open,
  draftSel,
  draftNote,
  draftColor,
  saving,
  onCancel,
  onSave,
  onDraftNoteChange,
  onDraftColorChange,
  onPendingColorChange,
}: DraftModalProps) {
  return (
    <Modal
      title="写笔记"
      open={open}
      onCancel={onCancel}
      onOk={onSave}
      confirmLoading={saving}
      okText="保存"
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" className={styles.quoteBox}>
        {draftSel?.quote}
      </Typography.Paragraph>
      <ColorPicker
        value={draftColor}
        onChange={(hex) => {
          onDraftColorChange(hex);
          onPendingColorChange(hex);
        }}
      />
      <Input.TextArea
        rows={4}
        value={draftNote}
        onChange={(e) => onDraftNoteChange(e.target.value)}
        placeholder="写下你的批注（可空，仅高亮）"
        maxLength={2000}
      />
    </Modal>
  );
}

type EditModalProps = {
  open: boolean;
  editAnn: EntryAnnotation | null;
  editNote: string;
  editColor: string;
  editRange: { start: number; end: number; quote: string } | null;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  onSaveAndClose: () => void;
  onDelete: () => void;
  onPromote: () => void;
  onBeginReselect: () => void;
  onClearEditRange: () => void;
  onEditNoteChange: (value: string) => void;
  onEditColorChange: (color: string) => void;
};

export function EditAnnotationModal({
  open,
  editAnn,
  editNote,
  editColor,
  editRange,
  saving,
  onCancel,
  onSave,
  onSaveAndClose,
  onDelete,
  onPromote,
  onBeginReselect,
  onClearEditRange,
  onEditNoteChange,
  onEditColorChange,
}: EditModalProps) {
  return (
    <Modal
      title={editAnn && isChatAnchor(editAnn) ? "对话预笔记" : "笔记详情"}
      open={open}
      onCancel={onCancel}
      width={640}
      footer={
        <Space wrap>
          <Popconfirm
            title={editAnn && isChatAnchor(editAnn) ? "确定删除这条预笔记？" : "确定删除这条笔记？"}
            onConfirm={onDelete}
          >
            <Button danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
          <Button onClick={onCancel}>取消</Button>
          <Button loading={saving} onClick={() => void onSave()}>
            保存
          </Button>
          {editAnn && isChatAnchor(editAnn) ? (
            <Popconfirm
              title="确认加入正式笔记？"
              description="加入后会出现在「我的笔记」，可随时再编辑。"
              okText="确认加入"
              cancelText="再想想"
              onConfirm={() => void onPromote()}
            >
              <Button type="primary" loading={saving}>
                加入正式笔记
              </Button>
            </Popconfirm>
          ) : (
            <Button type="primary" icon={<EditOutlined />} loading={saving} onClick={() => void onSaveAndClose()}>
              保存并关闭
            </Button>
          )}
        </Space>
      }
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" className={styles.quoteBox}>
        {editRange?.quote ?? editAnn?.quote}
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Button type="primary" ghost onClick={onBeginReselect}>
          重新划选范围
        </Button>
        {editRange ? (
          <Button type="link" onClick={onClearEditRange}>
            还原为原范围
          </Button>
        ) : null}
      </Space>
      {editRange ? (
        <Typography.Paragraph type="success" style={{ marginTop: 0 }}>
          已换成新划选（未保存）。确认无误后点「保存」。
        </Typography.Paragraph>
      ) : (
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          点「重新划选范围」后，编辑窗会先关掉，请在正文里拖选一段文字；松手即回来。也可只改颜色后保存。
        </Typography.Paragraph>
      )}
      <ColorPicker value={editColor} onChange={onEditColorChange} />
      <Input.TextArea
        rows={4}
        value={editNote}
        onChange={(e) => onEditNoteChange(e.target.value)}
        placeholder={
          editAnn && isChatAnchor(editAnn)
            ? "知识点标题（可编辑）"
            : "批注内容"
        }
        maxLength={2000}
      />
    </Modal>
  );
}
