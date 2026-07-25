import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LinkOutlined, PlayCircleOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { App, Button, Empty, Modal, Spin, Tag } from "antd";
import { api, type MediaItem } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { TextPreviewModal } from "@/shared/ui/TextPreviewModal";
import { VideoPreviewPanel } from "@/shared/ui/VideoPreviewPanel";
import { FollowAlongPlayer } from "@/shared/ui/FollowAlongPlayer";
import styles from "./MediaShelfModal.module.css";

function mediaLabel(item: MediaItem) {
  if (item.media_type === "video_url" || item.media_type === "video_file") return "视频";
  if (item.media_type === "url") return "网页";
  return "链接";
}

type Props = {
  open: boolean;
  onClose: () => void;
};

export function MediaShelfModal({ open, onClose }: Props) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeItem, setActiveItem] = useState<MediaItem | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewEntryId, setPreviewEntryId] = useState<number | null>(null);
  const [previewSourceId, setPreviewSourceId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listMedia();
      setItems(res.items);
    } catch (err) {
      message.error(formatError(err, "加载媒体库失败"));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  function openItem(item: MediaItem) {
    if (item.media_type === "video_url" || item.media_type === "video_file") {
      setActiveItem(item);
      setDetailOpen(true);
      return;
    }
    setPreviewTitle(item.title);
    setPreviewEntryId(item.entry_id ?? null);
    setPreviewSourceId(item.source_id);
    setPreviewOpen(true);
  }

  function openTranscript(item: MediaItem) {
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
        width={860}
        destroyOnHidden
        className={styles.modal}
        title={
          <span className={styles.modalTitle}>
            <VideoCameraOutlined /> 媒体库
            <em>{items.length > 0 ? `${items.length} 条视频/链接` : "视频与链接"}</em>
          </span>
        }
      >
        <p className={styles.hint}>
          展示抖音/B站等视频与网页链接的转写文案。已入库的可在左侧知识列表中按「视频与链接」筛选。
        </p>

        {loading ? (
          <div className={styles.loading}>
            <Spin />
          </div>
        ) : items.length === 0 ? (
          <div className={styles.empty}>
            <Empty description="还没有视频或链接">
              <Link to="/feed" onClick={onClose}>
                <Button type="primary">去喂养 · 粘贴链接</Button>
              </Link>
            </Empty>
          </div>
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.source_id}>
                <button type="button" className={styles.card} onClick={() => openItem(item)}>
                  <span className={styles.icon}>
                    {item.media_type === "video_url" || item.media_type === "video_file" ? (
                      <PlayCircleOutlined />
                    ) : (
                      <LinkOutlined />
                    )}
                  </span>
                  <span className={styles.body}>
                    <strong>{item.title}</strong>
                    {item.source_uri ? (
                      <span className={styles.uri}>{item.source_uri}</span>
                    ) : null}
                    <span className={styles.meta}>
                      <Tag>{mediaLabel(item)}</Tag>
                      {item.status === "committed" || item.entry_id ? (
                        <Tag color="success">已入库</Tag>
                      ) : (
                        <Tag color="warning">待入库</Tag>
                      )}
                      {item.has_follow_along ? (
                        <Tag color="processing">可跟读</Tag>
                      ) : null}
                      {item.char_count > 0 ? `${item.char_count} 字` : null}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <Modal
        open={detailOpen}
        onCancel={() => {
          setDetailOpen(false);
          setActiveItem(null);
        }}
        footer={null}
        width={720}
        destroyOnHidden
        title={activeItem?.title || "视频预览"}
      >
        {activeItem ? (
          <div className={styles.detail}>
            {activeItem.source_uri ? (
              <VideoPreviewPanel title={activeItem.title} url={activeItem.source_uri} />
            ) : null}
            {activeItem.has_follow_along ? (
              <FollowAlongPlayer sourceId={activeItem.source_id} title={activeItem.title} />
            ) : null}
            <div className={styles.detailActions}>
              <Button onClick={() => openTranscript(activeItem)}>
                {activeItem.has_follow_along ? "查看全文" : "预览正文"}
              </Button>
            </div>
          </div>
        ) : null}
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
              /* fall through */
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
