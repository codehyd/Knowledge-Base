import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOutlined,
  CommentOutlined,
  DeleteOutlined,
  DownOutlined,
  PlusOutlined,
  RightOutlined,
  SendOutlined,
  SettingOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { Alert, App, Button, Input, Popconfirm, Select, Space, Typography } from "antd";
import { Link } from "react-router-dom";
import {
  api,
  type CategoryItem,
  type ChatCitation,
  type ChatMessageItem,
  type ChatSession,
} from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { MarkdownView } from "@/shared/ui/markdown";
import { TextPreviewModal } from "@/shared/ui/TextPreviewModal";
import styles from "./ChatPage.module.css";

const ACTIVE_SESSION_KEY = "kongku.chat.activeSessionId";
const POLL_MS = 450;

type TrustLevel = "ok" | "suspect" | "conflict";
type MsgStatus = "done" | "pending" | "error";

type ProgressStage = "accepted" | "retrieving" | "generating" | "citing" | string;

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  refused?: boolean;
  trust?: TrustLevel;
  trust_note?: string;
  status?: MsgStatus;
  progress?: ProgressStage;
  citations?: ChatCitation[];
};

const PROGRESS_STEPS: { key: ProgressStage; label: string }[] = [
  { key: "accepted", label: "受理提问" },
  { key: "retrieving", label: "检索知识库" },
  { key: "generating", label: "组织回答" },
  { key: "citing", label: "核对出处" },
];

function progressIndex(stage?: string | null): number {
  const i = PROGRESS_STEPS.findIndex((s) => s.key === stage);
  return i >= 0 ? i : 0;
}

function progressHintByIndex(idx: number): string {
  switch (PROGRESS_STEPS[Math.max(0, Math.min(idx, PROGRESS_STEPS.length - 1))]?.key) {
    case "retrieving":
      return "正在检索已入库资料…";
    case "generating":
      return "已命中资料，正在组织回答（含已启用技能）…";
    case "citing":
      return "回答已生成，正在核对出处…";
    case "accepted":
    default:
      return "已收到问题，准备检索…";
  }
}

/** 本地软进度：按等待时长推进，避免长时间停在第一步；服务端 progress 只会往前校正 */
function softProgressIndex(elapsedMs: number): number {
  if (elapsedMs >= 12_000) return 2; // 模型调用通常最久，停在「组织回答」
  if (elapsedMs >= 1_200) return 2;
  if (elapsedMs >= 400) return 1;
  return 0;
}

function normalizeTrust(value?: string | null): TrustLevel {
  if (value === "suspect" || value === "conflict") return value;
  return "ok";
}

function normalizeStatus(value?: string | null): MsgStatus {
  if (value === "pending" || value === "error") return value;
  return "done";
}

function mapMessages(items: ChatMessageItem[]): Msg[] {
  return (items || []).map((m) => ({
    id: String(m.id),
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content || "",
    refused: m.refused,
    trust: normalizeTrust(m.trust),
    trust_note: m.trust_note || "",
    status: normalizeStatus(m.status),
    progress: m.progress || "",
    citations: m.citations || [],
  }));
}

function hasPending(items: Msg[]) {
  return items.some((m) => m.role === "assistant" && m.status === "pending");
}

function citationFocusQuery(citation: ChatCitation): string {
  const preferred = (citation.highlight_query || "").trim();
  if (preferred) return preferred.slice(0, 60);
  return (citation.snippet || "")
    .replace(/…/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48)
    .trim();
}

function pointLabelOf(c: ChatCitation, index: number) {
  const label = (c.point_label || c.highlight_query || "").trim();
  if (label) return label.slice(0, 36);
  const snip = (c.snippet || "").replace(/\s+/g, " ").trim();
  if (snip) return snip.slice(0, 36) + (snip.length > 36 ? "…" : "");
  return `知识点 ${index + 1}`;
}

type CitationGroup = {
  entry_id: number;
  title: string;
  items: ChatCitation[];
};

