import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  VideoCameraOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EyeOutlined,
  FileTextOutlined,
  FormOutlined,
  InboxOutlined,
  LinkOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  QuestionCircleOutlined,
  ReadOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Input,
  Modal,
  Progress,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  api,
  type OpenBookItem,
  type OpenBookSourceInfo,
  type SourceItem,
  type UrlProbeEpisode,
} from "@/shared/api/client";
import { getDesktopBridge } from "@/shared/desktop";
import { formatError } from "@/shared/ui/feedback";
import { PdfPreviewModal } from "@/shared/ui/PdfPreviewModal";
import { TextPreviewModal } from "@/shared/ui/TextPreviewModal";
import styles from "./FeedPage.module.css";

const CTEXT_SETTINGS_HREF = "/settings?keys=books";
const NEED_CTEXT_KEY = "NEED_CTEXT_KEY";

const ACTIVE = new Set(["pending", "extracting", "processing", "ingesting"]);
const DONE = new Set(["ready", "committed"]);
const FAILED = new Set(["failed", "need_transcript"]);

type QueueFilter = "all" | "active" | "done" | "failed";

const QUEUE_FILTER_KEY = "kongku-feed-queue-filter";
const PLAYLIST_MODE_KEY = "kongku-feed-playlist-mode";

function readQueueFilter(): QueueFilter {
  const raw = window.localStorage.getItem(QUEUE_FILTER_KEY);
  if (raw === "active" || raw === "done" || raw === "failed" || raw === "all") return raw;
  return "all";
}

type PlaylistProbe = {
  url: string;
  collectionTitle: string;
  total: number;
  entries: UrlProbeEpisode[];
};

function statusLabel(item: SourceItem): string {
  switch (item.status) {
    case "pending":
      return "等待中";
    case "extracting":
      if (item.stage === "asr") return "语音转写中…";
      if (item.stage === "extract_caption") return "拉取字幕中…";
      return "提取文案中…";
    case "processing":
      return "解析中…";
    case "ingesting":
      return "入库中…";
    case "ready":
      return "已抽取正文";
    case "committed":
      return "已入库";
    case "failed":
      return "失败";
    case "need_transcript":
      return "需补贴文案 / 转写";
    default:
      if (item.stage === "extract_or_ocr") return "抽取/OCR 识别中…";
      return item.status;
  }
}

