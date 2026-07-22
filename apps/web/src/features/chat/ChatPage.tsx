import { useEffect, useRef, useState } from "react";
import {
  CommentOutlined,
  DeleteOutlined,
  PlusOutlined,
  SendOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { Alert, App, Button, Input, Popconfirm, Select, Space, Typography } from "antd";
import { Link } from "react-router-dom";
import {
  api,
  type CategoryItem,
  type ChatCitation,
  type ChatSession,
} from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import styles from "./ChatPage.module.css";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  refused?: boolean;
  citations?: ChatCitation[];
};

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
  const listRef = useRef<HTMLDivElement>(null);

  async function refreshSessions() {
    const res = await api.listChatSessions();
    setSessions(res.items || []);
    return res.items || [];
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
        setCategories(cats.items || []);
        setSessions(sess.items || []);
      } catch (err) {
        message.error(formatError(err, "加载对话配置失败"));
      }
    })();
  }, [message]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs, sending]);

  async function openSession(id: number | null) {
    setSessionId(id);
    if (id == null) {
      setMsgs([]);
      return;
    }
    setLoadingSession(true);
    try {
      const res = await api.listChatMessages(id);
      setMsgs(
        (res.items || []).map((m) => ({
          id: String(m.id),
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
          refused: m.refused,
          citations: m.citations || [],
        })),
      );
      const s = sessions.find((x) => x.id === id);
      if (s?.category_id != null) setCategoryId(s.category_id);
    } catch (err) {
      message.error(formatError(err, "加载会话失败"));
    } finally {
      setLoadingSession(false);
    }
  }

  async function newSession() {
    try {
      const s = await api.createChatSession({
        category_id: categoryId,
        title: "新对话",
      });
      await refreshSessions();
      setSessionId(s.id);
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

    const tempId = `tmp-${Date.now()}`;
    setMsgs((prev) => [...prev, { id: tempId, role: "user", content: text }]);
    setInput("");
    setSending(true);
    try {
      const res = await api.chat({
        message: text,
        category_id: categoryId,
        session_id: sessionId,
      });
      if (res.session_id != null) {
        setSessionId(res.session_id);
      }
      setMsgs((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: res.answer,
          refused: res.refused,
          citations: res.citations || [],
        },
      ]);
      await refreshSessions();
    } catch (err) {
      message.error(formatError(err, "发送失败"));
      setMsgs((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: formatError(err, "发送失败"),
          refused: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>
            <CommentOutlined /> 知识对话
          </h1>
          <Typography.Paragraph type="secondary" className={styles.subtitle}>
            只按库内作答；历史落库回看，问答仍按单轮检索（不额外耗 Token）。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <Select
            allowClear
            placeholder="全部分类"
            className={styles.categorySelect}
            value={categoryId ?? undefined}
            onChange={(v) => setCategoryId(v ?? null)}
            options={categories.map((c) => ({
              value: c.id,
              label: `${c.name}（${c.count}）`,
            }))}
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
              msgs.map((m) => (
                <div
                  key={m.id}
                  className={`${styles.bubbleRow} ${
                    m.role === "user" ? styles.rowUser : styles.rowAssistant
                  }`}
                >
                  <div
                    className={`${styles.bubble} ${
                      m.role === "user"
                        ? styles.bubbleUser
                        : m.refused
                          ? styles.bubbleRefuse
                          : styles.bubbleAssistant
                    }`}
                  >
                    <div className={styles.bubbleText}>{m.content}</div>
                    {m.role === "assistant" && m.citations && m.citations.length > 0 && (
                      <div className={styles.citations}>
                        {m.citations.map((c, i) => (
                          <Link
                            key={`${c.entry_id}-${i}`}
                            to={`/knowledge?entry=${c.entry_id}`}
                            className={styles.chip}
                            title={c.snippet}
                          >
                            <strong>{c.title || `条目 #${c.entry_id}`}</strong>
                            <span>{c.snippet}</span>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            {sending && (
              <div className={`${styles.bubbleRow} ${styles.rowAssistant}`}>
                <div className={`${styles.bubble} ${styles.bubbleAssistant} ${styles.typing}`}>
                  正在检索并作答…
                </div>
              </div>
            )}
          </div>

          <div className={styles.composer}>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={configured ? "输入与知识库相关的问题…" : "请先配置 API Key"}
              autoSize={{ minRows: 2, maxRows: 6 }}
              disabled={!configured || sending}
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
              loading={sending}
              disabled={!configured || !input.trim()}
              onClick={() => void send()}
            >
              发送
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
