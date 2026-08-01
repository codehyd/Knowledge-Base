import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  BookOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FormOutlined,
  PlayCircleOutlined,
  ReadOutlined,
  SearchOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { App, Button, Empty, Input, Popconfirm, Tag, Typography } from "antd";
import {
  api,
  type CategoryItem,
  type EntryDetail,
  type EntryListItem,
} from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { TextPreviewModal } from "@/shared/ui/TextPreviewModal";
import { VideoPreviewPanel } from "@/shared/ui/VideoPreviewPanel";
import { FollowAlongPlayer } from "@/shared/ui/FollowAlongPlayer";
import { BookshelfModal } from "./BookshelfModal";
import { MediaShelfModal } from "./MediaShelfModal";
import styles from "./KnowledgePage.module.css";

function sourceTypeLabel(type?: string) {
  switch (type) {
    case "video_url":
    case "video_file":
      return "视频";
    case "url":
      return "网页";
    case "ebook":
      return "书籍";
    case "note":
      return "笔记";
    default:
      return "";
  }
}

const LIST_TAG_LIMIT = 4;

function DeleteConfirmBody({ inVault }: { inVault?: boolean }) {
  return (
    <div className={styles.deleteConfirmBody}>
      <p className={styles.deleteConfirmLead}>
        {inVault
          ? "将永久删除，不可恢复。具体包括："
          : "将从知识库移除，不可恢复。具体包括："}
      </p>
      <ul className={styles.deleteConfirmPoints}>
        {inVault ? (
          <>
            <li>知识库中的条目与检索切片</li>
            <li>笔记库中的文件（.md / .lake），侧栏会同步消失</li>
            <li>喂养来源记录与本地 uploads 缓存</li>
          </>
        ) : (
          <>
            <li>知识库中的这条条目与检索切片</li>
            <li>喂养来源恢复为「可重新入库」（不删原文件）</li>
          </>
        )}
      </ul>
    </div>
  );
}

function visibleTags(names: string[], limit = LIST_TAG_LIMIT) {
  const cleaned = (names || []).map((n) => n.trim()).filter(Boolean);
  return {
    shown: cleaned.slice(0, limit),
    more: Math.max(0, cleaned.length - limit),
  };
}

