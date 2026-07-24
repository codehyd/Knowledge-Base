import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ReadOutlined } from "@ant-design/icons";
import { App, Button, Empty, Modal, Spin, Tag } from "antd";
import { api, type BookshelfItem } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { TextPreviewModal } from "@/shared/ui/TextPreviewModal";
import styles from "./BookshelfModal.module.css";

const SPINE_PALETTES = [
  ["#1f4e46", "#2a6f6a"],
  ["#3d2c29", "#6b4a42"],
  ["#243447", "#3a5570"],
  ["#4a3728", "#7a5a3c"],
  ["#2c3e50", "#4a6478"],
  ["#3b2f4a", "#5c4a72"],
  ["#1e3a3a", "#356363"],
  ["#4a2c2a", "#734443"],
];

function spineStyle(title: string, index: number) {
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) {
    hash = (hash * 31 + title.charCodeAt(i)) | 0;
  }
  const palette = SPINE_PALETTES[Math.abs(hash + index) % SPINE_PALETTES.length];
  const tall = 168 + (Math.abs(hash) % 36);
  return {
    background: `linear-gradient(160deg, ${palette[0]} 0%, ${palette[1]} 100%)`,
    height: tall,
  };
}

function formatLabel(item: BookshelfItem) {
  const fmt = (item.format || "").toUpperCase();
  if (item.provenance === "open_book") return fmt ? `书库 · ${fmt}` : "书库";
  return fmt || "电子书";
}

type Props = {
  open: boolean;
  onClose: () => void;
};

export function BookshelfModal({ open, onClose }: Props) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<BookshelfItem[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewEntryId, setPreviewEntryId] = useState<number | null>(null);
  const [previewSourceId, setPreviewSourceId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listBookshelf();
      setItems(res.items);
    } catch (err) {
      message.error(formatError(err, "加载书架失败"));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const rows = useMemo(() => {
    const chunk = 6;
    const out: BookshelfItem[][] = [];
    for (let i = 0; i < items.length; i += chunk) {
      out.push(items.slice(i, i + chunk));
    }
    return out;
  }, [items]);

  function openBook(item: BookshelfItem) {
    setPreviewTitle(item.title);
    setPreviewEntryId(item.entry_id ?? null);
    setPreviewSourceId(item.source_id);
    setPreviewOpen(true);
  }

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        width={920}
        destroyOnHidden
        className={styles.modal}
        title={
          <span className={styles.modalTitle}>
            <ReadOutlined /> 书架
            <em>{items.length > 0 ? `${items.length} 本确认书籍` : "确认书籍"}</em>
          </span>
        }
      >
        <p className={styles.hint}>
          仅展示确认书籍（公版书库导入，或本地 EPUB / PDF）。本地 TXT
          标为「可能为书籍」，不进入书架。
        </p>

        {loading ? (
          <div className={styles.loading}>
            <Spin />
          </div>
        ) : items.length === 0 ? (
          <div className={styles.empty}>
            <Empty description="书架还是空的">
              <Link to="/feed" onClick={onClose}>
                <Button type="primary">去喂养 · 公版书搜索</Button>
              </Link>
            </Empty>
          </div>
        ) : (
          <div className={styles.room}>
            {rows.map((row, rowIdx) => (
              <div key={`shelf-${rowIdx}`} className={styles.shelf}>
                <div className={styles.books}>
                  {row.map((item, idx) => (
                    <button
                      key={item.source_id}
                      type="button"
                      className={styles.book}
                      style={spineStyle(item.title, rowIdx * 6 + idx)}
                      onClick={() => openBook(item)}
                      title={item.title}
                    >
                      <span className={styles.spineEdge} />
                      <span className={styles.spineTitle}>{item.title}</span>
                      <span className={styles.spineMeta}>
                        <Tag className={styles.tag}>{formatLabel(item)}</Tag>
                        {!item.entry_id ? (
                          <span className={styles.needIngest}>未入库</span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                </div>
                <div className={styles.board} />
              </div>
            ))}
          </div>
        )}
      </Modal>

      <TextPreviewModal
        open={previewOpen}
        title={previewTitle || "正文预览"}
        entryId={previewEntryId}
        sourceId={previewSourceId}
        onClose={() => {
          setPreviewOpen(false);
          setPreviewEntryId(null);
          setPreviewSourceId(null);
        }}
        loadSegment={async (offset, limit) => {
          if (previewEntryId != null) {
            try {
              const res = await api.previewEntry(previewEntryId, { offset, limit });
              return {
                text: res.text,
                char_count: res.char_count,
                offset: res.offset,
                truncated: res.truncated,
              };
            } catch {
              /* fall through to source */
            }
          }
          if (previewSourceId == null) {
            return { text: "", char_count: 0, offset: 0, truncated: false };
          }
          const res = await api.previewSource(previewSourceId, { offset, limit });
          return {
            text: res.text,
            char_count: res.char_count,
            offset: res.offset,
            truncated: res.truncated,
          };
        }}
        searchAll={async (q, params) => {
          if (previewEntryId != null) {
            try {
              const res = await api.searchEntryPreview(previewEntryId, q, params);
              return { total: res.total, offset: res.offset, hits: res.hits };
            } catch {
              /* fall through */
            }
          }
          if (previewSourceId == null) return { total: 0, offset: 0, hits: [] };
          const res = await api.searchSourcePreview(previewSourceId, q, params);
          return { total: res.total, offset: res.offset, hits: res.hits };
        }}
      />
    </>
  );
}
