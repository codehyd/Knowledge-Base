import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CloudUploadOutlined,
  DeleteOutlined,
  EyeOutlined,
  FileTextOutlined,
  InboxOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  QuestionCircleOutlined,
  ReadOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Input,
  Modal,
  Progress,
  Space,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { api, type OpenBookItem, type OpenBookSourceInfo, type SourceItem } from "@/shared/api/client";
import { getDesktopBridge } from "@/shared/desktop";
import { formatError } from "@/shared/ui/feedback";
import { TextPreviewModal } from "@/shared/ui/TextPreviewModal";
import styles from "./FeedPage.module.css";

const CTEXT_SETTINGS_HREF = "/settings?keys=books";
const NEED_CTEXT_KEY = "NEED_CTEXT_KEY";

const ACTIVE = new Set(["pending", "extracting", "processing"]);

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
  const [url, setUrl] = useState("");
  const [bannerOpen, setBannerOpen] = useState(true);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteContent, setPasteContent] = useState("");
  const [transcriptFor, setTranscriptFor] = useState<number | null>(null);
  const [transcriptText, setTranscriptText] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewSourceId, setPreviewSourceId] = useState<number | null>(null);
  const [ebookDragging, setEbookDragging] = useState(false);
  const [noteDragging, setNoteDragging] = useState(false);
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
  const [mediaCookiesReady, setMediaCookiesReady] = useState(false);
  const ebookRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const desktop = getDesktopBridge();

  const refresh = useCallback(async () => {
    try {
      const res = await api.listSources();
      setItems(res.items);
    } catch (err) {
      message.error(formatError(err, "加载队列失败"));
    }
  }, [message]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!desktop?.getConfig) return;
    let cancelled = false;
    void desktop.getConfig().then((cfg) => {
      if (!cancelled) setMediaCookiesReady(Boolean(cfg.mediaCookiesReady));
    });
    const off = desktop.onMediaCookiesExported?.((info) => {
      if (info.ok && info.loggedIn !== false) {
        setMediaCookiesReady(true);
        message.success(
          info.message ||
            (info.count
              ? `已保存登录态（${info.count} 条 Cookie），可对失败项点「重试」`
              : "已保存登录态，可对失败项点「重试」"),
        );
      } else if (info.ok && info.loggedIn === false) {
        setMediaCookiesReady(false);
        message.warning(
          info.message || "未检测到抖音登录，请在弹窗内完成网页登录后再关闭",
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

  async function onLoginDouyin() {
    if (!desktop?.loginMediaSite) {
      message.info("请在桌面客户端使用「应用内登录抖音」");
      return;
    }
    try {
      await desktop.loginMediaSite("douyin");
      message.info("请在弹出窗口登录抖音，完成后关闭该窗口");
    } catch (err) {
      message.error(formatError(err, "打开登录窗口失败"));
    }
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [s, sources] = await Promise.all([
          api.getOpenBookSettings(),
          api.listOpenBookSources(),
        ]);
        if (cancelled) return;
        setDirectIngestEnabled(Boolean(s.open_ebook_direct_ingest));
        setCtextConfigured(Boolean(s.ctext_configured));
        setOpenSources(sources.items || []);
        if (sources.default_source) setOpenSource(sources.default_source);
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

  async function onUpload(file: File, type: "ebook" | "note") {
    await withBusy(async () => {
      await api.uploadSource(file, type);
    }, `已投递：${file.name}`);
  }

  function onDrop(e: DragEvent, type: "ebook" | "note") {
    e.preventDefault();
    if (type === "ebook") setEbookDragging(false);
    else setNoteDragging(false);
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

  async function onUrlSubmit(e: FormEvent) {
    e.preventDefault();
    await withBusy(async () => {
      await api.urlSource(url.trim());
      setUrl("");
    }, "已识别链接并投递，后台自动提取文案");
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
  const queueItems =
    tab === "history"
      ? items.filter((i) => i.status === "ready" || i.status === "failed" || i.status === "committed")
      : items.filter((i) => i.status !== "committed");

  async function openPreview(id: number) {
    const item = items.find((i) => i.id === id);
    setPreviewSourceId(id);
    setPreviewTitle(item?.title || item?.filename || `来源 #${id}`);
    setPreviewOpen(true);
  }

  async function ingestOne(id: number) {
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
      setBusy(false);
    }
  }

  function removeOne(item: SourceItem) {
    const name = item.title || item.filename || `#${item.id}`;
    modal.confirm({
      title: "从队列中删除？",
      content: `将移除「${name}」。若已入库，知识库中的条目会保留。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setBusy(true);
        try {
          await api.deleteSource(item.id);
          if (previewSourceId === item.id) {
            setPreviewOpen(false);
            setPreviewSourceId(null);
          }
          await refresh();
          message.success("已从队列删除");
        } catch (err) {
          message.error(formatError(err, "删除失败"));
          throw err;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function ingestAllReady() {
    if (readyCount === 0) {
      message.info("没有可入库的 ready 来源");
      return;
    }
    setBusy(true);
    try {
      const res = await api.ingestReadySources();
      await refresh();
      const n = res.ingested.length;
      if (n > 0) {
        const tip =
          res.skipped > 0
            ? `已入库 ${n} 条，跳过重复 ${res.skipped} 条`
            : `已入库 ${n} 条`;
        message.success(tip);
        navigate("/knowledge");
      } else if (res.skipped > 0) {
        message.warning(`全部为重复内容，已跳过 ${res.skipped} 条`);
      } else if (res.failed.length) {
        message.error(res.failed[0]?.detail || "入库失败");
      } else {
        message.info("没有可入库的来源");
      }
    } catch (err) {
      message.error(formatError(err, "入库失败"));
    } finally {
      setBusy(false);
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
                  message="视频与链接可自动提取文案（字幕/语音转写），无需手贴文稿"
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
                  <span>也可使用下方「粘贴内容」</span>
                </div>
                <div className={styles.cardActions}>
                  <Button onClick={() => noteRef.current?.click()} disabled={busy}>
                    选择文件
                  </Button>
                  <Button onClick={() => setPasteOpen(true)} disabled={busy}>
                    粘贴内容
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
                    placeholder="粘贴视频链接，或抖音「复制分享」整段文案"
                    required
                  />
                  <Button
                    type="primary"
                    htmlType="submit"
                    size="large"
                    disabled={busy || !url.trim()}
                  >
                    添加链接
                  </Button>
                </form>
                <Space wrap style={{ marginTop: 10 }}>
                  <Button
                    size="middle"
                    disabled={!desktop?.loginMediaSite}
                    onClick={() => void onLoginDouyin()}
                  >
                    应用内登录抖音
                  </Button>
                  {mediaCookiesReady ? (
                    <Tag color="success">已保存应用内登录态</Tag>
                  ) : (
                    <Tag>未登录（抖音抓取可能失败）</Tag>
                  )}
                </Space>
                <div className={styles.platforms}>
                  <Tag>YouTube</Tag>
                  <Tag>Bilibili</Tag>
                  <Tag>腾讯视频</Tag>
                  <Tag>抖音</Tag>
                </div>
                <p className={styles.urlHint}>
                  请用「应用内登录抖音」完成网页登录。无字幕时会<strong>下载音轨做语音转写</strong>
                  （设置里默认「自动」：本地 Whisper，或单独配置硅基流动/OpenAI；对话用 DeepSeek
                  也没关系）。也可「补贴文案」。
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
              description="展示已完成或失败的投递。"
            />
          )}
        </div>

        <aside
          className={`${styles.queue}${queueItems.length === 0 ? ` ${styles.queueEmptyPanel}` : ""}`}
        >
          <div className={styles.queueHead}>
            <h2>解析队列 ({queueItems.length})</h2>
          </div>

          {queueItems.length === 0 ? (
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
                    ) : (item.type === "video_url" || item.status === "extracting") ? (
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
                        <Button
                          size="small"
                          disabled={!desktop?.loginMediaSite}
                          onClick={() => void onLoginDouyin()}
                        >
                          登录抖音后重试
                        </Button>
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
                      danger
                      icon={<DeleteOutlined />}
                      disabled={busy}
                      onClick={() => removeOne(item)}
                    >
                      删除
                    </Button>
                  </Space>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.queueActions}>
            <Button
              icon={<DeleteOutlined />}
              disabled={busy || items.every((i) => ACTIVE.has(i.status) || i.status === "need_transcript")}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    const res = await api.clearFinishedSources();
                    await refresh();
                    message.success(`已清空 ${res.removed} 条`);
                  } catch (err) {
                    message.error(formatError(err, "清空失败"));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              清空队列
            </Button>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              block
              disabled={busy || readyCount === 0}
              onClick={() => void ingestAllReady()}
            >
              入库知识库{readyCount > 0 ? ` (${readyCount})` : ""}
            </Button>
          </div>
          <p className={styles.queueFoot}>
            正文抽取完成后点「入库」，即可在知识页浏览
          </p>
        </aside>
      </div>

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
        title="粘贴笔记"
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

      <TextPreviewModal
        open={previewOpen}
        title={previewTitle || "正文预览"}
        sourceId={previewSourceId}
        onClose={() => {
          setPreviewOpen(false);
          setPreviewSourceId(null);
        }}
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