function formatDate(value?: string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function KnowledgePage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [totalEntries, setTotalEntries] = useState(0);
  const [items, setItems] = useState<EntryListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewEntryId, setPreviewEntryId] = useState<number | null>(null);
  const [previewSourceId, setPreviewSourceId] = useState<number | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [bookshelfOpen, setBookshelfOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [focusSourceId, setFocusSourceId] = useState<number | null>(null);
  const [kind, setKind] = useState("");

  // 笔记侧栏「资源」跳转：?source=ID&open=bookshelf|media|entry
  const selectEntryBySource = useCallback(
    async (sourceId: number) => {
      try {
        let page = 1;
        const pageSize = 100;
        for (;;) {
          const res = await api.listEntries({ page, page_size: pageSize });
          const hit = res.items.find((i) => i.source_id === sourceId);
          if (hit) {
            setSelectedId(hit.id);
            setKind("");
            setCategory("");
            setSearch("");
            setQ("");
            return true;
          }
          if (page * pageSize >= res.total || res.items.length === 0) break;
          page += 1;
        }
        message.warning("未找到对应知识条目，可能尚未入库");
        return false;
      } catch (err) {
        message.error(formatError(err));
        return false;
      }
    },
    [message],
  );

  useEffect(() => {
    const raw = searchParams.get("source");
    const open = searchParams.get("open") || "entry";
    const sourceId = raw ? Number(raw) : NaN;
    if (!Number.isFinite(sourceId) || sourceId <= 0) return;

    setFocusSourceId(sourceId);
    if (open === "bookshelf") {
      setBookshelfOpen(true);
      setMediaOpen(false);
    } else if (open === "media") {
      setMediaOpen(true);
      setBookshelfOpen(false);
    } else {
      setBookshelfOpen(false);
      setMediaOpen(false);
      void selectEntryBySource(sourceId);
    }

    // 消费掉参数，避免返回页面反复弹出
    const next = new URLSearchParams(searchParams);
    next.delete("source");
    next.delete("open");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, selectEntryBySource]);

  const refreshCategories = useCallback(async () => {
    const res = await api.listCategories();
    setCategories(res.items);
    setTotalEntries(res.total_entries);
  }, []);

  const refreshEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listEntries({
        q: search,
        category,
        kind,
        page: 1,
        page_size: 50,
      });
      setItems(res.items);
      setTotal(res.total);
      setSelectedId((prev) => {
        if (res.items.length === 0) return null;
        if (prev != null && res.items.some((i) => i.id === prev)) return prev;
        return res.items[0].id;
      });
    } finally {
      setLoading(false);
    }
  }, [category, kind, search]);

  useEffect(() => {
    void (async () => {
      try {
        await refreshCategories();
      } catch (err) {
        message.error(formatError(err, "加载分类失败"));
      }
    })();
  }, [message, refreshCategories]);

  useEffect(() => {
    void (async () => {
      try {
        await refreshEntries();
      } catch (err) {
        message.error(formatError(err, "加载条目失败"));
      }
    })();
  }, [message, refreshEntries]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void (async () => {
      try {
        const res = await api.getEntry(selectedId);
        if (!cancelled) setDetail(res);
      } catch (err) {
        if (!cancelled) {
          setDetail(null);
          message.error(formatError(err, "加载详情失败"));
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [message, selectedId]);

  async function onDelete(id: number) {
    try {
      const item = detail?.id === id ? detail : items.find((i) => i.id === id);
      await api.deleteEntry(id);
      message.success(
        item?.in_vault
          ? "已删除知识条目，笔记库文件已同步清理"
          : "已删除知识条目；来源可在喂养页重新入库",
      );
      setSelectedId((prev) => (prev === id ? null : prev));
      setDetail(null);
      setPreviewOpen(false);
      await refreshCategories();
      await refreshEntries();
    } catch (err) {
      message.error(formatError(err, "删除失败"));
    }
  }

  async function openPreview(entryId: number) {
    setPreviewLoading(true);
    setPreviewEntryId(entryId);
    setPreviewSourceId(
      detail?.id === entryId
        ? detail.source_id ?? null
        : items.find((i) => i.id === entryId)?.source_id ?? null,
    );
    setPreviewTitle(
      detail?.id === entryId
        ? detail.title
        : items.find((i) => i.id === entryId)?.title || "正文预览",
    );
    setPreviewOpen(true);
    setPreviewLoading(false);
  }

  if (totalEntries === 0 && !loading && !search && !category) {
    return (
      <section className={styles.page}>
        <header className={styles.header}>
          <div>
            <h1>
              <BookOutlined /> 知识浏览
            </h1>
            <Typography.Paragraph type="secondary" className={styles.subtitle}>
              按分类浏览已入库材料；书籍进书架，视频/链接进媒体库，均可预览正文。
            </Typography.Paragraph>
          </div>
          <div className={styles.headerActions}>
            <Button type="primary" icon={<FormOutlined />} onClick={() => navigate("/notes?new=1")}>
              写笔记
            </Button>
            <Button icon={<ReadOutlined />} onClick={() => setBookshelfOpen(true)}>
              书架
            </Button>
            <Button icon={<VideoCameraOutlined />} onClick={() => setMediaOpen(true)}>
              媒体库
            </Button>
          </div>
        </header>
        <div className={styles.emptyBox}>
          <Empty description="知识库仍为空">
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <Button type="primary" icon={<FormOutlined />} onClick={() => navigate("/notes?new=1")}>
                写笔记
              </Button>
              <Link to="/feed">
                <Button>去喂养投递材料</Button>
              </Link>
            </div>
          </Empty>
        </div>
        <BookshelfModal
          open={bookshelfOpen}
          focusSourceId={focusSourceId}
          onFocusMiss={(sourceId) => {
            setBookshelfOpen(false);
            setFocusSourceId(null);
            void selectEntryBySource(sourceId);
          }}
          onClose={() => {
            setBookshelfOpen(false);
            setFocusSourceId(null);
          }}
        />
        <MediaShelfModal
          open={mediaOpen}
          focusSourceId={focusSourceId}
          onFocusMiss={(sourceId) => {
            setMediaOpen(false);
            setFocusSourceId(null);
            void selectEntryBySource(sourceId);
          }}
          onClose={() => {
            setMediaOpen(false);
            setFocusSourceId(null);
          }}
        />
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>
            <BookOutlined /> 知识浏览
          </h1>
          <p className={styles.subtitle}>共 {totalEntries} 条知识 · 当前列表 {total} 条</p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.kindTabs}>
            {[
              { value: "", label: "全部" },
              { value: "book", label: "书籍" },
              { value: "media", label: "视频与链接" },
            ].map((tab) => (
              <button
                key={tab.value || "all"}
                type="button"
                className={`${styles.kindTab}${kind === tab.value ? ` ${styles.kindTabActive}` : ""}`}
                onClick={() => setKind(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <Button type="primary" icon={<FormOutlined />} onClick={() => navigate("/notes?new=1")}>
            写笔记
          </Button>
          <Button icon={<ReadOutlined />} onClick={() => setBookshelfOpen(true)}>
            书架
          </Button>
          <Button icon={<VideoCameraOutlined />} onClick={() => setMediaOpen(true)}>
            媒体库
          </Button>
          <Input
            allowClear
            className={styles.search}
            prefix={<SearchOutlined />}
            placeholder="搜索标题或摘要"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.cats}>
          <button
            type="button"
            className={`${styles.catItem}${category === "" ? ` ${styles.catActive}` : ""}`}
            onClick={() => setCategory("")}
          >
            <span>全部</span>
            <em>{totalEntries}</em>
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`${styles.catItem}${category === cat.name ? ` ${styles.catActive}` : ""}`}
              onClick={() => setCategory(cat.name)}
            >
              <span>{cat.name}</span>
              <em>{cat.count}</em>
            </button>
          ))}
          {categories.length === 0 && (
            <p className={styles.catHint}>入库后会出现分类</p>
          )}
        </aside>

        <div className={styles.listPane}>
          {items.length === 0 ? (
            <div className={styles.emptyBox}>
              <Empty
                description={
                  category
                    ? "该分类尚无条目，去喂养投递材料"
                    : "没有匹配的条目"
                }
              >
                {category ? (
                  <Link to="/feed">
                    <Button type="primary">去喂养</Button>
                  </Link>
                ) : null}
              </Empty>
            </div>
          ) : (
            <ul className={styles.list}>
              {items.map((item) => (
                <li key={item.id} className={styles.listRow}>
                  <button
                    type="button"
                    className={`${styles.listItem}${
                      selectedId === item.id ? ` ${styles.listActive}` : ""
                    }`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <strong title={item.title || `条目 #${item.id}`}>
                      {item.title || `条目 #${item.id}`}
                    </strong>
                    <p title={item.summary || undefined}>{item.summary || "暂无摘要"}</p>
                    <div className={styles.listMeta}>
                      {sourceTypeLabel(item.source_type) ? (
                        <Tag
                          icon={
                            item.source_type === "video_url" ||
                            item.source_type === "video_file" ? (
                              <PlayCircleOutlined />
                            ) : undefined
                          }
                        >
                          {sourceTypeLabel(item.source_type)}
                        </Tag>
                      ) : null}
                      {(() => {
                        const { shown, more } = visibleTags(item.categories);
                        return (
                          <>
                            {shown.map((name) => (
                              <Tag key={name} title={name}>
                                {name}
                              </Tag>
                            ))}
                            {more > 0 ? (
                              <span className={styles.listMetaMore} title={item.categories.join("、")}>
                                +{more}
                              </span>
                            ) : null}
                          </>
                        );
                      })()}
                      <span className={styles.listMetaDate}>{formatDate(item.created_at)}</span>
                    </div>
                  </button>
                  <Popconfirm
                    title="确定删除这条知识？"
                    description={<DeleteConfirmBody inVault={item.in_vault} />}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void onDelete(item.id)}
                  >
                    <Button
                      type="text"
                      danger
                      size="small"
                      className={styles.listDelete}
                      icon={<DeleteOutlined />}
                      aria-label="删除"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Popconfirm>
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className={styles.detail}>
          {!selectedId || (!detail && !detailLoading) ? (
            <div className={styles.detailEmpty}>
              <Empty description="选择左侧条目查看详情" />
            </div>
          ) : detailLoading && !detail ? (
            <p className={styles.detailHint}>加载中…</p>
          ) : detail ? (
            <div className={styles.detailInner}>
              <div className={styles.detailHead}>
                <h2 title={detail.title}>{detail.title}</h2>
                <div className={styles.detailTags}>
                  {detail.categories.map((name) => (
                    <Tag key={name} color="processing" title={name}>
                      {name}
                    </Tag>
                  ))}
                </div>
                <p className={styles.detailMeta}>
                  {detail.source_type ? `类型：${sourceTypeLabel(detail.source_type)}` : ""}
                  {detail.source_filename
                    ? `${detail.source_type ? " · " : ""}来源：${detail.source_filename}`
                    : ""}
                  {detail.source_uri ? (
                    <>
                      {" · "}
                      <a href={detail.source_uri} target="_blank" rel="noreferrer">
                        原始链接
                      </a>
                    </>
                  ) : null}
                  {detail.created_at ? ` · ${formatDate(detail.created_at)}` : ""}
                </p>
              </div>

              <div className={styles.detailScroll}>
                {detail.source_type === "video_url" && detail.source_uri ? (
                  <div className={`${styles.detailSection} ${styles.detailSectionVideo}`}>
                    <div className={styles.sectionHead}>
                      <h3>视频预览</h3>
                    </div>
                    <VideoPreviewPanel
                      title={detail.title}
                      url={detail.source_uri}
                      compact
                    />
                  </div>
                ) : null}

                {(detail.source_type === "video_url" ||
                  detail.source_type === "video_file") &&
                detail.source_id &&
                detail.has_follow_along ? (
                  <div className={`${styles.detailSection} ${styles.detailSectionFill}`}>
                    <div className={styles.sectionHead}>
                      <h3>文案跟读</h3>
                    </div>
                    <FollowAlongPlayer
                      sourceId={detail.source_id}
                      title={detail.title}
                      compact
                    />
                  </div>
                ) : (
                  <div className={`${styles.detailSection} ${styles.detailSectionFill}`}>
                    <div className={styles.sectionHead}>
                      <h3>原文预览</h3>
                    </div>
                    <pre className={styles.preview}>{detail.preview || "暂无原文"}</pre>
                    {detail.preview_truncated && (
                      <Button
                        type="link"
                        size="small"
                        className={styles.moreLink}
                        onClick={() => void openPreview(detail.id)}
                      >
                        内容已截断，点击查看更多
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <div className={styles.detailActions}>
                <Popconfirm
                  title="确定删除这条知识？"
                  description={<DeleteConfirmBody inVault={detail.in_vault} />}
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void onDelete(detail.id)}
                >
                  <Button danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
                {detail.source_type === "note" && detail.source_id ? (
                  <Button
                    icon={<EditOutlined />}
                    onClick={() =>
                      navigate(`/notes?id=${detail.source_id}`)
                    }
                  >
                    在笔记库编辑
                  </Button>
                ) : null}
                <Button
                  icon={<EyeOutlined />}
                  loading={previewLoading}
                  onClick={() => void openPreview(detail.id)}
                >
                  预览正文
                </Button>
                <Link to="/chat">
                  <Button type="primary">在对话中提问</Button>
                </Link>
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      <TextPreviewModal
        open={previewOpen}
        title={previewTitle || detail?.title || "正文预览"}
        entryId={previewEntryId}
        sourceId={previewSourceId}
        onClose={() => {
          setPreviewOpen(false);
          setPreviewEntryId(null);
          setPreviewSourceId(null);
        }}
        loadSegment={async (offset, limit) => {
          if (previewEntryId == null) {
            return { text: "", char_count: 0, offset: 0, truncated: false };
          }
          try {
            const res = await api.previewEntry(previewEntryId, { offset, limit });
            return {
              text: res.text,
              char_count: res.char_count,
              offset: res.offset,
              truncated: res.truncated,
            };
          } catch (err) {
            const sourceId = previewSourceId ?? (detail?.id === previewEntryId ? detail.source_id : null);
            if (!sourceId) throw err;
            const res = await api.previewSource(sourceId, { offset, limit });
            return {
              text: res.text,
              char_count: res.char_count,
              offset: res.offset,
              truncated: res.truncated,
            };
          }
        }}
        searchAll={async (q, params) => {
          if (previewEntryId == null) return { total: 0, offset: 0, hits: [] };
          try {
            const res = await api.searchEntryPreview(previewEntryId, q, params);
            return { total: res.total, offset: res.offset, hits: res.hits };
          } catch (err) {
            const sourceId = previewSourceId ?? (detail?.id === previewEntryId ? detail.source_id : null);
            if (!sourceId) throw err;
            const res = await api.searchSourcePreview(sourceId, q, params);
            return { total: res.total, offset: res.offset, hits: res.hits };
          }
        }}
      />
      <BookshelfModal
        open={bookshelfOpen}
        focusSourceId={focusSourceId}
        onFocusMiss={(sourceId) => {
          setBookshelfOpen(false);
          setFocusSourceId(null);
          void selectEntryBySource(sourceId);
        }}
        onClose={() => {
          setBookshelfOpen(false);
          setFocusSourceId(null);
        }}
      />
      <MediaShelfModal
        open={mediaOpen}
        focusSourceId={focusSourceId}
        onFocusMiss={(sourceId) => {
          setMediaOpen(false);
          setFocusSourceId(null);
          void selectEntryBySource(sourceId);
        }}
        onClose={() => {
          setMediaOpen(false);
          setFocusSourceId(null);
        }}
      />
    </section>
  );
}