function groupCitations(citations: ChatCitation[]): CitationGroup[] {
  const map = new Map<number, CitationGroup>();
  for (const c of citations) {
    const cur = map.get(c.entry_id);
    if (cur) {
      cur.items.push(c);
    } else {
      map.set(c.entry_id, {
        entry_id: c.entry_id,
        title: c.title || `条目 #${c.entry_id}`,
        items: [c],
      });
    }
  }
  return [...map.values()];
}

function readStoredSessionId(): number | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function storeSessionId(id: number | null) {
  try {
    if (id == null) sessionStorage.removeItem(ACTIVE_SESSION_KEY);
    else sessionStorage.setItem(ACTIVE_SESSION_KEY, String(id));
  } catch {
    /* ignore */
  }
}

function trustBanner(trust: TrustLevel, note?: string) {
  if (trust === "conflict") {
    return {
      title: "知识库材料明显有问题",
      detail:
        note?.trim() ||
        "命中的资料存在硬伤或彼此冲突，请勿当作正确答案。可点击下方引用来源去修正或删除。",
    };
  }
  if (trust === "suspect") {
    return {
      title: "依据来自知识库，但可信度存疑",
      detail:
        note?.trim() ||
        "模型对这段库内内容没有十足把握。请核对引用来源，必要时回喂养页修正。",
    };
  }
  return null;
}

