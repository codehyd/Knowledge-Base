import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ApartmentOutlined,
  BookOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  EyeOutlined,
  FolderOutlined,
  FormOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReadOutlined,
  SearchOutlined,
  TagsOutlined,
  UnorderedListOutlined,
  UpOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import {
  App,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Tag,
  Typography,
} from "antd";
import {
  api,
  type CategoryItem,
  type CollectionItem,
  type EntryDetail,
  type EntryListItem,
} from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { PdfPreviewModal } from "@/shared/ui/PdfPreviewModal";
import { TextPreviewModal } from "@/shared/ui/TextPreviewModal";
import { VideoPreviewPanel } from "@/shared/ui/VideoPreviewPanel";
import { FollowAlongPlayer } from "@/shared/ui/FollowAlongPlayer";
import { BookshelfModal } from "./BookshelfModal";
import { MediaShelfModal } from "./MediaShelfModal";
import styles from "./KnowledgePage.module.css";

const ENTRY_DND_MIME = "text/kongku-entry";
const COLLECTION_DND_MIME = "text/kongku-collection";

type KnowledgeListRow =
  | { kind: "entry"; item: EntryListItem }
  | {
      kind: "collection";
      title: string;
      count: number;
      sample: EntryListItem;
      maxEpisode: number;
    };

function isPdfEntry(detail: EntryDetail | null) {
  const filename = (detail?.source_filename || "").toLowerCase();
  return filename.endsWith(".pdf");
}

