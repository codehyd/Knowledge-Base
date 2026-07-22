import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  BookOutlined,
  DeleteOutlined,
  EyeOutlined,
  SearchOutlined,
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
import styles from "./KnowledgePage.module.css";

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
  const [previewTitle, setPreviewTitle] = useState("");

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
  }, [category, search]);

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
      await api.deleteEntry(id);
      message.success("已删除，可在喂养页重新入库");
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
          <h1>
            <BookOutlined /> 知识浏览
          </h1>
          <Typography.Paragraph type="secondary" className={styles.subtitle}>
            按分类浏览已入库材料，查看摘要与原文预览。
          </Typography.Paragraph>
        </header>
        <div className={styles.emptyBox}>
          <Empty description="知识库仍为空">
            <Link to="/feed">
              <Button type="primary">去喂养投递材料</Button>
            </Link>
          </Empty>
        </div>
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
        <Input
          allowClear
          className={styles.search}
          prefix={<SearchOutlined />}
          placeholder="搜索标题或摘要"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
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
                    <strong>{item.title || `条目 #${item.id}`}</strong>
                    <p>{item.summary || "暂无摘要"}</p>
                    <div className={styles.listMeta}>
                      {item.categories.map((name) => (
                        <Tag key={name}>{name}</Tag>
                      ))}
                      <span>{formatDate(item.created_at)}</span>
                    </div>
                  </button>
                  <Popconfirm
                    title="确定删除这条知识？"
                    description="删除后可在喂养页重新入库。"
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
                <h2>{detail.title}</h2>
                <div className={styles.detailTags}>
                  {detail.categories.map((name) => (
                    <Tag key={name} color="processing">
                      {name}
                    </Tag>
                  ))}
                </div>
                <p className={styles.detailMeta}>
                  {detail.source_filename
                    ? `来源：${detail.source_filename}`
                    : detail.source_type
                      ? `类型：${detail.source_type}`
                      : ""}
                  {detail.created_at ? ` · ${formatDate(detail.created_at)}` : ""}
                </p>
              </div>

              <div className={styles.detailScroll}>
                <div className={styles.detailSection}>
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
              </div>

              <div className={styles.detailActions}>
                <Popconfirm
                  title="确定删除这条知识？"
                  description="将从知识库移除；对应喂养来源会恢复为可入库状态。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void onDelete(detail.id)}
                >
                  <Button danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
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
        onClose={() => {
          setPreviewOpen(false);
          setPreviewEntryId(null);
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
            const sourceId =
              detail?.id === previewEntryId ? detail.source_id : null;
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
            const sourceId =
              detail?.id === previewEntryId ? detail.source_id : null;
            if (!sourceId) throw err;
            const res = await api.searchSourcePreview(sourceId, q, params);
            return { total: res.total, offset: res.offset, hits: res.hits };
          }
        }}
      />
    </section>
  );
}
