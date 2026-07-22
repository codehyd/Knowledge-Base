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
import { api, type SourceItem } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { TextPreviewModal } from "@/shared/ui/TextPreviewModal";
import styles from "./FeedPage.module.css";

const ACTIVE = new Set(["pending", "extracting", "processing"]);

function statusLabel(item: SourceItem): string {
  switch (item.status) {
    case "pending":
      return "等待中";
    case "extracting":
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
      return "需补贴文案";
    default:
      if (item.stage === "extract_or_ocr") return "抽取/OCR 识别中…";
      return item.status;
  }
}

export function FeedPage() {
  const { message } = App.useApp();
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
  const ebookRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

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
    }, "链接已投递，后台自动提取文案");
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
                    placeholder="https://www.bilibili.com/video/… 或网页地址"
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
                <div className={styles.platforms}>
                  <Tag>YouTube</Tag>
                  <Tag>Bilibili</Tag>
                  <Tag>腾讯视频</Tag>
                  <Tag>抖音</Tag>
                </div>
                <p className={styles.urlHint}>支持视频字幕抓取与网页正文提取</p>
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
                      <Button
                        size="small"
                        onClick={() => {
                          setTranscriptFor(item.id);
                          setTranscriptText("");
                        }}
                      >
                        补贴文案
                      </Button>
                    )}
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