const GraphView = lazy(() =>
  import("./GraphView").then((m) => ({ default: m.GraphView })),
);

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
            <li>笔记库中的文件（.md），侧栏会同步消失</li>
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
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [totalEntries, setTotalEntries] = useState(0);
  const [items, setItems] = useState<EntryListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [batchIds, setBatchIds] = useState<number[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [detailInfoOpen, setDetailInfoOpen] = useState(false);
  const [detailVideoOpen, setDetailVideoOpen] = useState(false);
  const [detailTall, setDetailTall] = useState(false);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [domainModalOpen, setDomainModalOpen] = useState(false);
  const [domainName, setDomainName] = useState("");
  const [domainSaving, setDomainSaving] = useState(false);
  const [renameTarget, setRenameTarget] = useState<CategoryItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [entryDomainIds, setEntryDomainIds] = useState<number[]>([]);
  const [entryDomainSaving, setEntryDomainSaving] = useState(false);
  const [draggingEntryId, setDraggingEntryId] = useState<number | null>(null);
  const [draggingCollectionTitle, setDraggingCollectionTitle] = useState<string | null>(
    null,
  );
  const [dropDomainId, setDropDomainId] = useState<number | null>(null);
  const [assigningEntry, setAssigningEntry] = useState(false);
  const entryDragMovedRef = useRef(false);
  const collectionDragMovedRef = useRef(false);
  const listPaneRef = useRef<HTMLDivElement | null>(null);
  const listItemRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewEntryId, setPreviewEntryId] = useState<number | null>(null);
  const [previewSourceId, setPreviewSourceId] = useState<number | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [bookshelfOpen, setBookshelfOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [focusSourceId, setFocusSourceId] = useState<number | null>(null);
  const [kind, setKind] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "graph">("list");

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
    const [catRes, colRes] = await Promise.all([
      api.listCategories(),
      api.listCollections().catch(() => ({ items: [] as CollectionItem[] })),
    ]);
    setCategories(catRes.items);
    setTotalEntries(catRes.total_entries);
    setCollections(colRes.items || []);
  }, []);

  const domains = useMemo(
    () => categories.filter((c) => (c.kind || "tag") === "domain"),
    [categories],
  );

  const collectionTitleSet = useMemo(
    () => new Set(collections.map((c) => c.title)),
    [collections],
  );

  const activeCollection = collectionTitleSet.has(category) ? category : "";

  /** 非合集视图：同一合集的分集收成一行，点击进入合集 */
  const listRows = useMemo((): KnowledgeListRow[] => {
    if (activeCollection) {
      return items.map((item) => ({ kind: "entry" as const, item }));
    }
    const byTitle = new Map<string, EntryListItem[]>();
    for (const item of items) {
      const title = (item.collection_title || "").trim();
      if (!title) continue;
      const bucket = byTitle.get(title);
      if (bucket) bucket.push(item);
      else byTitle.set(title, [item]);
    }
    const rows: KnowledgeListRow[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const title = (item.collection_title || "").trim();
      if (title) {
        if (seen.has(title)) continue;
        seen.add(title);
        const members = byTitle.get(title) || [item];
        let maxEpisode = 0;
        for (const m of members) {
          const n = m.episode_no || 0;
          if (n > maxEpisode) maxEpisode = n;
        }
        rows.push({
          kind: "collection",
          title,
          count: members.length,
          sample: members[0],
          maxEpisode,
        });
      } else {
        rows.push({ kind: "entry", item });
      }
    }
    return rows;
  }, [items, activeCollection]);

  useEffect(() => {
    // 离开合集视图时清空多选
    setBatchIds([]);
  }, [activeCollection]);

  useEffect(() => {
    // 切换条目时默认收起次要块，把高度留给正文/跟读
    setDetailInfoOpen(false);
    setDetailVideoOpen(false);
  }, [selectedId]);

  const scrollListToEntry = useCallback((id: number) => {
    setSelectedId(id);
    // 等选中态渲染后再滚，避免 sticky 顶栏高度未就绪
    window.requestAnimationFrame(() => {
      const pane = listPaneRef.current;
      const row = listItemRefs.current.get(id);
      if (!pane || !row) return;
      const sticky = pane.querySelector<HTMLElement>("[data-collection-sticky]");
      const offset = (sticky?.offsetHeight ?? 0) + 8;
      const top =
        pane.scrollTop +
        (row.getBoundingClientRect().top - pane.getBoundingClientRect().top) -
        offset;
      pane.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    });
  }, []);

  async function createDomain() {
    const name = domainName.trim();
    if (!name) {
      message.warning("请填写分类名称");
      return;
    }
    setDomainSaving(true);
    try {
      await api.createCategory({ name });
      setDomainModalOpen(false);
      setDomainName("");
      await refreshCategories();
      message.success("已创建分类");
    } catch (err) {
      message.error(formatError(err, "创建失败"));
    } finally {
      setDomainSaving(false);
    }
  }

  async function saveRename() {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) {
      message.warning("名称不能为空");
      return;
    }
    setDomainSaving(true);
    try {
      const updated = await api.updateCategory(renameTarget.id, { name });
      if (category === renameTarget.name) setCategory(updated.name);
      setRenameTarget(null);
      setRenameValue("");
      await refreshCategories();
      await refreshEntries();
      message.success("已重命名");
    } catch (err) {
      message.error(formatError(err, "重命名失败"));
    } finally {
      setDomainSaving(false);
    }
  }

  async function removeDomain(domain: CategoryItem) {
    try {
      await api.deleteCategory(domain.id);
      if (category === domain.name) setCategory("");
      await refreshCategories();
      await refreshEntries();
      message.success("已删除分类（条目上的自动标签不受影响）");
    } catch (err) {
      message.error(formatError(err, "删除失败"));
    }
  }

  async function saveEntryDomains(ids: number[]) {
    if (!detail) return;
    setEntryDomainIds(ids);
    setEntryDomainSaving(true);
    try {
      const updated = await api.setEntryCategories(detail.id, ids);
      setDetail(updated);
      setEntryDomainIds(updated.category_ids || []);
      await refreshCategories();
      await refreshEntries();
      message.success("已更新分类");
    } catch (err) {
      setEntryDomainIds(detail.category_ids || []);
      message.error(formatError(err, "更新分类失败"));
    } finally {
      setEntryDomainSaving(false);
    }
  }

  function resolveEntryDomainIds(entry: EntryListItem): number[] {
    if (entry.category_ids && entry.category_ids.length > 0) {
      return [...entry.category_ids];
    }
    const names = new Set(entry.categories || []);
    return domains.filter((d) => names.has(d.name)).map((d) => d.id);
  }

  async function assignEntryToDomain(entryId: number, domain: CategoryItem) {
    const entry = items.find((i) => i.id === entryId);
    if (!entry) return;
    const current = resolveEntryDomainIds(entry);
    if (current.includes(domain.id)) {
      message.info(`已在「${domain.name}」中`);
      return;
    }
    setAssigningEntry(true);
    try {
      const updated = await api.setEntryCategories(entryId, [...current, domain.id]);
      if (detail?.id === entryId) {
        setDetail(updated);
        setEntryDomainIds(updated.category_ids || []);
      }
      await refreshCategories();
      await refreshEntries();
      message.success(`已放入「${domain.name}」`);
    } catch (err) {
      message.error(formatError(err, "放入分类失败"));
    } finally {
      setAssigningEntry(false);
      setDraggingEntryId(null);
      setDropDomainId(null);
    }
  }

  const refreshEntries = useCallback(async () => {
    setLoading(true);
    try {
      // 非合集视图会把分集折叠成合集行，必须拉全量，否则只看到前 N 条里的合集
      const pageSize = 200;
      const first = await api.listEntries({
        q: search,
        category,
        kind,
        page: 1,
        page_size: pageSize,
      });
      const all = [...first.items];
      const total = first.total;
      let page = 1;
      while (all.length < total) {
        page += 1;
        if (page > 40) break;
        const next = await api.listEntries({
          q: search,
          category,
          kind,
          page,
          page_size: pageSize,
        });
        if (!next.items.length) break;
        all.push(...next.items);
        if (next.items.length < pageSize) break;
      }
      setItems(all);
      setTotal(total);
      setSelectedId((prev) => {
        if (all.length === 0) return null;
        if (prev != null && all.some((i) => i.id === prev)) return prev;
        return all[0].id;
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
      setEntryDomainIds([]);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    // 切换时先清掉旧详情，避免「看起来像卡住」且内容不对
    setDetail((prev) => (prev?.id === selectedId ? prev : null));
    setEntryDomainIds([]);
    void (async () => {
      try {
        const res = await api.getEntry(selectedId);
        if (!cancelled) {
          setDetail(res);
          setEntryDomainIds(res.category_ids || []);
        }
      } catch (err) {
        if (!cancelled) {
          setDetail(null);
          setEntryDomainIds([]);
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
      setBatchIds((prev) => prev.filter((x) => x !== id));
      setDetail(null);
      setPreviewOpen(false);
      await refreshCategories();
      await refreshEntries();
    } catch (err) {
      message.error(formatError(err, "删除失败"));
    }
  }

  function toggleBatchId(id: number, on: boolean) {
    setBatchIds((prev) => {
      if (on) return prev.includes(id) ? prev : [...prev, id];
      return prev.filter((x) => x !== id);
    });
  }

  function selectAllInCollection() {
    setBatchIds(items.map((i) => i.id));
  }

  async function onBatchAssignDomain(domain: CategoryItem) {
    if (!activeCollection || batchBusy) return;
    const selected = batchIds.length > 0;
    const scopeLabel = selected
      ? `所选 ${batchIds.length} 集`
      : `整部合集（${total} 集）`;
    modal.confirm({
      title: `归入「${domain.name}」？`,
      content: selected
        ? `将把${scopeLabel}追加到分类「${domain.name}」（已在该分类中的会跳过）。`
        : `未勾选分集时，将把${scopeLabel}全部追加到「${domain.name}」。已在该分类中的会跳过。`,
      okText: "归入分类",
      cancelText: "取消",
      onOk: async () => {
        await runBatchAssignDomain(domain, {
          entryIds: selected ? [...batchIds] : undefined,
          collectionTitle: selected ? undefined : activeCollection,
        });
      },
    });
  }

  async function runBatchAssignDomain(
    domain: CategoryItem,
    opts: { entryIds?: number[]; collectionTitle?: string },
  ) {
    if (batchBusy) return;
    setBatchBusy(true);
    try {
      const res = await api.batchAddDomain(
        opts.entryIds && opts.entryIds.length > 0
          ? { category_id: domain.id, entry_ids: opts.entryIds }
          : {
              category_id: domain.id,
              collection_title: opts.collectionTitle || "",
            },
      );
      await refreshCategories();
      await refreshEntries();
      if (detail) {
        const touch =
          opts.entryIds && opts.entryIds.length > 0
            ? opts.entryIds.includes(detail.id)
            : true;
        if (touch) {
          try {
            const fresh = await api.getEntry(detail.id);
            setDetail(fresh);
            setEntryDomainIds(fresh.category_ids || []);
          } catch {
            /* ignore */
          }
        }
      }
      message.success(
        res.updated > 0
          ? `已归入 ${res.updated} 集${res.skipped ? `，跳过 ${res.skipped} 集` : ""}`
          : res.skipped > 0
            ? `所选均已在「${domain.name}」中`
            : "没有可归入的条目",
      );
    } catch (err) {
      message.error(formatError(err, "归入分类失败"));
      throw err;
    } finally {
      setBatchBusy(false);
    }
  }

  async function onBatchDeleteSelected() {
    if (batchIds.length === 0 || batchBusy) return;
    modal.confirm({
      title: `删除所选 ${batchIds.length} 集？`,
      content: (
        <div className={styles.deleteConfirmBody}>
          <p className={styles.deleteConfirmLead}>将从知识库移除所选分集，不可恢复：</p>
          <ul className={styles.deleteConfirmPoints}>
            <li>知识库中的条目与检索切片</li>
            <li>喂养来源恢复为「可重新入库」（不删原文件）</li>
          </ul>
        </div>
      ),
      okText: "删除所选",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setBatchBusy(true);
        try {
          const ids = [...batchIds];
          const res = await api.batchDeleteEntries(ids);
          if (selectedId && ids.includes(selectedId)) {
            setSelectedId(null);
            setDetail(null);
            setPreviewOpen(false);
          }
          setBatchIds([]);
          await refreshCategories();
          await refreshEntries();
          message.success(
            res.removed > 0
              ? `已删除 ${res.removed} 集；来源可在喂养页重新入库`
              : "没有可删除的条目",
          );
        } catch (err) {
          message.error(formatError(err, "批量删除失败"));
          throw err;
        } finally {
          setBatchBusy(false);
        }
      },
    });
  }

  async function onDeleteWholeCollection() {
    if (!activeCollection || batchBusy) return;
    const count = total || items.length;
    modal.confirm({
      title: "删除整个合集？",
      content: (
        <div className={styles.deleteConfirmBody}>
          <p className={styles.deleteConfirmLead}>
            将删除「{activeCollection}」下全部 {count} 集已入库分集：
          </p>
          <ul className={styles.deleteConfirmPoints}>
            <li>知识库中的条目与检索切片</li>
            <li>喂养来源恢复为「可重新入库」（不删原文件）</li>
          </ul>
        </div>
      ),
      okText: "删除合集",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setBatchBusy(true);
        try {
          const title = activeCollection;
          const res = await api.deleteCollection(title);
          setSelectedId(null);
          setDetail(null);
          setPreviewOpen(false);
          setBatchIds([]);
          setCategory("");
          await refreshCategories();
          await refreshEntries();
          message.success(
            res.removed > 0
              ? `已删除合集（${res.removed} 集）；来源可在喂养页重新入库`
              : "合集已为空",
          );
        } catch (err) {
          message.error(formatError(err, "删除合集失败"));
          throw err;
        } finally {
          setBatchBusy(false);
        }
      },
    });
  }

  async function openPreview(entryId: number) {
    setPreviewLoading(true);
    setPreviewEntryId(entryId);
    const item = items.find((i) => i.id === entryId) ?? null;
    const current = detail?.id === entryId ? detail : null;
    setPreviewSourceId(current?.source_id ?? item?.source_id ?? null);
    setPreviewTitle(current?.title || item?.title || "正文预览");
    // 详情未加载时先拉一下，用于判断是否 PDF
    let resolved: EntryDetail | null = current;
    if (!resolved) {
      try {
        resolved = await api.getEntry(entryId);
      } catch {
        resolved = null;
      }
    }
    if (resolved) {
      setPreviewTitle(resolved.title || current?.title || item?.title || "正文预览");
      setPreviewSourceId(resolved.source_id ?? null);
    }
    const sourceId = resolved?.source_id ?? item?.source_id ?? null;
    if (isPdfEntry(resolved) && sourceId != null) {
      setPdfOpen(true);
      setPreviewOpen(false);
    } else {
      setPreviewOpen(true);
      setPdfOpen(false);
    }
    setPreviewLoading(false);
  }

  function closePreviews() {
    setPreviewOpen(false);
    setPdfOpen(false);
    setPreviewEntryId(null);
    setPreviewSourceId(null);
  }

  if (viewMode === "graph") {
    return (
      <section className={styles.page}>
        <header className={styles.header}>
          <div>
            <h1>
              <BookOutlined /> 知识浏览
            </h1>
            <Typography.Paragraph type="secondary" className={styles.subtitle}>
              知识关系图：笔记双链、书籍 / 视频 / 网页，以及分类标签都会出现在这里。
            </Typography.Paragraph>
          </div>
          <div className={styles.headerActions}>
            <div className={styles.kindTabs} role="tablist" aria-label="视图">
              <button
                type="button"
                className={`${styles.kindTab} ${styles.kindTabActive}`}
                onClick={() => setViewMode("graph")}
              >
                <ApartmentOutlined /> 图谱
              </button>
              <button type="button" className={styles.kindTab} onClick={() => setViewMode("list")}>
                <UnorderedListOutlined /> 列表
              </button>
            </div>
            <Button type="primary" icon={<FormOutlined />} onClick={() => navigate("/notes?new=1")}>
              写笔记
            </Button>
          </div>
        </header>
        <Suspense
          fallback={
            <div className={styles.page} style={{ padding: 48, color: "#64748b", fontSize: 14 }}>
              正在加载图谱…
            </div>
          }
        >
          <GraphView
            onOpenNode={(node) => {
              if (node.kind === "category") {
                setViewMode("list");
                setCategory(node.title);
                return;
              }
              if (node.kind === "note" && node.source_id) {
                navigate(`/notes?id=${node.source_id}`);
                return;
              }
              if (node.entry_id) {
                setViewMode("list");
                setKind("");
                setCategory("");
                setSelectedId(node.entry_id);
                return;
              }
              if (node.source_id) {
                setKind("");
                setCategory("");
                void selectEntryBySource(node.source_id);
                setViewMode("list");
              }
            }}
            onError={(msg) => message.error(msg)}
          />
        </Suspense>
      </section>
    );
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
            <div className={styles.kindTabs} role="tablist" aria-label="视图">
              <button type="button" className={styles.kindTab} onClick={() => setViewMode("graph")}>
                <ApartmentOutlined /> 图谱
              </button>
              <button
                type="button"
                className={`${styles.kindTab} ${styles.kindTabActive}`}
                onClick={() => setViewMode("list")}
              >
                <UnorderedListOutlined /> 列表
              </button>
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
    <>
      <Spin
        spinning={detailLoading || loading}
        fullscreen
        size="large"
        tip={detailLoading ? "加载知识点…" : "加载列表…"}
      />
    <section className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>
            <BookOutlined /> 知识浏览
          </h1>
          <p className={styles.subtitle}>共 {totalEntries} 条知识 · 当前列表 {total} 条</p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.kindTabs} role="tablist" aria-label="视图">
            <button type="button" className={styles.kindTab} onClick={() => setViewMode("graph")}>
              <ApartmentOutlined /> 图谱
            </button>
            <button
              type="button"
              className={`${styles.kindTab} ${styles.kindTabActive}`}
              onClick={() => setViewMode("list")}
            >
              <UnorderedListOutlined /> 列表
            </button>
          </div>
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
        <div className={styles.cats}>
          <div className={styles.catsRow}>
            <div className={styles.catScroll}>
              <div className={styles.catHead}>
                <span>分类</span>
              </div>
              <button
                type="button"
                className={`${styles.catItem}${
                  category === "" ? ` ${styles.catActive}` : ""
                }`}
                onClick={() => setCategory("")}
              >
                <span>全部</span>
                <em>{totalEntries}</em>
              </button>

              {domains.map((domain) => (
                <Dropdown
                  key={domain.id}
                  trigger={["contextMenu"]}
                  menu={{
                    items: [
                      {
                        key: "rename",
                        icon: <EditOutlined />,
                        label: "重命名",
                        onClick: () => {
                          setRenameTarget(domain);
                          setRenameValue(domain.name);
                        },
                      },
                      {
                        key: "delete",
                        icon: <DeleteOutlined />,
                        danger: true,
                        label: "删除分类",
                        onClick: () => {
                          Modal.confirm({
                            title: `删除「${domain.name}」？`,
                            content:
                              "删除后，已挂到该分类的条目会解除挂靠；自动标签不受影响。",
                            okText: "删除",
                            okType: "danger",
                            onOk: () => removeDomain(domain),
                          });
                        },
                      },
                    ],
                  }}
                >
                  <div
                    className={`${styles.domainRow}${
                      dropDomainId === domain.id ? ` ${styles.domainDropOver}` : ""
                    }`}
                    title="左键筛选 · 右键管理 · 可拖入条目或合集"
                    onDragOver={(e) => {
                      if (draggingEntryId == null && !draggingCollectionTitle) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                      setDropDomainId(domain.id);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDropDomainId((cur) => (cur === domain.id ? null : cur));
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const collectionTitle = (
                        e.dataTransfer.getData(COLLECTION_DND_MIME) ||
                        draggingCollectionTitle ||
                        ""
                      ).trim();
                      if (collectionTitle) {
                        void runBatchAssignDomain(domain, {
                          collectionTitle,
                        }).finally(() => {
                          setDropDomainId(null);
                          setDraggingCollectionTitle(null);
                          setDraggingEntryId(null);
                        });
                        return;
                      }
                      const raw =
                        e.dataTransfer.getData(ENTRY_DND_MIME) ||
                        e.dataTransfer.getData("text/plain");
                      const id = Number(raw || draggingEntryId);
                      if (Number.isFinite(id) && id > 0) {
                        void assignEntryToDomain(id, domain);
                      } else {
                        setDropDomainId(null);
                        setDraggingEntryId(null);
                        setDraggingCollectionTitle(null);
                      }
                    }}
                  >
                    <button
                      type="button"
                      className={`${styles.catItem} ${styles.domainItem}${
                        category === domain.name ? ` ${styles.catActive}` : ""
                      }`}
                      onClick={() => setCategory(domain.name)}
                    >
                      <span>
                        <FolderOutlined className={styles.catIcon} />
                        {domain.name}
                      </span>
                      <em>{domain.count}</em>
                    </button>
                  </div>
                </Dropdown>
              ))}

              {domains.length === 0 ? (
                <p className={styles.catHint}>
                  新建分类后，可把条目或合集拖到分类上。
                </p>
              ) : draggingCollectionTitle ? (
                <p className={styles.catHint}>松开即可将合集归入该分类</p>
              ) : draggingEntryId != null ? (
                <p className={styles.catHint}>拖到某个分类松开即可放入</p>
              ) : null}
            </div>

            <div className={styles.catActions}>
              <Button
                type="text"
                size="small"
                className={styles.catAdd}
                icon={<PlusOutlined />}
                onClick={() => {
                  setDomainName("");
                  setDomainModalOpen(true);
                }}
                title="新建分类"
              >
                新建
              </Button>
            </div>
          </div>

          {collections.length > 0 ? (
            <div
              className={`${styles.collectionsWrap} ${styles.collectionsWrapOpen}`}
              aria-hidden={false}
            >
              <div className={styles.collectionsWrapInner}>
                <div className={`${styles.catsRow} ${styles.collectionsRow}`}>
                  <div className={styles.catScroll}>
                    <div className={styles.catHead}>
                      <span>合集</span>
                    </div>
                    {collections.map((col) => {
                      const active = category === col.title;
                      const dragging = draggingCollectionTitle === col.title;
                      return (
                        <button
                          key={col.title}
                          type="button"
                          draggable={!batchBusy && !assigningEntry}
                          className={`${styles.catItem} ${styles.collectionItem}${
                            active ? ` ${styles.catActive}` : ""
                          }${dragging ? ` ${styles.collectionDragging}` : ""}`}
                          title={`${col.title}（${col.count} 集）· 点击查看 · 拖到上方分类可整部归入`}
                          onDragStart={(e) => {
                            collectionDragMovedRef.current = false;
                            setDraggingCollectionTitle(col.title);
                            e.dataTransfer.effectAllowed = "copy";
                            e.dataTransfer.setData(COLLECTION_DND_MIME, col.title);
                            e.dataTransfer.setData("text/plain", col.title);
                          }}
                          onDrag={() => {
                            collectionDragMovedRef.current = true;
                          }}
                          onDragEnd={() => {
                            setDraggingCollectionTitle(null);
                            setDropDomainId(null);
                          }}
                          onClick={() => {
                            if (collectionDragMovedRef.current) {
                              collectionDragMovedRef.current = false;
                              return;
                            }
                            setCategory(col.title);
                          }}
                        >
                          <span>
                            <FolderOutlined className={styles.catIcon} />
                            {col.title}
                          </span>
                          <em>{col.count}</em>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className={styles.listPane} ref={listPaneRef}>
          {activeCollection ? (
            <div className={styles.collectionPanel} data-collection-sticky>
              <div className={styles.collectionHead}>
                <div
                  className={`${styles.collectionTitleBlock}${
                    draggingCollectionTitle === activeCollection
                      ? ` ${styles.collectionDragging}`
                      : ""
                  }`}
                  draggable={!batchBusy && !assigningEntry}
                  title="拖到上方分类，可将整部合集归入"
                  onDragStart={(e) => {
                    collectionDragMovedRef.current = false;
                    setDraggingCollectionTitle(activeCollection);
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData(COLLECTION_DND_MIME, activeCollection);
                    e.dataTransfer.setData("text/plain", activeCollection);
                  }}
                  onDrag={() => {
                    collectionDragMovedRef.current = true;
                  }}
                  onDragEnd={() => {
                    setDraggingCollectionTitle(null);
                    setDropDomainId(null);
                  }}
                >
                  <FolderOutlined className={styles.collectionFolderIcon} />
                  <div className={styles.collectionTitleText}>
                    <strong title={activeCollection}>{activeCollection}</strong>
                    <em>{total} 集 · 可拖到分类</em>
                  </div>
                </div>
                <div className={styles.collectionBatchBar} role="group" aria-label="合集批量操作">
                  <button
                    type="button"
                    className={styles.collectionBatchLink}
                    disabled={batchBusy || items.length === 0}
                    onClick={selectAllInCollection}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    className={styles.collectionBatchLink}
                    disabled={batchBusy || batchIds.length === 0}
                    onClick={() => setBatchIds([])}
                  >
                    清空
                  </button>
                  <span className={styles.collectionBatchSep} aria-hidden />
                  <Dropdown
                    disabled={batchBusy || total === 0 || domains.length === 0}
                    menu={{
                      items:
                        domains.length === 0
                          ? [{ key: "empty", label: "请先新建分类", disabled: true }]
                          : domains.map((d) => ({
                              key: String(d.id),
                              label: d.name,
                              onClick: () => void onBatchAssignDomain(d),
                            })),
                    }}
                    trigger={["click"]}
                  >
                    <button
                      type="button"
                      className={styles.collectionBatchLink}
                      disabled={batchBusy || total === 0 || domains.length === 0}
                      title={
                        domains.length === 0
                          ? "请先在上方新建分类"
                          : batchIds.length > 0
                            ? `将所选 ${batchIds.length} 集归入分类`
                            : "将整部合集归入分类"
                      }
                    >
                      归入分类
                      {batchIds.length > 0 ? ` ${batchIds.length}` : "·全部"}
                      <DownOutlined style={{ fontSize: 10, marginLeft: 4 }} />
                    </button>
                  </Dropdown>
                  <span className={styles.collectionBatchSep} aria-hidden />
                  <button
                    type="button"
                    className={`${styles.collectionBatchLink} ${styles.collectionBatchDanger}`}
                    disabled={batchBusy || batchIds.length === 0}
                    title={
                      batchIds.length > 0
                        ? `删除所选 ${batchIds.length} 集`
                        : "删除所选"
                    }
                    onClick={() => void onBatchDeleteSelected()}
                  >
                    删所选{batchIds.length > 0 ? ` ${batchIds.length}` : ""}
                  </button>
                  <button
                    type="button"
                    className={`${styles.collectionBatchLink} ${styles.collectionBatchDanger}`}
                    disabled={batchBusy || total === 0}
                    title="删除整个合集"
                    onClick={() => void onDeleteWholeCollection()}
                  >
                    删合集
                  </button>
                </div>
              </div>
              {items.length > 0 ? (
                <div className={styles.episodeStrip} aria-label="合集分集快捷跳转">
                  {items.map((ep) => (
                    <button
                      key={ep.id}
                      type="button"
                      className={`${styles.episodeChip}${
                        selectedId === ep.id ? ` ${styles.episodeChipActive}` : ""
                      }`}
                      title={ep.title}
                      onClick={() => scrollListToEntry(ep.id)}
                    >
                      {ep.episode_no && ep.episode_no > 0
                        ? `P${ep.episode_no}`
                        : ep.title.slice(0, 8)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
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
              {listRows.map((row) => {
                if (row.kind === "collection") {
                  const dragging = draggingCollectionTitle === row.title;
                  return (
                    <li
                      key={`col:${row.title}`}
                      className={`${styles.listRow}${
                        dragging ? ` ${styles.listDragging}` : ""
                      }`}
                      draggable={!assigningEntry && !batchBusy}
                      onDragStart={(e) => {
                        collectionDragMovedRef.current = false;
                        setDraggingCollectionTitle(row.title);
                        e.dataTransfer.effectAllowed = "copy";
                        e.dataTransfer.setData(COLLECTION_DND_MIME, row.title);
                        e.dataTransfer.setData("text/plain", row.title);
                      }}
                      onDrag={() => {
                        collectionDragMovedRef.current = true;
                      }}
                      onDragEnd={() => {
                        setDraggingCollectionTitle(null);
                        setDropDomainId(null);
                      }}
                    >
                      <div className={styles.listCard}>
                        <button
                          type="button"
                          className={`${styles.listItem} ${styles.listCollectionItem}`}
                          title={`打开合集「${row.title}」`}
                          onClick={() => {
                            if (collectionDragMovedRef.current) {
                              collectionDragMovedRef.current = false;
                              return;
                            }
                            setCategory(row.title);
                          }}
                        >
                          <div
                            className={styles.listTitleRow}
                            title={row.title}
                          >
                            <FolderOutlined className={styles.listCollectionIcon} />
                            <strong>{row.title}</strong>
                          </div>
                          <p>
                            合集 · 本分类内 {row.count} 集
                            {row.maxEpisode > 0 ? `（至 P${row.maxEpisode}）` : ""}
                            · 点击查看全部分集
                          </p>
                          <div className={styles.listMeta}>
                            <Tag color="geekblue" icon={<FolderOutlined />}>
                              视频合集
                            </Tag>
                            <Tag>{row.count} 集</Tag>
                          </div>
                        </button>
                      </div>
                    </li>
                  );
                }

                const item = row.item;
                return (
                <li
                  key={item.id}
                  ref={(node) => {
                    if (node) listItemRefs.current.set(item.id, node);
                    else listItemRefs.current.delete(item.id);
                  }}
                  className={`${styles.listRow}${
                    draggingEntryId === item.id ? ` ${styles.listDragging}` : ""
                  }${activeCollection ? ` ${styles.listRowBatch}` : ""}`}
                  draggable={!assigningEntry && !batchBusy}
                  onDragStart={(e) => {
                    entryDragMovedRef.current = false;
                    setDraggingEntryId(item.id);
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData(ENTRY_DND_MIME, String(item.id));
                    e.dataTransfer.setData("text/plain", String(item.id));
                  }}
                  onDrag={(e) => {
                    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 0) {
                      entryDragMovedRef.current = true;
                    }
                  }}
                  onDragEnd={() => {
                    setDraggingEntryId(null);
                    setDropDomainId(null);
                  }}
                >
                  <div
                    className={`${styles.listCard}${
                      selectedId === item.id ? ` ${styles.listCardActive}` : ""
                    }${batchIds.includes(item.id) ? ` ${styles.listCardChecked}` : ""}`}
                  >
                  {activeCollection ? (
                    <label className={styles.listBatchCheckWrap}>
                      <Checkbox
                        checked={batchIds.includes(item.id)}
                        disabled={batchBusy}
                        onChange={(e) => toggleBatchId(item.id, e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className={`${styles.listItem}${
                      selectedId === item.id ? ` ${styles.listActive}` : ""
                    }`}
                    onClick={() => {
                      if (entryDragMovedRef.current) {
                        entryDragMovedRef.current = false;
                        return;
                      }
                      setSelectedId(item.id);
                    }}
                  >
                    <div
                      className={styles.listTitleRow}
                      title={item.title || `条目 #${item.id}`}
                    >
                      {item.episode_no && item.episode_no > 0 ? (
                        <span className={styles.listEpisodeBadge}>P{item.episode_no}</span>
                      ) : null}
                      <strong>{item.title || `条目 #${item.id}`}</strong>
                    </div>
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
                        const cats = visibleTags(item.categories || []);
                        // 合集名已在侧栏文件夹展示，列表里不再重复刷标签
                        const tagNames = (item.tags || []).filter(
                          (name) =>
                            name !== (item.collection_title || "") &&
                            !collectionTitleSet.has(name),
                        );
                        const tags = visibleTags(tagNames, 3);
                        return (
                          <>
                            {cats.shown.map((name) => (
                              <Tag key={`c-${name}`} color="processing" title={`分类：${name}`}>
                                {name}
                              </Tag>
                            ))}
                            {cats.more > 0 ? (
                              <span
                                className={styles.listMetaMore}
                                title={(item.categories || []).join("、")}
                              >
                                +{cats.more}
                              </span>
                            ) : null}
                            {item.collection_title && category !== item.collection_title ? (
                              <Tag
                                color="geekblue"
                                title="视频合集"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCategory(item.collection_title || "");
                                }}
                              >
                                {item.collection_title}
                              </Tag>
                            ) : null}
                            {tags.shown.map((name) => (
                              <Tag
                                key={`t-${name}`}
                                className={styles.listTagChip}
                                title={`标签：${name}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCategory(name);
                                }}
                              >
                                {name}
                              </Tag>
                            ))}
                            {tags.more > 0 ? (
                              <span
                                className={styles.listMetaMore}
                                title={tagNames.join("、")}
                              >
                                +{tags.more}
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
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </div>

        <aside
          className={`${styles.detail}${detailTall ? ` ${styles.detailTall}` : ""}`}
        >
          {!selectedId || (!detail && !detailLoading) ? (
            <div className={styles.detailEmpty}>
              <Empty description="选择左侧条目查看详情" />
            </div>
          ) : detailLoading && !detail ? (
            <div className={styles.detailEmpty}>
              <Spin tip="加载知识点…" />
            </div>
          ) : detail ? (
            <div className={styles.detailInner}>
              <div className={styles.detailHead}>
                <div className={styles.detailHeadTop}>
                  <h2 title={detail.title}>{detail.title}</h2>
                  <div className={styles.detailHeadToggles}>
                    <button
                      type="button"
                      className={styles.detailToggle}
                      onClick={() => setDetailInfoOpen((v) => !v)}
                      aria-expanded={detailInfoOpen}
                    >
                      {detailInfoOpen ? <UpOutlined /> : <DownOutlined />}
                      {detailInfoOpen ? "收起信息" : "分类标签"}
                    </button>
                    <button
                      type="button"
                      className={`${styles.detailToggle} ${styles.detailToggleWide}`}
                      onClick={() => setDetailTall((v) => !v)}
                      aria-expanded={detailTall}
                      title={detailTall ? "收起详情高度" : "加高详情区"}
                    >
                      {detailTall ? "收起高度" : "加高"}
                    </button>
                  </div>
                </div>
                {detailInfoOpen ? (
                  <div className={styles.detailExtras}>
                    <div className={styles.detailAssign}>
                      <label className={styles.detailAssignLabel}>分类</label>
                      <Select
                        mode="multiple"
                        allowClear
                        placeholder={
                          domains.length ? "选择要归入的分类" : "请先在左侧新建分类"
                        }
                        className={styles.detailDomainSelect}
                        value={entryDomainIds}
                        loading={entryDomainSaving}
                        disabled={domains.length === 0 || entryDomainSaving}
                        options={domains.map((d) => ({ value: d.id, label: d.name }))}
                        onChange={(ids) => void saveEntryDomains(ids)}
                        maxTagCount="responsive"
                      />
                    </div>
                    {(detail.tags || []).length > 0 ? (
                      <div className={styles.detailTags}>
                        <span className={styles.detailTagsLabel}>
                          <TagsOutlined /> 标签
                        </span>
                        {(detail.tags || []).map((name) => (
                          <Tag
                            key={name}
                            className={styles.listTagChip}
                            title={`按标签筛选：${name}`}
                            onClick={() => setCategory(name)}
                          >
                            {name}
                          </Tag>
                        ))}
                      </div>
                    ) : null}
                    <p className={styles.detailMeta}>
                      {detail.source_type
                        ? `类型：${sourceTypeLabel(detail.source_type)}`
                        : ""}
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
                ) : null}
              </div>

              <div className={styles.detailScroll}>
                {detail.source_type === "video_url" && detail.source_uri ? (
                  <div className={`${styles.detailSection} ${styles.detailSectionVideo}`}>
                    <button
                      type="button"
                      className={styles.sectionHeadToggle}
                      onClick={() => setDetailVideoOpen((v) => !v)}
                      aria-expanded={detailVideoOpen}
                    >
                      <h3>视频预览</h3>
                      <span>
                        {detailVideoOpen ? <UpOutlined /> : <DownOutlined />}
                        {detailVideoOpen ? "收起" : "展开"}
                      </span>
                    </button>
                    {detailVideoOpen ? (
                      <VideoPreviewPanel
                        title={detail.title}
                        url={detail.source_uri}
                        compact
                      />
                    ) : null}
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
                  {isPdfEntry(detail) ? "打开 PDF" : "预览正文"}
                </Button>
                <Link to="/chat">
                  <Button type="primary">在对话中提问</Button>
                </Link>
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      <PdfPreviewModal
        open={pdfOpen}
        title={previewTitle || detail?.title || "PDF 预览"}
        sourceId={previewSourceId}
        entryId={previewEntryId}
        onClose={closePreviews}
        onOpenTextPreview={() => {
          setPdfOpen(false);
          setPreviewOpen(true);
        }}
      />

      <TextPreviewModal
        open={previewOpen}
        title={previewTitle || detail?.title || "正文预览"}
        entryId={previewEntryId}
        sourceId={previewSourceId}
        onClose={closePreviews}
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

      <Modal
        title="新建分类"
        open={domainModalOpen}
        onCancel={() => {
          setDomainModalOpen(false);
          setDomainName("");
        }}
        onOk={() => void createDomain()}
        confirmLoading={domainSaving}
        okText="创建"
        destroyOnHidden
      >
        <Input
          autoFocus
          placeholder="例如：成长、工作、家庭"
          value={domainName}
          onChange={(e) => setDomainName(e.target.value)}
          onPressEnter={() => void createDomain()}
          maxLength={40}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          分类给人整理条目用；入库自动打的标签会单独显示，不受影响。
        </Typography.Paragraph>
      </Modal>

      <Modal
        title="重命名分类"
        open={renameTarget != null}
        onCancel={() => {
          setRenameTarget(null);
          setRenameValue("");
        }}
        onOk={() => void saveRename()}
        confirmLoading={domainSaving}
        okText="保存"
        destroyOnHidden
      >
        <Input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={() => void saveRename()}
          maxLength={40}
        />
      </Modal>
    </section>
    </>
  );
}