export function FeedPage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [tab, setTab] = useState("upload");
  const [items, setItems] = useState<SourceItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [urlSubmitting, setUrlSubmitting] = useState(false);
  const [url, setUrl] = useState("");
  // 合集/分P 批量导入：默认关，仅导入单集；选择记忆在本地
  const [playlistMode, setPlaylistMode] = useState(
    () => window.localStorage.getItem(PLAYLIST_MODE_KEY) === "1",
  );
  const [playlistProbe, setPlaylistProbe] = useState<PlaylistProbe | null>(null);
  const [playlistSelected, setPlaylistSelected] = useState<number[]>([]);
  const [playlistBatching, setPlaylistBatching] = useState(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const [queueConcurrency, setQueueConcurrency] = useState(2);
  const [queueControlBusy, setQueueControlBusy] = useState(false);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>(() => readQueueFilter());
  const [ingestProgress, setIngestProgress] = useState<{
    total: number;
    done: number;
    ok: number;
    skipped: number;
    failed: number;
    current: string;
  } | null>(null);
  const [bannerOpen, setBannerOpen] = useState(true);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteContent, setPasteContent] = useState("");
  const [transcriptFor, setTranscriptFor] = useState<number | null>(null);
  const [transcriptText, setTranscriptText] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewSourceId, setPreviewSourceId] = useState<number | null>(null);
  const [ebookDragging, setEbookDragging] = useState(false);
  const [noteDragging, setNoteDragging] = useState(false);
  const [videoDragging, setVideoDragging] = useState(false);
  const [openQuery, setOpenQuery] = useState("");
  const [openResults, setOpenResults] = useState<OpenBookItem[]>([]);
  const [openSearching, setOpenSearching] = useState(false);
  const [openSearched, setOpenSearched] = useState(false);
  const [openSearchOpen, setOpenSearchOpen] = useState(false);
  const [openSources, setOpenSources] = useState<OpenBookSourceInfo[]>([]);
  const [openSource, setOpenSource] = useState("zh_open");
  const [openNotice, setOpenNotice] = useState("");
  const [directIngestEnabled, setDirectIngestEnabled] = useState(false);
  const [ctextConfigured, setCtextConfigured] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [savingAsId, setSavingAsId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [downloadMessage, setDownloadMessage] = useState("");
  const [douyinCookiesReady, setDouyinCookiesReady] = useState(false);
  const [bilibiliCookiesReady, setBilibiliCookiesReady] = useState(false);
  const [allowLocalAudio, setAllowLocalAudio] = useState(false);
  const ebookRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const ingestLockRef = useRef(false);
  const desktop = getDesktopBridge();

  const refresh = useCallback(async () => {
    try {
      const [res, control] = await Promise.all([
        api.listSources(),
        api.getQueueControl().catch(() => null),
      ]);
      setItems(res.items);
      if (control) {
        setQueuePaused(Boolean(control.paused));
        if (typeof control.concurrency === "number" && control.concurrency > 0) {
          setQueueConcurrency(control.concurrency);
        }
      }
    } catch (err) {
      message.error(formatError(err, "加载队列失败"));
    }
  }, [message]);

  async function onQueueStart() {
    if (queueControlBusy) return;
    setQueueControlBusy(true);
    try {
      const res = await api.startQueue();
      setQueuePaused(Boolean(res.paused));
      if (typeof res.concurrency === "number" && res.concurrency > 0) {
        setQueueConcurrency(res.concurrency);
      }
      await refresh();
      message.success(
        res.started > 0
          ? `已开始解析（调度 ${res.started} 项）`
          : "队列已在运行；暂无等待中的项",
      );
    } catch (err) {
      message.error(formatError(err, "开始队列失败"));
    } finally {
      setQueueControlBusy(false);
    }
  }

  async function onQueuePause() {
    if (queueControlBusy) return;
    setQueueControlBusy(true);
    try {
      const res = await api.pauseQueue();
      setQueuePaused(Boolean(res.paused));
      if (typeof res.concurrency === "number" && res.concurrency > 0) {
        setQueueConcurrency(res.concurrency);
      }
      message.info(
        res.running > 0
          ? `已暂停；当前 ${res.running} 项会跑完，其后不再开始`
          : "已暂停；新投递将等待开始后再解析",
      );
      await refresh();
    } catch (err) {
      message.error(formatError(err, "暂停队列失败"));
    } finally {
      setQueueControlBusy(false);
    }
  }

  async function onQueueToggle() {
    if (queueControlBusy) return;
    if (queuePaused) await onQueueStart();
    else await onQueuePause();
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!desktop?.getConfig) return;
    let cancelled = false;
    void desktop.getConfig().then((cfg) => {
      if (cancelled) return;
      setDouyinCookiesReady(Boolean(cfg.douyinCookiesReady ?? cfg.mediaCookiesReady));
      setBilibiliCookiesReady(Boolean(cfg.bilibiliCookiesReady));
    });
    const off = desktop.onMediaCookiesExported?.((info) => {
      if (typeof info.douyinLoggedIn === "boolean") {
        setDouyinCookiesReady(info.douyinLoggedIn);
      } else if (info.site === "douyin" || !info.site) {
        if (info.ok && info.loggedIn) setDouyinCookiesReady(true);
        else if (info.ok && info.loggedIn === false) setDouyinCookiesReady(false);
      }
      if (typeof info.bilibiliLoggedIn === "boolean") {
        setBilibiliCookiesReady(info.bilibiliLoggedIn);
      } else if (info.site === "bilibili") {
        if (info.ok && info.loggedIn) setBilibiliCookiesReady(true);
        else if (info.ok && info.loggedIn === false) setBilibiliCookiesReady(false);
      }
      if (info.ok && (info.loggedIn || info.douyinLoggedIn || info.bilibiliLoggedIn)) {
        const siteLabel =
          info.site === "bilibili" ? "B站" : info.site === "douyin" ? "抖音" : "平台";
        message.success(
          info.message ||
            (info.count
              ? `已保存${siteLabel}登录态（${info.count} 条 Cookie），可对失败项点「重试」`
              : `已保存${siteLabel}登录态，可对失败项点「重试」`),
        );
      } else if (info.ok && info.loggedIn === false) {
        message.warning(
          info.message ||
            (info.site === "bilibili"
              ? "未检测到 B站登录，请在弹窗内完成网页登录后再关闭"
              : "未检测到抖音登录，请在弹窗内完成网页登录后再关闭"),
        );
      } else if (info.message) {
        message.warning(info.message);
      }
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [desktop, message]);

  async function onLoginMedia(site: "douyin" | "bilibili") {
    if (!desktop?.loginMediaSite) {
      message.info(
        site === "bilibili"
          ? "请在桌面客户端使用「应用内登录B站」"
          : "请在桌面客户端使用「应用内登录抖音」",
      );
      return;
    }
    try {
      await desktop.loginMediaSite(site);
      message.info(
        site === "bilibili"
          ? "请在弹出窗口登录 B站，完成后关闭该窗口"
          : "请在弹出窗口登录抖音，完成后关闭该窗口",
      );
    } catch (err) {
      message.error(formatError(err, "打开登录窗口失败"));
    }
  }

  function mediaPlatformOf(uri: string): "douyin" | "bilibili" | "other" {
    const low = (uri || "").toLowerCase();
    if (low.includes("bilibili") || low.includes("b23.tv")) return "bilibili";
    if (low.includes("douyin") || low.includes("iesdouyin")) return "douyin";
    return "other";
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [s, sources, ai] = await Promise.all([
          api.getOpenBookSettings(),
          api.listOpenBookSources(),
          api.getAiSettings(),
        ]);
        if (cancelled) return;
        setDirectIngestEnabled(Boolean(s.open_ebook_direct_ingest));
        setCtextConfigured(Boolean(s.ctext_configured));
        setOpenSources(sources.items || []);
        if (sources.default_source) setOpenSource(sources.default_source);
        setAllowLocalAudio(Boolean(ai.allow_local_audio));
      } catch {
        /* 设置读取失败时保持默认 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const hasActive = items.some((i) => ACTIVE.has(i.status));
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [items, refresh]);

  async function withBusy(fn: () => Promise<void>, successText?: string) {
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (successText) message.success(successText);
    } catch (err) {
      message.error(formatError(err, "操作失败"));
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(file: File, type: "ebook" | "note" | "video") {
    await withBusy(async () => {
      await api.uploadSource(file, type);
    }, `已投递：${file.name}`);
  }

  function onDrop(e: DragEvent, type: "ebook" | "note" | "video") {
    e.preventDefault();
    if (type === "ebook") setEbookDragging(false);
    else if (type === "note") setNoteDragging(false);
    else setVideoDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void onUpload(file, type);
  }

  async function onPasteSubmit() {
    await withBusy(async () => {
      await api.pasteSource({ title: pasteTitle, content: pasteContent });
      setPasteOpen(false);
      setPasteTitle("");
      setPasteContent("");
    }, "笔记已投递");
  }

  function onPlaylistModeChange(checked: boolean) {
    setPlaylistMode(checked);
    window.localStorage.setItem(PLAYLIST_MODE_KEY, checked ? "1" : "0");
  }

  async function onUrlSubmit(e: FormEvent) {
    e.preventDefault();
    const raw = url.trim();
    if (!raw || urlSubmitting) return;
    setUrlSubmitting(true);
    setBusy(true);
    try {
      if (playlistMode) {
        // 合集模式：先探测，多集则弹选集确认
        const probe = await api.probeUrl(raw);
        if (probe.is_playlist && probe.total > 1) {
          const entries =
            probe.entries && probe.entries.length > 0
              ? probe.entries
              : Array.from({ length: probe.total }, (_, i) => ({
                  episode_no: i + 1,
                  title: "",
                }));
          setPlaylistProbe({
            url: raw,
            collectionTitle: probe.collection_title || "视频合集",
            total: probe.total,
            entries,
          });
          setPlaylistSelected([]);
          return;
        }
        // 非合集：退回单集流程
      }
      await api.urlSource(raw);
      setUrl("");
      await refresh();
      message.success("已识别链接并投递，后台自动提取文案");
    } catch (err) {
      message.error(formatError(err, "添加链接失败"));
    } finally {
      setUrlSubmitting(false);
      setBusy(false);
    }
  }

  async function onPlaylistBatch(opts?: { all?: boolean; episode_nos?: number[] }) {
    if (!playlistProbe || playlistBatching) return;
    const episodeNos = opts?.all
      ? undefined
      : (opts?.episode_nos ?? playlistSelected).filter((n) => n > 0);
    if (!opts?.all && (!episodeNos || episodeNos.length === 0)) {
      message.warning("请至少选择一集");
      return;
    }
    setPlaylistBatching(true);
    setBusy(true);
    try {
      const res = await api.urlBatch(
        playlistProbe.url,
        opts?.all ? { import_all: true } : { episode_nos: episodeNos },
      );
      setPlaylistProbe(null);
      setPlaylistSelected([]);
      setUrl("");
      await refresh();
      if (res.created === 0 && res.skipped > 0) {
        message.info(`这些分集都已在队列或已入库（跳过 ${res.skipped} 集），无需重复投递`);
      } else {
        message.success(
          `已投递 ${res.created} 集${res.skipped ? `（跳过已有 ${res.skipped} 集）` : ""}，后台逐集解析；完成后到队列「已抽取」入库`,
        );
      }
    } catch (err) {
      message.error(formatError(err, "合集投递失败"));
    } finally {
      setPlaylistBatching(false);
      setBusy(false);
    }
  }

  async function onOpenBookSearch() {
    const q = openQuery.trim();
    if (!q) {
      message.warning("请输入书名或作者");
      return;
    }
    setOpenSearching(true);
    setOpenSearched(true);
    try {
      const res = await api.searchOpenBooks(q, openSource);
      setOpenResults(res.items);
      setOpenNotice(res.notice || "");
      if (!res.items.length) message.info("未找到结果");
    } catch (err) {
      setOpenResults([]);
      message.error(formatError(err, "搜索失败"));
    } finally {
      setOpenSearching(false);
    }
  }

  async function onImportOpenBook(bookId: string, direct: boolean) {
    if (openSource === "ctext" && !ctextConfigured) {
      message.warning("请先配置 ctext API Key");
      navigate(CTEXT_SETTINGS_HREF);
      return;
    }
    if (direct && !directIngestEnabled) {
      message.warning("未开启「公版书直接入库」，请到设置 → 喂养中开启");
      return;
    }
    setImportingId(bookId);
    setDownloadProgress(2);
    setDownloadMessage("正在创建下载任务…");
    try {
      const job = await api.importOpenBook({
        source: openSource,
        book_id: bookId,
        direct_ingest: direct,
      });
      setDownloadProgress(job.progress || 5);
      setDownloadMessage(job.message || "下载中…");

      // 轮询进度
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => window.setTimeout(r, 500));
        const st = await api.getOpenBookJob(job.job_id);
        setDownloadProgress(st.progress || 0);
        setDownloadMessage(st.message || "");
        if (st.status === "done") {
          await refresh();
          message.success(st.message || (direct ? "下载完成并已入库" : "下载完成，已加入喂养队列"));
          setOpenSearchOpen(false);
          return;
        }
        if (st.status === "failed") {
          message.error(st.error || st.message || "下载失败");
          return;
        }
      }
      message.warning("下载超时，请稍后在喂养队列查看是否已完成");
      await refresh();
    } catch (err) {
      message.error(formatError(err, "下载失败"));
    } finally {
      setImportingId(null);
      setDownloadProgress(0);
      setDownloadMessage("");
    }
  }

  async function onSaveOpenBookAs(book: OpenBookItem) {
    if (openSource === "ctext" && !ctextConfigured) {
      message.warning("请先配置 ctext API Key");
      navigate(CTEXT_SETTINGS_HREF);
      return;
    }
    setSavingAsId(book.id);
    setDownloadMessage(`正在另存为「${book.title}」…`);
    try {
      const { blob, filename } = await api.saveOpenBookFile(
        openSource,
        book.id,
        book.title,
      );
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = filename || `${book.title}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      setDownloadMessage(`另存为成功：${filename}`);
      modal.success({
        title: "另存为成功",
        content: `文件已保存为「${filename}」。可在浏览器下载目录中查看。`,
        okText: "知道了",
      });
    } catch (err) {
      setDownloadMessage("");
      message.error(formatError(err, "另存为失败"));
    } finally {
      setSavingAsId(null);
      window.setTimeout(() => {
        setDownloadMessage((prev) => (prev.startsWith("另存为成功") ? "" : prev));
      }, 2500);
    }
  }

  const readyCount = items.filter((i) => i.status === "ready").length;
  const failedVideoCount = items.filter(
    (i) =>
      (i.type === "video_url" || i.type === "video_file") &&
      (i.status === "failed" || i.status === "need_transcript"),
  ).length;
  // 已入库的不再留在队列；历史页只看待入库 / 失败
  // 排序：进行中 → 等待 → 待入库 → 失败/待补贴
  const queueRank = (status: string) => {
    if (status === "extracting" || status === "processing" || status === "ingesting") return 0;
    if (status === "pending") return 1;
    if (status === "ready") return 2;
    if (status === "need_transcript" || status === "failed") return 3;
    return 4;
  };
  const queueBaseItems = (
    tab === "history"
      ? items.filter((i) => i.status === "ready" || i.status === "failed")
      : items.filter((i) => i.status !== "committed")
  )
    .slice()
    .sort((a, b) => {
      const d = queueRank(a.status) - queueRank(b.status);
      if (d !== 0) return d;
      const ta = a.updated_at || a.created_at || "";
      const tb = b.updated_at || b.created_at || "";
      return tb.localeCompare(ta);
    });
  const queueFilterCounts = {
    all: queueBaseItems.length,
    active: queueBaseItems.filter((i) => ACTIVE.has(i.status)).length,
    done: queueBaseItems.filter((i) => DONE.has(i.status)).length,
    failed: queueBaseItems.filter((i) => FAILED.has(i.status)).length,
  };
  const queueItems =
    queueFilter === "all"
      ? queueBaseItems
      : queueFilter === "active"
        ? queueBaseItems.filter((i) => ACTIVE.has(i.status))
        : queueFilter === "done"
          ? queueBaseItems.filter((i) => DONE.has(i.status))
          : queueBaseItems.filter((i) => FAILED.has(i.status));

  function changeQueueFilter(next: QueueFilter) {
    setQueueFilter(next);
    window.localStorage.setItem(QUEUE_FILTER_KEY, next);
  }

  async function openPreview(id: number) {
    const item = items.find((i) => i.id === id);
    setPreviewSourceId(id);
    setPreviewTitle(item?.title || item?.filename || `来源 #${id}`);
    const name = (item?.filename || item?.title || "").toLowerCase();
    if (item?.type === "ebook" && name.endsWith(".pdf")) {
      setPdfOpen(true);
      setPreviewOpen(false);
    } else {
      setPreviewOpen(true);
      setPdfOpen(false);
    }
  }

  function closePreviews() {
    setPreviewOpen(false);
    setPdfOpen(false);
    setPreviewSourceId(null);
  }

  async function ingestOne(id: number) {
    if (ingestLockRef.current || busy) return;
    ingestLockRef.current = true;
    setBusy(true);
    try {
      const res = await api.ingestSource(id);
      await refresh();
      const tags = (res.categories?.length ? res.categories : [res.category]).filter(Boolean);
      message.success(
        tags.length ? `已入库：${res.title}（${tags.join(" / ")}）` : `已入库：${res.title}`,
      );
    } catch (err) {
      message.error(formatError(err, "入库失败"));
    } finally {
      ingestLockRef.current = false;
      setBusy(false);
    }
  }

  function removeOne(item: SourceItem) {
    const name = item.title || item.filename || `#${item.id}`;
    modal.confirm({
      title: "移出喂养队列？",
      content: `将「${name}」移出队列。这只是清理队列展示，不会影响笔记库里的手写笔记；若已入库，知识条目也会保留。`,
      okText: "移出队列",
      okType: "default",
      cancelText: "取消",
      onOk: async () => {
        setBusy(true);
        try {
          await api.deleteSource(item.id);
          if (previewSourceId === item.id) {
            closePreviews();
          }
          await refresh();
          message.success("已移出队列");
        } catch (err) {
          message.error(formatError(err, "移出失败"));
          throw err;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function ingestAllReady() {
    if (ingestLockRef.current || busy) return;
    const readyItems = items.filter((i) => i.status === "ready");
    if (readyItems.length === 0) {
      message.info("没有可入库的 ready 来源");
      return;
    }
    ingestLockRef.current = true;
    setBusy(true);
    setIngestProgress({
      total: readyItems.length,
      done: 0,
      ok: 0,
      skipped: 0,
      failed: 0,
      current: readyItems[0]?.title || readyItems[0]?.filename || `#${readyItems[0]?.id}`,
    });
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let firstFailDetail = "";
    try {
      for (let i = 0; i < readyItems.length; i++) {
        const item = readyItems[i];
        const label = item.title || item.filename || `#${item.id}`;
        setIngestProgress({
          total: readyItems.length,
          done: i,
          ok,
          skipped,
          failed,
          current: label,
        });
        try {
          await api.ingestSource(item.id);
          ok += 1;
        } catch (err) {
          const detail = formatError(err, "入库失败");
          if (/重复|已入库|正在入库|409/.test(detail)) {
            skipped += 1;
          } else {
            failed += 1;
            if (!firstFailDetail) firstFailDetail = detail;
          }
        }
        setIngestProgress({
          total: readyItems.length,
          done: i + 1,
          ok,
          skipped,
          failed,
          current: label,
        });
      }
      await refresh();
      if (ok > 0) {
        const tip =
          skipped > 0 || failed > 0
            ? `已入库 ${ok} 条${skipped > 0 ? `，跳过重复 ${skipped} 条` : ""}${
                failed > 0 ? `，失败 ${failed} 条` : ""
              }`
            : `已入库 ${ok} 条`;
        message.success(tip);
        navigate("/knowledge");
      } else if (skipped > 0 && failed === 0) {
        message.warning(`全部为重复内容，已跳过 ${skipped} 条`);
      } else if (failed > 0) {
        message.error(firstFailDetail || "入库失败");
      } else {
        message.info("没有可入库的来源");
      }
    } finally {
      ingestLockRef.current = false;
      setBusy(false);
      setIngestProgress(null);
    }
  }

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>喂养知识</h1>
          <p className={styles.subtitle}>上传各类材料，让空库理解并成为你的知识。</p>
        </div>
        <a className={styles.howLink} href="#feed-help">
          <QuestionCircleOutlined /> 如何喂养知识
        </a>
      </header>

      <div className={styles.layout}>
        <div className={styles.main}>
          <Tabs
            activeKey={tab}
            onChange={setTab}
            className={styles.tabs}
            items={[
              { key: "upload", label: "上传材料" },
              { key: "import", label: "导入目录", disabled: true },
              { key: "history", label: "历史记录" },
            ]}
          />

          {tab === "upload" && (
            <div className={styles.stack}>
              {bannerOpen && (
                <Alert
                  className={styles.banner}
                  type="success"
                  showIcon
                  closable
                  onClose={() => setBannerOpen(false)}
                  message="可上传本地视频转写文案；链接类将尝试字幕/音轨转写"
                />
              )}

              {/* 电子书 — 对齐 02 / 02b */}
              <article className={styles.card}>
                <div className={styles.cardTitle}>
                  <ReadOutlined />
                  <div>
                    <h2>电子书</h2>
                    <p>支持 PDF、EPUB、TXT</p>
                  </div>
                </div>
                <div
                  className={`${styles.droppad} ${ebookDragging ? styles.droppadActive : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setEbookDragging(true);
                  }}
                  onDragLeave={() => setEbookDragging(false)}
                  onDrop={(e) => onDrop(e, "ebook")}
                  onClick={() => ebookRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") ebookRef.current?.click();
                  }}
                >
                  <CloudUploadOutlined className={styles.cloud} />
                  <strong>点击或拖拽文件到此处上传</strong>
                  <span>文件大小不超过 200MB</span>
                </div>
                <div className={styles.cardActions}>
                  <Button onClick={() => ebookRef.current?.click()} disabled={busy}>
                    选择文件
                  </Button>
                  <Button
                    onClick={() => {
                      setOpenSearchOpen(true);
                      void api.getOpenBookSettings().then((s) => {
                        setDirectIngestEnabled(Boolean(s.open_ebook_direct_ingest));
                        setCtextConfigured(Boolean(s.ctext_configured));
                      });
                    }}
                    disabled={busy}
                  >
                    搜索公版书
                  </Button>
                </div>
                <input
                  ref={ebookRef}
                  type="file"
                  accept=".pdf,.epub,.txt"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onUpload(f, "ebook");
                    e.target.value = "";
                  }}
                />
              </article>

              {/* 笔记 */}
              <article className={styles.card}>
                <div className={styles.cardTitle}>
                  <FileTextOutlined />
                  <div>
                    <h2>笔记与文档</h2>
                    <p>支持 Markdown、TXT，或直接粘贴</p>
                  </div>
                </div>
                <div
                  className={`${styles.droppad} ${noteDragging ? styles.droppadActive : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setNoteDragging(true);
                  }}
                  onDragLeave={() => setNoteDragging(false)}
                  onDrop={(e) => onDrop(e, "note")}
                  onClick={() => noteRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") noteRef.current?.click();
                  }}
                >
                  <CloudUploadOutlined className={styles.cloud} />
                  <strong>点击或拖拽文件到此处上传</strong>
                  <span>也可使用下方「写笔记」或快速粘贴</span>
                </div>
                <div className={styles.cardActions}>
                  <Button onClick={() => noteRef.current?.click()} disabled={busy}>
                    选择文件
                  </Button>
                  <Button
                    type="primary"
                    icon={<FormOutlined />}
                    onClick={() => navigate("/notes?new=1")}
                    disabled={busy}
                  >
                    写笔记
                  </Button>
                  <Button onClick={() => setPasteOpen(true)} disabled={busy}>
                    快速粘贴
                  </Button>
                </div>
                <input
                  ref={noteRef}
                  type="file"
                  accept=".md,.markdown,.txt"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onUpload(f, "note");
                    e.target.value = "";
                  }}
                />
              </article>

              {/* 本地视频/音频 → ffmpeg 抽轨 → 语音转写 */}
              <article className={styles.card}>
                <div className={styles.cardTitle}>
                  <VideoCameraOutlined />
                  <div>
                    <h2>视频 / 音频文件 · 转写文案</h2>
                    <p>本机已有文件时最稳：ffmpeg 抽音轨后语音转写（无需扒站）</p>
                  </div>
                </div>
                <div
                  className={`${styles.droppad} ${videoDragging ? styles.droppadActive : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setVideoDragging(true);
                  }}
                  onDragLeave={() => setVideoDragging(false)}
                  onDrop={(e) => onDrop(e, "video")}
                  onClick={() => videoRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") videoRef.current?.click();
                  }}
                >
                  <CloudUploadOutlined className={styles.cloud} />
                  <strong>点击或拖拽视频/音频到此处</strong>
                  <span>mp4 / mov / webm / m4a / mp3 / wav 等，不超过 200MB</span>
                </div>
                <div className={styles.cardActions}>
                  <Button onClick={() => videoRef.current?.click()} disabled={busy}>
                    选择文件
                  </Button>
                </div>
                <input
                  ref={videoRef}
                  type="file"
                  accept=".mp4,.webm,.mov,.mkv,.m4v,.m4a,.mp3,.wav,.aac,.ogg,.opus,video/*,audio/*"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onUpload(f, "video");
                    e.target.value = "";
                  }}
                />
              </article>

              {/* 链接 — 对齐 02 强调态 */}
              <article className={`${styles.card} ${styles.cardLink}`}>
                <div className={styles.cardTitle}>
                  <span className={styles.linkCircle}>
                    <LinkOutlined />
                  </span>
                  <div>
                    <h2>视频 / 网页链接 · 自动提取文案</h2>
                    <p>输入链接，空库将抓取字幕或网页正文</p>
                  </div>
                </div>
                <form className={styles.urlRow} onSubmit={onUrlSubmit}>
                  <Input
                    size="large"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="粘贴视频链接，或抖音 / B站「复制分享」整段文案"
                    required
                    disabled={urlSubmitting}
                  />
                  <Button
                    type="primary"
                    htmlType="submit"
                    size="large"
                    loading={urlSubmitting}
                    disabled={busy || urlSubmitting || !url.trim()}
                  >
                    {urlSubmitting ? "识别中…" : "添加链接"}
                  </Button>
                </form>
                <div style={{ marginTop: 8 }}>
                  <Space size={8}>
                    <Switch
                      size="small"
                      checked={playlistMode}
                      onChange={onPlaylistModeChange}
                      disabled={urlSubmitting}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      合集/分P：导入全部集数（关闭则仅导入第 1 集；课程、系列视频适用）
                    </Typography.Text>
                  </Space>
                </div>
                {urlSubmitting ? (
                  <p className={styles.urlLoading}>
                    正在解析链接并获取标题，视频站点可能需要几秒到十几秒，请稍候…
                  </p>
                ) : null}
                <div className={styles.mediaTipsRow}>
                  <Space size={6} wrap>
                    <Tooltip
                      title={
                        desktop?.loginMediaSite
                          ? douyinCookiesReady
                            ? "已保存抖音登录态，可抓取文案。点击可重新登录。"
                            : "抓取抖音前请先登录。弹出窗口登录网页版，关闭后可对失败项点「重试」。"
                          : "仅桌面安装包支持应用内登录。"
                      }
                    >
                      <Button
                        size="small"
                        type={douyinCookiesReady ? "default" : "primary"}
                        disabled={!desktop?.loginMediaSite}
                        onClick={() => void onLoginMedia("douyin")}
                      >
                        {douyinCookiesReady ? "抖音已登录" : "登录抖音"}
                      </Button>
                    </Tooltip>
                    <Tooltip
                      title={
                        desktop?.loginMediaSite
                          ? bilibiliCookiesReady
                            ? "已保存 B站登录态，可抓取字幕/音轨。点击可重新登录。"
                            : "B站匿名易 403，建议登录。合集批量时风控更严；登录后关闭窗口再「重试」。"
                          : "仅桌面安装包支持应用内登录。"
                      }
                    >
                      <Button
                        size="small"
                        type={bilibiliCookiesReady ? "default" : "primary"}
                        disabled={!desktop?.loginMediaSite}
                        onClick={() => void onLoginMedia("bilibili")}
                      >
                        {bilibiliCookiesReady ? "B站已登录" : "登录B站"}
                      </Button>
                    </Tooltip>
                    <Tooltip
                      title={
                        allowLocalAudio
                          ? "已授权下载音轨：无字幕时自动转写，并缓存供跟读。可在「设置 → 喂养 → 视频转写」关闭。"
                          : "默认不下载音轨。抖音多数无字幕、B站也可能没有；需转写/跟读时请到「设置 → 喂养 → 视频转写」开启授权。"
                      }
                    >
                      <Tag
                        color={allowLocalAudio ? "success" : "default"}
                        className={styles.mediaTipTag}
                      >
                        {allowLocalAudio ? "音轨已授权" : "音轨未授权"}
                        <QuestionCircleOutlined className={styles.mediaTipIcon} />
                      </Tag>
                    </Tooltip>
                  </Space>
                </div>
                <div className={styles.platforms}>
                  <Tag>YouTube</Tag>
                  <Tag>Bilibili</Tag>
                  <Tag>腾讯视频</Tag>
                  <Tag>抖音</Tag>
                </div>
                <p className={styles.urlHint}>
                  悬停按钮可看说明；也可在「设置 → 喂养 → 视频转写」管理登录与音轨授权。
                </p>
              </article>

              <p id="feed-help" className={styles.footNote}>
                自动提取可能耗时，可后台进行。当前完成正文抽取后进入队列「已抽取」状态。
              </p>
            </div>
          )}

          {tab === "history" && (
            <Alert
              type="info"
              showIcon
              message="历史记录"
              description="展示待入库或失败的投递。已成功入库的会离开队列，请到知识页查看。"
            />
          )}
        </div>

        <aside
          className={`${styles.queue}${queueBaseItems.length === 0 ? ` ${styles.queueEmptyPanel}` : ""}`}
        >
          <div className={styles.queueHead}>
            <div className={styles.queueHeadTitle}>
              <h2>
                解析队列 (
                {queueFilter === "all"
                  ? queueFilterCounts.all
                  : `${queueItems.length}/${queueFilterCounts.all}`}
                )
              </h2>
              <span
                className={`${styles.queueRunBadge}${
                  queuePaused ? ` ${styles.queueRunBadgePaused}` : ""
                }`}
              >
                {queuePaused
                  ? "已暂停"
                  : queueConcurrency > 1
                    ? `运行中 · ${queueConcurrency} 路`
                    : "运行中"}
              </span>
            </div>
            <div className={styles.queueRunControls}>
              <button
                type="button"
                className={`${styles.queueRunBtn}${
                  queuePaused ? ` ${styles.queueRunBtnPaused}` : ` ${styles.queueRunBtnActive}`
                }`}
                disabled={queueControlBusy}
                onClick={() => void onQueueToggle()}
                title={
                  queuePaused
                    ? "开始 / 继续解析等待中的项"
                    : "暂停：进行中的会跑完，其后不再开始"
                }
              >
                {queuePaused ? (
                  <>
                    <PlayCircleOutlined />
                    开始
                  </>
                ) : (
                  <>
                    <PauseCircleOutlined />
                    暂停
                  </>
                )}
              </button>
            </div>
          </div>

          <div className={styles.queueFilterTabs} role="tablist" aria-label="队列状态筛选">
            {(
              [
                { key: "all", label: "全部" },
                { key: "active", label: "未完成" },
                { key: "done", label: "已完成" },
                { key: "failed", label: "失败" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.key}
                type="button"
                role="tab"
                aria-selected={queueFilter === opt.key}
                className={`${styles.queueFilterTab}${
                  queueFilter === opt.key ? ` ${styles.queueFilterTabActive}` : ""
                }${
                  opt.key === "failed" && queueFilterCounts.failed > 0
                    ? ` ${styles.queueFilterTabFailed}`
                    : ""
                }`}
                onClick={() => changeQueueFilter(opt.key)}
              >
                {opt.label}
                <span className={styles.queueFilterCount}>{queueFilterCounts[opt.key]}</span>
              </button>
            ))}
          </div>

          {queueBaseItems.length === 0 ? (
            <div className={styles.queueEmpty}>
              <div className={styles.skeletonList} aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div key={i} className={styles.skeletonItem}>
                    <span className={styles.skeletonIcon} />
                    <span className={styles.skeletonText}>
                      <i />
                      <i />
                    </span>
                  </div>
                ))}
              </div>
              <div className={styles.emptyOverlay}>
                <div className={styles.emptyBadge}>
                  <InboxOutlined />
                </div>
                <strong>暂无解析任务</strong>
                <p>投递电子书、笔记或链接后，任务会出现在这里</p>
              </div>
            </div>
          ) : queueItems.length === 0 ? (
            <div className={styles.queueFilterEmpty}>
              <strong>
                {queueFilter === "active"
                  ? "没有未完成的任务"
                  : queueFilter === "done"
                    ? "没有已完成的任务"
                    : "没有失败的任务"}
              </strong>
              <p>可切换上方状态查看其它队列项</p>
            </div>
          ) : (
            <ul className={styles.queueList}>
              {queueItems.map((item) => (
                <li key={item.id} className={styles.queueItem}>
                  <div className={styles.queueTitle}>
                    <strong>{item.title || item.filename || `来源 #${item.id}`}</strong>
                    {item.book_kind === "confirmed" ? (
                      <Tag color="geekblue">
                        {item.provenance === "open_book" ? "确认书籍 · 书库" : "确认书籍"}
                      </Tag>
                    ) : item.book_kind === "possible" ? (
                      <Tag>可能为书籍</Tag>
                    ) : null}
                    {item.status === "committed" ? (
                      <Tag color="success">已入库</Tag>
                    ) : (item.type === "video_url" || item.type === "video_file" || item.status === "extracting") ? (
                      <Tag color="processing">自动转写</Tag>
                    ) : null}
                  </div>
                  <div className={styles.queueStatus}>{statusLabel(item)}</div>
                  {ACTIVE.has(item.status) && (
                    <Progress
                      percent={Math.round(Math.min(100, Math.max(0, item.progress)))}
                      size="small"
                      strokeColor="#2a6f6a"
                    />
                  )}
                  {item.error_message && (
                    <Typography.Text type="danger" className={styles.error}>
                      {item.error_message}
                    </Typography.Text>
                  )}
                  {item.status === "ready" && item.char_count > 0 && (
                    <Typography.Text type="secondary">约 {item.char_count} 字</Typography.Text>
                  )}
                  <Space size={8} wrap>
                    {(item.status === "ready" || item.status === "committed") &&
                      item.char_count > 0 && (
                      <Button
                        size="small"
                        icon={<EyeOutlined />}
                        loading={previewLoading && previewSourceId === item.id}
                        onClick={() => openPreview(item.id)}
                      >
                        预览
                      </Button>
                    )}
                    {item.status === "ready" && (
                      <Button
                        size="small"
                        type="primary"
                        disabled={busy}
                        onClick={() => void ingestOne(item.id)}
                      >
                        入库
                      </Button>
                    )}
                    {item.status === "committed" && (
                      <Link to="/knowledge">
                        <Button size="small">查看知识库</Button>
                      </Link>
                    )}
                    {(item.status === "failed" || item.status === "need_transcript") && (
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          void withBusy(async () => {
                            await api.retrySource(item.id);
                          }, "已重新排队")
                        }
                      >
                        重试
                      </Button>
                    )}
                    {item.status === "need_transcript" && (
                      <>
                        {mediaPlatformOf(item.source_uri) === "bilibili" ? (
                          <Button
                            size="small"
                            disabled={!desktop?.loginMediaSite}
                            onClick={() => void onLoginMedia("bilibili")}
                          >
                            登录B站后重试
                          </Button>
                        ) : mediaPlatformOf(item.source_uri) === "douyin" ? (
                          <Button
                            size="small"
                            disabled={!desktop?.loginMediaSite}
                            onClick={() => void onLoginMedia("douyin")}
                          >
                            登录抖音后重试
                          </Button>
                        ) : null}
                        <Button
                          size="small"
                          onClick={() => {
                            setTranscriptFor(item.id);
                            setTranscriptText("");
                          }}
                        >
                          补贴文案
                        </Button>
                      </>
                    )}
                    <Button
                      size="small"
                      icon={<DeleteOutlined />}
                      disabled={busy}
                      onClick={() => removeOne(item)}
                    >
                      移出队列
                    </Button>
                  </Space>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.queueActions}>
            {ingestProgress && (
              <div className={styles.ingestProgress} aria-live="polite">
                <div className={styles.ingestProgressHead}>
                  <strong>
                    入库中 {ingestProgress.done}/{ingestProgress.total}
                  </strong>
                  <span>
                    成功 {ingestProgress.ok}
                    {ingestProgress.skipped > 0 ? ` · 跳过 ${ingestProgress.skipped}` : ""}
                    {ingestProgress.failed > 0 ? ` · 失败 ${ingestProgress.failed}` : ""}
                  </span>
                </div>
                <Progress
                  percent={Math.round(
                    (ingestProgress.done / Math.max(1, ingestProgress.total)) * 100,
                  )}
                  size="small"
                  status="active"
                  strokeColor="#2a6f6a"
                />
                <p className={styles.ingestProgressCurrent} title={ingestProgress.current}>
                  正在处理：{ingestProgress.current}
                </p>
              </div>
            )}
            <Button
              type="primary"
              className={styles.queueIngestBtn}
              icon={<InboxOutlined />}
              block
              loading={Boolean(ingestProgress)}
              disabled={busy || readyCount === 0}
              onClick={() => void ingestAllReady()}
            >
              {ingestProgress
                ? `入库中 ${ingestProgress.done}/${ingestProgress.total}`
                : `入库知识库${readyCount > 0 ? ` · ${readyCount}` : ""}`}
            </Button>
            <div className={styles.queueTools} role="group" aria-label="队列清理">
              <button
                type="button"
                className={styles.queueTool}
                disabled={
                  busy ||
                  items.every((i) => ACTIVE.has(i.status) || i.status === "need_transcript")
                }
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      const res = await api.clearFinishedSources();
                      await refresh();
                      message.success(
                        res.removed > 0
                          ? `已移出 ${res.removed} 条（待入库/失败项；已入库内容仍在知识库）`
                          : "没有可移出的队列项",
                      );
                    } catch (err) {
                      message.error(formatError(err, "移出失败"));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                移出已完成
              </button>
              <button
                type="button"
                className={styles.queueTool}
                disabled={busy || failedVideoCount === 0}
                onClick={() =>
                  modal.confirm({
                    title: "清除失败的视频？",
                    content: `将移出 ${failedVideoCount} 条失败/待补贴的视频（含合集批量失败项）。进行中与已抽取待入库的不受影响。`,
                    okText: "清除失败视频",
                    okType: "danger",
                    cancelText: "取消",
                    onOk: async () => {
                      setBusy(true);
                      try {
                        const previewItem = items.find((i) => i.id === previewSourceId);
                        const res = await api.clearFailedVideoSources();
                        if (
                          previewItem &&
                          (previewItem.type === "video_url" ||
                            previewItem.type === "video_file") &&
                          (previewItem.status === "failed" ||
                            previewItem.status === "need_transcript")
                        ) {
                          closePreviews();
                        }
                        await refresh();
                        message.success(
                          res.removed > 0
                            ? `已移出 ${res.removed} 条失败视频`
                            : "没有可移出的失败视频",
                        );
                      } catch (err) {
                        message.error(formatError(err, "移出失败"));
                        throw err;
                      } finally {
                        setBusy(false);
                      }
                    },
                  })
                }
              >
                清失败{failedVideoCount > 0 ? ` ${failedVideoCount}` : ""}
              </button>
              <button
                type="button"
                className={`${styles.queueTool} ${styles.queueToolDanger}`}
                disabled={busy || queueBaseItems.length === 0}
                onClick={() =>
                  modal.confirm({
                    title: "清空整个喂养队列？",
                    content: `将移出当前队列中的 ${queueBaseItems.length} 条（含进行中、待入库、失败）。已入库的知识内容不受影响；进行中的任务会被中断。`,
                    okText: "清空全部",
                    okType: "danger",
                    cancelText: "取消",
                    onOk: async () => {
                      setBusy(true);
                      try {
                        closePreviews();
                        const res = await api.clearAllQueueSources();
                        await refresh();
                        message.success(
                          res.removed > 0
                            ? `已清空队列（移出 ${res.removed} 条）`
                            : "队列已是空的",
                        );
                      } catch (err) {
                        message.error(formatError(err, "清空队列失败"));
                        throw err;
                      } finally {
                        setBusy(false);
                      }
                    },
                  })
                }
              >
                清空全部
              </button>
            </div>
          </div>
          <p className={styles.queueFoot}>
            抽取完成后点「入库」；清理项仅移出队列，知识库已有内容保留
          </p>
        </aside>
      </div>

      <Modal
        title="检测到合集 / 分P 视频"
        open={playlistProbe !== null}
        onCancel={() => {
          if (playlistBatching) return;
          setPlaylistProbe(null);
          setPlaylistSelected([]);
        }}
        footer={null}
        width={560}
        destroyOnHidden
      >
        {playlistProbe ? (
          <div>
            <Typography.Paragraph>
              <Typography.Text strong>{playlistProbe.collectionTitle}</Typography.Text>
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              共 {playlistProbe.total} 集。勾选需要导入的分集；已投递过的会自动跳过。
            </Typography.Paragraph>
            <Space size="small" wrap style={{ marginBottom: 8 }}>
              <Button
                size="small"
                disabled={playlistBatching}
                onClick={() =>
                  setPlaylistSelected(playlistProbe.entries.map((e) => e.episode_no))
                }
              >
                全选
              </Button>
              <Button
                size="small"
                disabled={playlistBatching}
                onClick={() => setPlaylistSelected([])}
              >
                清空
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                已选 {playlistSelected.length} 集
              </Typography.Text>
            </Space>
            <div className={styles.playlistPicker}>
              <div className={styles.playlistCheckboxList}>
                {playlistProbe.entries.map((ep) => {
                  const checked = playlistSelected.includes(ep.episode_no);
                  return (
                    <Checkbox
                      key={ep.episode_no}
                      checked={checked}
                      disabled={playlistBatching}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setPlaylistSelected((prev) => {
                          if (on) {
                            return prev.includes(ep.episode_no)
                              ? prev
                              : [...prev, ep.episode_no].sort((a, b) => a - b);
                          }
                          return prev.filter((n) => n !== ep.episode_no);
                        });
                      }}
                    >
                      <span className={styles.playlistEpLabel}>
                        <span className={styles.playlistEpNo}>P{ep.episode_no}</span>
                        <span className={styles.playlistEpTitle}>
                          {ep.title || `第 ${ep.episode_no} 集`}
                        </span>
                      </span>
                    </Checkbox>
                  );
                })}
              </div>
            </div>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="无字幕的视频需要语音转写"
              description={
                <>
                  若该合集没有字幕，需先在 <Link to="/settings">设置 → AI</Link> 开启
                  「允许下载音轨到本机」，单集 30 分钟约需转写几分钟。
                </>
              }
            />
            <Space wrap>
              <Button
                type="primary"
                loading={playlistBatching}
                disabled={playlistSelected.length === 0}
                onClick={() => void onPlaylistBatch({ episode_nos: playlistSelected })}
              >
                导入所选（{playlistSelected.length}）
              </Button>
              <Button
                loading={playlistBatching}
                onClick={() => void onPlaylistBatch({ all: true })}
              >
                全部导入（{playlistProbe.total} 集）
              </Button>
              <Button
                disabled={playlistBatching}
                onClick={() => {
                  setPlaylistProbe(null);
                  setPlaylistSelected([]);
                }}
              >
                取消
              </Button>
            </Space>
          </div>
        ) : null}
      </Modal>

      <Modal
        title="搜索公版书"
        open={openSearchOpen}
        onCancel={() => setOpenSearchOpen(false)}
        footer={null}
        width={720}
        destroyOnHidden
      >
        <div className={styles.openBooks}>
          <Alert
            type="info"
            showIcon
            message="使用提示"
            description={
              openNotice || "切换上方书源后输入书名搜索；可加入喂养队列，或另存到本机。"
            }
          />
          <Tabs
            size="small"
            activeKey={openSource}
            onChange={(key) => {
              setOpenSource(key);
              setOpenResults([]);
              setOpenSearched(false);
              setOpenNotice(openSources.find((s) => s.id === key)?.description || "");
              if (key === "ctext") {
                void api.getOpenBookSettings().then((s) => {
                  setCtextConfigured(Boolean(s.ctext_configured));
                });
              }
            }}
            items={openSources.map((s) => ({
              key: s.id,
              label: s.name,
            }))}
          />
          <form
            className={styles.openSearchRow}
            onSubmit={(e) => {
              e.preventDefault();
              void onOpenBookSearch();
            }}
          >
            <Input
              value={openQuery}
              onChange={(e) => setOpenQuery(e.target.value)}
              placeholder={
                openSource === "gutenberg"
                  ? "输入书名或作者（英文效果更好）"
                  : openSource === "ctext"
                    ? "输入书名（繁简均可），如：紅樓夢、論語"
                    : "输入书名，如：红楼梦、道德经（简繁均可）"
              }
              allowClear
              disabled={openSearching || importingId != null || savingAsId != null}
              autoFocus
            />
            <Button
              type="primary"
              htmlType="submit"
              loading={openSearching}
              disabled={importingId != null || savingAsId != null || !openQuery.trim()}
            >
              搜索
            </Button>
          </form>
          {openSource === "ctext" && !ctextConfigured ? (
            <p className={styles.needKeyBanner}>
              下载需配置 Key，
              <Link to={CTEXT_SETTINGS_HREF} className={styles.needKeyLink}>
                前往设置
              </Link>
            </p>
          ) : null}
          {importingId || savingAsId ? (
            <div className={styles.openProgress}>
              {importingId ? (
                <Progress percent={downloadProgress} status="active" size="small" />
              ) : null}
              <p>{downloadMessage || (savingAsId ? "正在另存为…" : "下载中…")}</p>
            </div>
          ) : null}
          {openSearched && openResults.length === 0 ? (
            <p className={styles.openEmpty}>未找到结果，可换书源、换关键词，或改用本地上传。</p>
          ) : null}
          {openResults.length > 0 ? (
            <ul className={styles.openList}>
              {openResults.map((book) => {
                const canDownload = book.has_epub || book.has_text;
                const showSnippet =
                  Boolean(book.snippet) && book.snippet !== NEED_CTEXT_KEY;
                return (
                  <li key={`${book.source}-${book.id}`} className={styles.openItem}>
                    <div className={styles.openMeta}>
                      <strong>{book.title}</strong>
                      <span>
                        {book.authors.length ? book.authors.join(" / ") : "未知作者"}
                        {book.languages.length ? ` · ${book.languages.join(",")}` : ""}
                        {book.has_epub ? " · EPUB" : book.has_text ? " · TXT" : ""}
                        {showSnippet ? ` · ${book.snippet}` : null}
                      </span>
                    </div>
                    <Space wrap size={8}>
                      <Button
                        size="small"
                        type="primary"
                        loading={importingId === book.id}
                        disabled={!canDownload || importingId != null || savingAsId != null}
                        onClick={() => void onImportOpenBook(book.id, false)}
                      >
                        加入队列
                      </Button>
                      <Button
                        size="small"
                        loading={savingAsId === book.id}
                        disabled={!canDownload || importingId != null || savingAsId != null}
                        onClick={() => void onSaveOpenBookAs(book)}
                      >
                        另存为
                      </Button>
                      {directIngestEnabled ? (
                        <Button
                          size="small"
                          loading={importingId === book.id}
                          disabled={!canDownload || importingId != null || savingAsId != null}
                          onClick={() => void onImportOpenBook(book.id, true)}
                        >
                          直接入库
                        </Button>
                      ) : null}
                    </Space>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className={styles.openHint}>
            「加入队列」进入喂养；「另存为」保存到本机。
          </p>
        </div>
      </Modal>

      <Modal
        title="快速粘贴笔记"
        open={pasteOpen}
        onCancel={() => setPasteOpen(false)}
        okText="投递笔记"
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => {
          if (!pasteContent.trim()) {
            message.warning("请先粘贴内容");
            return Promise.reject();
          }
          return onPasteSubmit();
        }}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Input
            value={pasteTitle}
            onChange={(e) => setPasteTitle(e.target.value)}
            placeholder="标题（可空，默认取首行）"
          />
          <Input.TextArea
            value={pasteContent}
            onChange={(e) => setPasteContent(e.target.value)}
            placeholder="在此粘贴 Markdown / 纯文本…"
            rows={8}
          />
        </Space>
      </Modal>

      <Modal
        title="补贴文案"
        open={transcriptFor != null}
        onCancel={() => setTranscriptFor(null)}
        okText="提交"
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => {
          if (transcriptFor == null) return Promise.resolve();
          if (!transcriptText.trim()) {
            message.warning("请先粘贴文案");
            return Promise.reject();
          }
          const id = transcriptFor;
          return withBusy(async () => {
            await api.attachTranscript(id, transcriptText);
            setTranscriptFor(null);
            setTranscriptText("");
          }, "文案已提交");
        }}
        destroyOnHidden
      >
        <Input.TextArea
          value={transcriptText}
          onChange={(e) => setTranscriptText(e.target.value)}
          rows={10}
          placeholder="粘贴字幕或转写正文…"
        />
      </Modal>

      <PdfPreviewModal
        open={pdfOpen}
        title={previewTitle || "PDF 预览"}
        sourceId={previewSourceId}
        onClose={closePreviews}
        onOpenTextPreview={() => {
          setPdfOpen(false);
          setPreviewOpen(true);
        }}
      />

      <TextPreviewModal
        open={previewOpen}
        title={previewTitle || "正文预览"}
        sourceId={previewSourceId}
        onClose={closePreviews}
        loadSegment={async (offset, limit) => {
          if (previewSourceId == null) {
            return { text: "", char_count: 0, offset: 0, truncated: false };
          }
          setPreviewLoading(true);
          try {
            const res = await api.previewSource(previewSourceId, { offset, limit });
            setPreviewTitle(res.title || previewTitle);
            return {
              text: res.text,
              char_count: res.char_count,
              offset: res.offset,
              truncated: res.truncated,
            };
          } finally {
            setPreviewLoading(false);
          }
        }}
        searchAll={async (q, params) => {
          if (previewSourceId == null) return { total: 0, offset: 0, hits: [] };
          const res = await api.searchSourcePreview(previewSourceId, q, params);
          return { total: res.total, offset: res.offset, hits: res.hits };
        }}
      />
    </section>
  );
}
