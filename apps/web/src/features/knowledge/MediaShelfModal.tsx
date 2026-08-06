import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  FolderOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
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

type MediaGroup = {
  key: string;
  title: string;
  isCollection: boolean;
  items: MediaItem[];
};

function groupMediaItems(items: MediaItem[]): MediaGroup[] {
  const map = new Map<string, MediaGroup>();
  const singles: MediaItem[] = [];
  for (const item of items) {
    const col = (item.collection_title || "").trim();
    if (!col) {
      singles.push(item);
      continue;
    }
    let g = map.get(col);
    if (!g) {
      g = { key: col, title: col, isCollection: true, items: [] };
      map.set(col, g);
    }
    g.items.push(item);
  }
  for (const g of map.values()) {
    g.items.sort((a, b) => (a.episode_no || 0) - (b.episode_no || 0));
  }
  const groups = [...map.values()].sort((a, b) => a.title.localeCompare(b.title, "zh"));
  if (singles.length) {
    groups.push({
      key: "__single__",
      title: "单集 / 链接",
      isCollection: false,
      items: singles,
    });
  }
  return groups;
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** 打开后自动定位该 source */
  focusSourceId?: number | null;
  onFocusMiss?: (sourceId: number) => void;
};

export function MediaShelfModal({
  open,
  onClose,
  focusSourceId = null,
  onFocusMiss,
}: Props) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeItem, setActiveItem] = useState<MediaItem | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewEntryId, setPreviewEntryId] = useState<number | null>(null);
  const [previewSourceId, setPreviewSourceId] = useState<number | null>(null);
  const focusedRef = useRef<number | null>(null);

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

  const groups = useMemo(() => groupMediaItems(items), [items]);

  useEffect(() => {
    if (!open) {
      focusedRef.current = null;
      return;
    }
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

  useEffect(() => {
    if (!open || loading || !focusSourceId) return;
    if (focusedRef.current === focusSourceId) return;
    const hit = items.find((i) => i.source_id === focusSourceId);
    focusedRef.current = focusSourceId;
    if (hit) {
      openItem(hit);
      return;
    }
    onFocusMiss?.(focusSourceId);
  }, [open, loading, focusSourceId, items, onFocusMiss]);

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
          合集按文件夹分组；滚动时分组标题会吸顶（类似通讯录）。已入库的也可在知识页「合集」筛选。
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
          <div className={styles.groups}>
            {groups.map((group) => {
              const isCollapsed = Boolean(collapsed[group.key]);
              return (
                <section key={group.key} className={styles.group}>
                  <button
                    type="button"
                    className={styles.groupHead}
                    onClick={() =>
                      setCollapsed((prev) => ({
                        ...prev,
                        [group.key]: !prev[group.key],
                      }))
                    }
                  >
                    <FolderOutlined />
                    <strong>{group.title}</strong>
                    <em>
                      {group.items.length}
                      {group.isCollection ? " 集" : " 条"}
                    </em>
                    <span className={styles.groupToggle}>
                      {isCollapsed ? "展开" : "收起"}
                    </span>
                  </button>
                  {isCollapsed ? null : (
                    <ul className={styles.list}>
                      {group.items.map((item) => (
                        <li key={item.source_id}>
                          <button
                            type="button"
                            className={styles.card}
                            onClick={() => openItem(item)}
                          >
                            <span className={styles.icon}>
                              {item.media_type === "video_url" ||
                              item.media_type === "video_file" ? (
                                <PlayCircleOutlined />
                              ) : (
                                <LinkOutlined />
                              )}
                            </span>
                            <span className={styles.body}>
                              <strong>
                                {item.episode_no && item.episode_no > 0 ? (
                                  <span className={styles.epBadge}>P{item.episode_no}</span>
                                ) : null}
                                {item.title}
                              </strong>
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
                </section>
              );
            })}
          </div>
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