function formatTime(value?: string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function CitationPanel({
  citations,
  onOpenPoint,
}: {
  citations: ChatCitation[];
  onOpenPoint: (c: ChatCitation) => void;
}) {
  const groups = useMemo(() => groupCitations(citations), [citations]);
  const [expandedMap, setExpandedMap] = useState<Record<number, boolean>>({});
  const scrollable = groups.length > 3;

  function isExpanded(g: CitationGroup) {
    if (g.items.length <= 1) return false;
    if (Object.prototype.hasOwnProperty.call(expandedMap, g.entry_id)) {
      return Boolean(expandedMap[g.entry_id]);
    }
    // 只有一本书时默认展开知识点
    return groups.length === 1;
  }

  function onBookClick(g: CitationGroup) {
    if (g.items.length === 1) {
      onOpenPoint(g.items[0]);
      return;
    }
    setExpandedMap((prev) => {
      const cur = Object.prototype.hasOwnProperty.call(prev, g.entry_id)
        ? Boolean(prev[g.entry_id])
        : groups.length === 1;
      return { ...prev, [g.entry_id]: !cur };
    });
  }

  return (
    <div className={styles.citations}>
      <div className={styles.citeHead}>出处 · 先选书，再看知识点</div>
      <div className={`${styles.citeGroups}${scrollable ? ` ${styles.citeGroupsScroll}` : ""}`}>
        {groups.map((g) => {
          const expanded = isExpanded(g);
          const multi = g.items.length > 1;
          return (
            <div key={g.entry_id} className={styles.citeGroup}>
              <button
                type="button"
                className={styles.citeBook}
                title={multi ? "展开本书知识点" : "查看原文定位"}
                onClick={() => onBookClick(g)}
              >
                <BookOutlined className={styles.citeBookIcon} />
                <span className={styles.citeBookBody}>
                  <strong>{g.title}</strong>
                  <em>
                    {g.items.length} 个知识点
                    {multi ? (expanded ? " · 点击收起" : " · 点击展开") : " · 点击查看"}
                  </em>
                </span>
                {multi ? (
                  expanded ? (
                    <DownOutlined className={styles.citeChevron} />
                  ) : (
                    <RightOutlined className={styles.citeChevron} />
                  )
                ) : null}
              </button>
              {expanded && (
                <div className={styles.citePoints}>
                  {g.items.map((c, i) => (
                    <button
                      key={`${c.entry_id}-${c.annotation_id ?? i}-${i}`}
                      type="button"
                      className={styles.citePoint}
                      title="跳到预高亮原文位置"
                      onClick={() => onOpenPoint(c)}
                    >
                      <strong>{pointLabelOf(c, i)}</strong>
                      <span>{c.snippet}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChatPage() {
  const { message } = App.useApp();
  const [configured, setConfigured] = useState(false);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewEntryId, setPreviewEntryId] = useState<number | null>(null);
  const [previewSourceId, setPreviewSourceId] = useState<number | null>(null);
  const [previewQuery, setPreviewQuery] = useState("");
  const [previewOffset, setPreviewOffset] = useState<number | null>(null);
  const [previewAnnId, setPreviewAnnId] = useState<number | null>(null);
  /** 等待中的展示用进度下标（本地软推进 + 服务端校正） */
  const [displayProgressIdx, setDisplayProgressIdx] = useState(0);
  const [waitElapsedSec, setWaitElapsedSec] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<number | null>(null);
  const pollTokenRef = useRef(0);
  const pendingSinceRef = useRef<number | null>(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    return () => {
      // 切走页面时停止轮询，避免卸载后 setState；回来会按 pending 重新同步
      pollTokenRef.current += 1;
      sessionIdRef.current = null;
    };
  }, []);

  async function refreshSessions() {
    const res = await api.listChatSessions();
    setSessions(res.items || []);
    return res.items || [];
  }

  async function loadMessages(id: number): Promise<Msg[]> {
    const res = await api.listChatMessages(id);
    const next = mapMessages(res.items || []);
    if (sessionIdRef.current === id) {
      setMsgs(next);
    }
    return next;
  }

  async function pollPending(id: number) {
    const token = ++pollTokenRef.current;
    setSending(true);
    try {
      for (;;) {
        if (pollTokenRef.current !== token || sessionIdRef.current !== id) return;
        const next = await loadMessages(id);
        if (pollTokenRef.current !== token || sessionIdRef.current !== id) return;
        if (!hasPending(next)) {
          await refreshSessions();
          // 出处精修可能在答案返回后短暂回写，再拉一次以免要点标签偏旧
          await sleep(1600);
          if (pollTokenRef.current !== token || sessionIdRef.current !== id) return;
          await loadMessages(id);
          return;
        }
        await sleep(POLL_MS);
      }
    } catch (err) {
      if (pollTokenRef.current === token) {
        message.error(formatError(err, "同步回答失败"));
      }
    } finally {
      if (pollTokenRef.current === token) {
        setSending(false);
      }
    }
  }

  async function openSession(id: number | null, opts?: { silent?: boolean }) {
    pollTokenRef.current += 1;
    setSending(false);
    setSessionId(id);
    storeSessionId(id);
    sessionIdRef.current = id;
    if (id == null) {
      setMsgs([]);
      return;
    }
    if (!opts?.silent) setLoadingSession(true);
    try {
      const next = await loadMessages(id);
      const list = await refreshSessions();
      const s = list.find((x) => x.id === id) || sessions.find((x) => x.id === id);
      if (s?.category_id != null) setCategoryId(s.category_id);
      if (hasPending(next)) {
        void pollPending(id);
      }
    } catch (err) {
      message.error(formatError(err, "加载会话失败"));
      setMsgs([]);
    } finally {
      setLoadingSession(false);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const [ai, cats, sess] = await Promise.all([
          api.getAiSettings(),
          api.listCategories(),
          api.listChatSessions(),
        ]);
        setConfigured(ai.configured);
        setCategories(
          (cats.items || []).filter((c) => (c.kind || "tag") === "domain"),
        );
        const list = sess.items || [];
        setSessions(list);

        const saved = readStoredSessionId();
        const preferred =
          saved != null && list.some((s) => s.id === saved)
            ? saved
            : list[0]?.id ?? null;
        if (preferred != null) {
          await openSession(preferred, { silent: true });
        }
      } catch (err) {
        message.error(formatError(err, "加载对话配置失败"));
      }
    })();
    // 仅挂载时恢复；openSession 稳定依赖由 ref 控制轮询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs, sending]);

  async function newSession() {
    try {
      pollTokenRef.current += 1;
      setSending(false);
      const s = await api.createChatSession({
        category_id: categoryId,
        title: "新对话",
      });
      await refreshSessions();
      setSessionId(s.id);
      storeSessionId(s.id);
      sessionIdRef.current = s.id;
      setMsgs([]);
    } catch (err) {
      message.error(formatError(err, "新建会话失败"));
    }
  }

  async function removeSession(id: number) {
    try {
      await api.deleteChatSession(id);
      const next = await refreshSessions();
      if (sessionId === id) {
        const first = next[0]?.id ?? null;
        await openSession(first);
      }
    } catch (err) {
      message.error(formatError(err, "删除会话失败"));
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    if (!configured) {
      message.warning("请先配置 API Key");
      return;
    }

    setInput("");
    setSending(true);
    pendingSinceRef.current = Date.now();
    setDisplayProgressIdx(0);
    // 本地先插入用户气泡 + pending 助手占位，立刻能看到动向
    const tempUserId = `tmp-u-${Date.now()}`;
    const tempAssistantId = `tmp-a-${Date.now()}`;
    setMsgs((prev) => [
      ...prev,
      { id: tempUserId, role: "user", content: text },
      {
        id: tempAssistantId,
        role: "assistant",
        content: "",
        status: "pending",
        progress: "accepted",
      },
    ]);

    try {
      const res = await api.chat({
        message: text,
        category_id: categoryId,
        session_id: sessionId,
      });
      const sid = res.session_id ?? sessionId;
      if (sid == null) {
        throw new Error("未返回会话 ID");
      }
      setSessionId(sid);
      storeSessionId(sid);
      sessionIdRef.current = sid;
      await refreshSessions();
      const next = await loadMessages(sid);
      if (hasPending(next) || res.status === "pending") {
        await pollPending(sid);
      } else {
        setSending(false);
      }
    } catch (err) {
      message.error(formatError(err, "发送失败"));
      setMsgs((prev) => [
        ...prev.filter((m) => m.id !== tempUserId && m.id !== tempAssistantId),
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: formatError(err, "发送失败"),
          refused: true,
          trust: "ok",
          status: "error",
        },
      ]);
      setSending(false);
    }
  }

  const waiting = sending || hasPending(msgs);
  const serverProgress = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (m.role === "assistant" && m.status === "pending") {
        return m.progress || "accepted";
      }
    }
    return sending ? "accepted" : "";
  }, [msgs, sending]);

  useEffect(() => {
    if (!waiting) {
      pendingSinceRef.current = null;
      setDisplayProgressIdx(0);
      setWaitElapsedSec(0);
      return;
    }
    if (pendingSinceRef.current == null) {
      pendingSinceRef.current = Date.now();
    }
    const tick = () => {
      const start = pendingSinceRef.current ?? Date.now();
      const elapsed = Date.now() - start;
      setWaitElapsedSec(Math.floor(elapsed / 1000));
      const soft = softProgressIndex(elapsed);
      const fromServer = progressIndex(serverProgress);
      // citing 只相信服务端，避免本地假推进到最后一步
      const next =
        serverProgress === "citing"
          ? 3
          : Math.max(soft, Math.min(fromServer, 2));
      setDisplayProgressIdx(next);
    };
    tick();
    const timer = window.setInterval(tick, 280);
    return () => window.clearInterval(timer);
  }, [waiting, serverProgress]);

  async function openCitation(c: ChatCitation) {
    const focus = citationFocusQuery(c);
    const offset =
      c.char_offset != null && Number.isFinite(c.char_offset) && c.char_offset >= 0
        ? Math.floor(c.char_offset)
        : null;
    const annId =
      c.annotation_id != null && Number.isFinite(c.annotation_id) && c.annotation_id > 0
        ? Math.floor(c.annotation_id)
        : null;
    try {
      const detail = await api.getEntry(c.entry_id);
      setPreviewTitle(detail.title || c.title || `条目 #${c.entry_id}`);
      setPreviewEntryId(c.entry_id);
      setPreviewSourceId(detail.source_id ?? null);
      setPreviewQuery(focus);
      setPreviewOffset(offset);
      setPreviewAnnId(annId);
      setPreviewOpen(true);
    } catch (err) {
      message.error(formatError(err, "打开引用失败"));
      setPreviewTitle(c.title || `条目 #${c.entry_id}`);
      setPreviewEntryId(c.entry_id);
      setPreviewSourceId(null);
      setPreviewQuery(focus);
      setPreviewOffset(offset);
      setPreviewAnnId(annId);
      setPreviewOpen(true);
    }
  }

  function closePreview() {
    setPreviewOpen(false);
    setPreviewEntryId(null);
    setPreviewSourceId(null);
    setPreviewQuery("");
    setPreviewOffset(null);
    setPreviewAnnId(null);
  }

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>
            <CommentOutlined /> 知识对话
          </h1>
          <Typography.Paragraph type="secondary" className={styles.subtitle}>
            只按库内作答；发送后可切到其他页面，回来会自动同步生成中的回答。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <Select
            allowClear
            placeholder="全部分类（人工）"
            className={styles.categorySelect}
            value={categoryId ?? undefined}
            onChange={(v) => setCategoryId(v ?? null)}
            options={categories.map((c) => ({
              value: c.id,
              label: `${c.name}（${c.count}）`,
            }))}
            notFoundContent="暂无分类，请先到知识页创建"
          />
          <Link to="/settings">
            <Button icon={<SettingOutlined />}>模型设置</Button>
          </Link>
        </Space>
      </header>

      {!configured && (
        <Alert
          className={styles.alert}
          type="warning"
          showIcon
          message="尚未配置 API Key"
          description={
            <span>
              对话需要先在 <Link to="/settings">设置</Link> 中填写 Key，才能检索并调用模型。
            </span>
          }
        />
      )}

      <div className={styles.workspace}>
        <aside className={styles.sessionPane}>
          <div className={styles.sessionHead}>
            <span>历史</span>
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => void newSession()}
              aria-label="新建会话"
            />
          </div>
          <ul className={styles.sessionList}>
            {sessions.length === 0 ? (
              <li className={styles.sessionEmpty}>暂无记录，发送即自动保存</li>
            ) : (
              sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`${styles.sessionItem}${
                      sessionId === s.id ? ` ${styles.sessionActive}` : ""
                    }`}
                    onClick={() => void openSession(s.id)}
                  >
                    <strong>{s.title || `会话 #${s.id}`}</strong>
                    <em>{formatTime(s.updated_at || s.created_at)}</em>
                  </button>
                  <Popconfirm
                    title="删除该会话？"
                    onConfirm={() => void removeSession(s.id)}
                  >
                    <button type="button" className={styles.sessionDel} aria-label="删除">
                      <DeleteOutlined />
                    </button>
                  </Popconfirm>
                </li>
              ))
            )}
          </ul>
        </aside>

        <div className={styles.panel}>
          <div className={styles.messages} ref={listRef}>
            {loadingSession ? (
              <div className={styles.empty}>
                <p>加载中…</p>
              </div>
            ) : msgs.length === 0 ? (
              <div className={styles.empty}>
                <p>先去喂养并入库材料，再来提问。</p>
                <p className={styles.emptyHint}>例如：「这本书里关于勇气是怎么说的？」</p>
                <Space>
                  <Link to="/feed">
                    <Button>去喂养</Button>
                  </Link>
                  <Link to="/knowledge">
                    <Button type="primary">看知识库</Button>
                  </Link>
                </Space>
              </div>
            ) : (
              msgs.map((m) => {
                const isPending = m.role === "assistant" && m.status === "pending";
                const trust = m.refused || isPending ? "ok" : normalizeTrust(m.trust);
                const banner =
                  m.role === "assistant" && !isPending
                    ? trustBanner(trust, m.trust_note)
                    : null;
                const bubbleClass =
                  m.role === "user"
                    ? styles.bubbleUser
                    : m.refused || m.status === "error"
                      ? styles.bubbleRefuse
                      : isPending
                        ? `${styles.bubbleAssistant} ${styles.typing}`
                        : trust === "conflict"
                          ? styles.bubbleConflict
                          : trust === "suspect"
                            ? styles.bubbleSuspect
                            : styles.bubbleAssistant;
                return (
                  <div
                    key={m.id}
                    className={`${styles.bubbleRow} ${
                      m.role === "user" ? styles.rowUser : styles.rowAssistant
                    }`}
                  >
                    <div className={`${styles.bubble} ${bubbleClass}`}>
                      {banner && (
                        <div
                          className={`${styles.trustBanner} ${
                            trust === "conflict"
                              ? styles.trustBannerConflict
                              : styles.trustBannerSuspect
                          }`}
                        >
                          <WarningOutlined />
                          <div>
                            <strong>{banner.title}</strong>
                            <p>{banner.detail}</p>
                          </div>
                        </div>
                      )}
                      <div
                        className={`${styles.bubbleText}${
                          m.role === "user" ? ` ${styles.bubbleTextPlain}` : ""
                        }`}
                      >
                        {isPending ? (
                          <div className={styles.progressBox}>
                            <div
                              key={`hint-${displayProgressIdx}`}
                              className={styles.progressHintWrap}
                            >
                              <p className={styles.progressHint}>
                                {progressHintByIndex(displayProgressIdx)}
                                {waitElapsedSec > 0 ? (
                                  <span className={styles.progressElapsed}>
                                    {" "}
                                    · 已等待 {waitElapsedSec}s
                                  </span>
                                ) : null}
                              </p>
                            </div>
                            <ol className={styles.progressSteps}>
                              {PROGRESS_STEPS.map((step, idx) => {
                                const cur = displayProgressIdx;
                                const state =
                                  idx < cur
                                    ? styles.stepDone
                                    : idx === cur
                                      ? styles.stepActive
                                      : styles.stepTodo;
                                return (
                                  <li
                                    key={step.key}
                                    className={`${styles.stepItem} ${state}`}
                                    style={{
                                      transitionDelay: `${idx * 40}ms`,
                                    }}
                                  >
                                    <span className={styles.stepDot} />
                                    <span>
                                      {step.label}
                                      {idx === cur ? (
                                        <span className={styles.stepDots} aria-hidden>
                                          …
                                        </span>
                                      ) : null}
                                    </span>
                                  </li>
                                );
                              })}
                            </ol>
                          </div>
                        ) : m.role === "assistant" ? (
                          <MarkdownView content={m.content} />
                        ) : (
                          m.content
                        )}
                      </div>
                      {m.role === "assistant" &&
                        !isPending &&
                        m.citations &&
                        m.citations.length > 0 && (
                          <CitationPanel
                            citations={m.citations}
                            onOpenPoint={(c) => void openCitation(c)}
                          />
                        )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className={styles.composer}>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                waiting
                  ? `${progressHintByIndex(displayProgressIdx)}（可先去其他页面）`
                  : configured
                    ? "输入与知识库相关的问题…"
                    : "请先配置 API Key"
              }
              autoSize={{ minRows: 2, maxRows: 6 }}
              disabled={!configured || waiting}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={waiting}
              disabled={!configured || !input.trim() || waiting}
              onClick={() => void send()}
            >
              发送
            </Button>
          </div>
        </div>
      </div>

      <TextPreviewModal
        open={previewOpen}
        title={previewTitle || "引用原文"}
        entryId={previewEntryId}
        sourceId={previewSourceId}
        initialQuery={previewQuery}
        initialOffset={previewOffset}
        initialAnnotationId={previewAnnId}
        onClose={closePreview}
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
            if (previewSourceId == null) throw err;
            const res = await api.previewSource(previewSourceId, { offset, limit });
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
            if (previewSourceId == null) throw err;
            const res = await api.searchSourcePreview(previewSourceId, q, params);
            return { total: res.total, offset: res.offset, hits: res.hits };
          }
        }}
      />
    </section>
  );
}
