import { useEffect, useMemo, useState } from "react";
import {
  ApiOutlined,
  DatabaseOutlined,
  DollarOutlined,
  InfoCircleOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  Radio,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useSearchParams } from "react-router-dom";
import { api, type ProviderOption } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import styles from "./SettingsPage.module.css";

function pickRecommended(models: { id: string; recommended?: boolean }[], fallback: string) {
  return models.find((m) => m.recommended)?.id ?? models[0]?.id ?? fallback;
}

type TestResult = {
  ok: boolean;
  latency_ms?: number;
  message: string;
  at: string;
};

export function SettingsPage() {
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [providerId, setProviderId] = useState("deepseek");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [chatModel, setChatModel] = useState("deepseek-v4-flash");
  const [embedModel, setEmbedModel] = useState("deepseek-v4-flash");
  const [customChat, setCustomChat] = useState(false);
  const [customEmbed, setCustomEmbed] = useState(false);
  const [masked, setMasked] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [subNav, setSubNav] = useState<"model" | "database" | "feed">("model");
  const [keyTab, setKeyTab] = useState<"ai" | "books">("ai");

  const [dbMode, setDbMode] = useState<"sqlite" | "postgres">("sqlite");
  const [sqlitePath, setSqlitePath] = useState("data/kongku.db");
  const [pgHost, setPgHost] = useState("");
  const [pgPort, setPgPort] = useState("5432");
  const [pgDatabase, setPgDatabase] = useState("");
  const [pgUsername, setPgUsername] = useState("");
  const [pgPassword, setPgPassword] = useState("");
  const [postgresConfigured, setPostgresConfigured] = useState(false);
  const [dbConnected, setDbConnected] = useState(false);
  const [dbSchemaReady, setDbSchemaReady] = useState(false);
  const [dbSchemaMessage, setDbSchemaMessage] = useState("");
  const [dbMissingTables, setDbMissingTables] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbSaving, setDbSaving] = useState(false);
  const [dbTesting, setDbTesting] = useState(false);
  const [dbInitializing, setDbInitializing] = useState(false);
  const [dbTestResult, setDbTestResult] = useState<TestResult | null>(null);
  /** Postgres 必须先测试成功才能保存；改字段后需重测 */
  const [dbTestPassed, setDbTestPassed] = useState(false);
  const [dbTestedKey, setDbTestedKey] = useState("");

  const [feedLoading, setFeedLoading] = useState(false);
  const [feedSaving, setFeedSaving] = useState(false);
  const [directIngest, setDirectIngest] = useState(false);
  const [feedDesc, setFeedDesc] = useState("");

  const [ctextKey, setCtextKey] = useState("");
  const [ctextMasked, setCtextMasked] = useState("");
  const [ctextConfigured, setCtextConfigured] = useState(false);
  const [ctextKeysUrl, setCtextKeysUrl] = useState("https://ctext.org/tools/subscribe");
  const [ctextDocsUrl, setCtextDocsUrl] = useState("https://ctext.org/tools/api");
  const [ctextHint, setCtextHint] = useState("");
  const [ctextSaving, setCtextSaving] = useState(false);
  const [mirrorRepo, setMirrorRepo] = useState("xp44mm/hanchuancaolu");
  const [mirrorRef, setMirrorRef] = useState("master");
  const [mirrorHint, setMirrorHint] = useState("");
  const [mirrorPresets, setMirrorPresets] = useState<
    { id: string; name: string; repo: string; ref: string; desc?: string }[]
  >([]);
  const [mirrorSaving, setMirrorSaving] = useState(false);

  const current = useMemo(
    () => providers.find((p) => p.id === providerId) ?? providers[0],
    [providers, providerId],
  );

  useEffect(() => {
    const keys = (searchParams.get("keys") || "").trim().toLowerCase();
    if (keys === "books" || keys === "ctext") {
      setSubNav("model");
      setKeyTab("books");
    } else if (keys === "ai" || keys === "model") {
      setSubNav("model");
      setKeyTab("ai");
    }
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const listRes = await api.getProviders();
        if (cancelled) return;
        setProviders(listRes.providers);

        try {
          const settings = await api.getAiSettings();
          if (cancelled) return;
          setProviderId(settings.provider || "deepseek");
          setBaseUrl(settings.base_url);
          setChatModel(settings.chat_model);
          setEmbedModel(settings.embed_model);
          setMasked(settings.api_key_masked);
          setConfigured(settings.configured);

          const p = listRes.providers.find((x) => x.id === settings.provider);
          if (p) {
            setCustomChat(!p.chat_models.some((m) => m.id === settings.chat_model));
            setCustomEmbed(!p.embed_models.some((m) => m.id === settings.embed_model));
          }
        } catch (err) {
          if (!cancelled) message.error(formatError(err, "读取已存配置失败"));
        }

        try {
          const feed = await api.getOpenBookSettings();
          if (cancelled) return;
          applyCtextSnapshot(feed);
        } catch {
          /* 书源 Key 可选，失败不挡主流程 */
        }
      } catch (err) {
        if (!cancelled) message.error(formatError(err, "加载服务商失败"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [message]);

  function applyCtextSnapshot(feed: Awaited<ReturnType<typeof api.getOpenBookSettings>>) {
    setCtextMasked(feed.ctext_api_key_masked || "");
    setCtextConfigured(Boolean(feed.ctext_configured));
    setCtextKeysUrl(feed.ctext_keys_url || "https://ctext.org/tools/subscribe");
    setCtextDocsUrl(feed.ctext_docs_url || "https://ctext.org/tools/api");
    setCtextHint(
      feed.ctext_hint ||
        "用于「中国哲书库」全文下载。Key 由机构订阅发放，可能过期；多数场景用「中文公版」即可。",
    );
    setMirrorRepo(feed.mirror_repo || "xp44mm/hanchuancaolu");
    setMirrorRef(feed.mirror_ref || "master");
    setMirrorHint(
      feed.mirror_hint ||
        "「中文公版」动态读取该仓库目录作为书目。一般选推荐即可。",
    );
    setMirrorPresets(feed.mirror_presets || []);
  }

  useEffect(() => {
    if (subNav !== "database") return;
    let cancelled = false;
    void (async () => {
      setDbLoading(true);
      try {
        const db = await api.getDbSettings();
        if (cancelled) return;
        applyDbSnapshot(db);
        setDbTestPassed(false);
        setDbTestedKey("");
        setDbTestResult(null);
      } catch (err) {
        if (!cancelled) message.error(formatError(err, "读取数据库配置失败"));
      } finally {
        if (!cancelled) setDbLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subNav, message]);

  function applyDbSnapshot(db: Awaited<ReturnType<typeof api.getDbSettings>>) {
    setDbMode(db.mode);
    setSqlitePath(db.sqlite_path || "kongku.db");
    setPostgresConfigured(db.postgres_configured);
    setPgHost(db.postgres_host || "");
    setPgPort(db.postgres_port || "5432");
    setPgDatabase(db.postgres_database || "");
    setPgUsername(db.postgres_username || "");
    setPgPassword("");
    setDbConnected(db.connected);
    setDbSchemaReady(Boolean(db.schema_ready));
    setDbSchemaMessage(db.schema_message || "");
    setDbMissingTables(db.missing_tables || []);
  }

  useEffect(() => {
    if (subNav !== "feed") return;
    let cancelled = false;
    void (async () => {
      setFeedLoading(true);
      try {
        const s = await api.getOpenBookSettings();
        if (cancelled) return;
        setDirectIngest(Boolean(s.open_ebook_direct_ingest));
        setFeedDesc(s.description || "");
        applyCtextSnapshot(s);
      } catch (err) {
        if (!cancelled) message.error(formatError(err, "读取喂养设置失败"));
      } finally {
        if (!cancelled) setFeedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subNav, message]);

  async function onSaveFeedSettings() {
    setFeedSaving(true);
    try {
      const s = await api.saveOpenBookSettings({
        open_ebook_direct_ingest: directIngest,
      });
      setDirectIngest(Boolean(s.open_ebook_direct_ingest));
      setFeedDesc(s.description || "");
      applyCtextSnapshot(s);
      message.success("喂养设置已保存");
    } catch (err) {
      message.error(formatError(err, "保存失败"));
    } finally {
      setFeedSaving(false);
    }
  }

  async function onSaveCtextKey() {
    if (!ctextKey.trim()) {
      message.info("请粘贴新 Key；若要删除已存 Key，请点「清除」");
      return;
    }
    setCtextSaving(true);
    try {
      const s = await api.saveOpenBookSettings({
        ctext_api_key: ctextKey.trim(),
      });
      applyCtextSnapshot(s);
      setCtextKey("");
      message.success("ctext Key 已保存");
    } catch (err) {
      message.error(formatError(err, "保存失败"));
    } finally {
      setCtextSaving(false);
    }
  }

  async function onClearCtextKey() {
    setCtextSaving(true);
    try {
      const s = await api.saveOpenBookSettings({ ctext_api_key: "" });
      applyCtextSnapshot(s);
      setCtextKey("");
      message.success("ctext Key 已清除");
    } catch (err) {
      message.error(formatError(err, "清除失败"));
    } finally {
      setCtextSaving(false);
    }
  }

  async function onSaveMirror() {
    setMirrorSaving(true);
    try {
      const s = await api.saveOpenBookSettings({
        mirror_repo: mirrorRepo.trim(),
        mirror_ref: mirrorRef.trim() || "master",
      });
      applyCtextSnapshot(s);
      message.success("镜像仓库已保存");
    } catch (err) {
      message.error(formatError(err, "保存失败"));
    } finally {
      setMirrorSaving(false);
    }
  }

  function onProviderChange(nextId: string) {
    setProviderId(nextId);
    const p = providers.find((x) => x.id === nextId);
    if (!p) return;
    if (p.base_url) setBaseUrl(p.base_url);
    const chat = pickRecommended(p.chat_models, chatModel);
    const embed = pickRecommended(p.embed_models, embedModel);
    setChatModel(chat === "custom" ? "" : chat);
    setEmbedModel(embed === "custom" ? "" : embed);
    setCustomChat(Boolean(p.allow_custom_model) && chat === "custom");
    setCustomEmbed(Boolean(p.allow_custom_model) && embed === "custom");
  }

  async function onSave() {
    setSaving(true);
    try {
      const data = await api.saveAiSettings({
        provider: providerId,
        base_url: baseUrl,
        api_key: apiKey || undefined,
        chat_model: chatModel,
        embed_model: embedModel,
      });
      setMasked(data.api_key_masked);
      setConfigured(data.configured);
      setApiKey("");
      message.success("已保存");
    } catch (err) {
      message.error(formatError(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    const hide = message.loading("测试中…（最多约 12 秒）", 0);
    try {
      const data = await api.testAiSettings();
      hide();
      const result: TestResult = {
        ok: data.ok,
        latency_ms: data.latency_ms,
        message: data.message,
        at: new Date().toLocaleString(),
      };
      setTestResult(result);
      if (data.ok) {
        message.success(
          `连接成功${data.latency_ms != null ? ` · ${data.latency_ms}ms` : ""}`,
        );
      } else {
        message.error(data.message || "连接失败");
      }
    } catch (err) {
      hide();
      message.error(formatError(err, "测试失败"));
      setTestResult({
        ok: false,
        message: formatError(err, "测试失败"),
        at: new Date().toLocaleString(),
      });
    } finally {
      setTesting(false);
    }
  }

  function postgresFormKey() {
    return [
      pgHost.trim(),
      pgPort.trim() || "5432",
      pgDatabase.trim(),
      pgUsername.trim(),
      pgPassword ? pgPassword : postgresConfigured ? "__saved_pwd__" : "",
    ].join("|");
  }

  function invalidateDbTest() {
    setDbTestPassed(false);
    setDbTestedKey("");
  }

  async function onDbTest() {
    if (dbMode === "postgres") {
      if (!pgHost.trim() || !pgDatabase.trim() || !pgUsername.trim()) {
        message.warning("请填写主机、数据库名和用户名");
        return;
      }
      if (!pgPassword && !postgresConfigured) {
        message.warning("请填写密码");
        return;
      }
    }
    setDbTesting(true);
    try {
      const data = await api.testDbSettings({
        mode: dbMode,
        sqlite_path: sqlitePath || "kongku.db",
        postgres_host: pgHost,
        postgres_port: pgPort || "5432",
        postgres_database: pgDatabase,
        postgres_username: pgUsername,
        postgres_password: pgPassword || undefined,
      });
      const result: TestResult = {
        ok: data.ok,
        message: data.message,
        at: new Date().toLocaleString(),
      };
      setDbTestResult(result);
      if (data.ok) {
        setDbTestPassed(true);
        setDbTestedKey(postgresFormKey());
        message.success("数据库连接成功");
      } else {
        invalidateDbTest();
        message.error(data.message || "连接失败");
      }
    } catch (err) {
      invalidateDbTest();
      message.error(formatError(err, "测试失败"));
      setDbTestResult({
        ok: false,
        message: formatError(err, "测试失败"),
        at: new Date().toLocaleString(),
      });
    } finally {
      setDbTesting(false);
    }
  }

  async function onDbSave() {
    if (dbMode === "postgres") {
      if (!dbTestPassed) {
        message.warning("请先测试连接成功后再保存");
        return;
      }
      if (dbTestedKey !== postgresFormKey()) {
        message.warning("连接信息已变更，请重新测试连接");
        return;
      }
    }
    setDbSaving(true);
    try {
      const db = await api.saveDbSettings({
        mode: dbMode,
        sqlite_path: sqlitePath || "kongku.db",
        postgres_host: pgHost,
        postgres_port: pgPort || "5432",
        postgres_database: pgDatabase,
        postgres_username: pgUsername,
        postgres_password: pgPassword || undefined,
      });
      applyDbSnapshot(db);
      if (dbMode === "postgres" && !db.schema_ready) {
        message.success("已切换到 Postgres，请点击「初始化表结构」完成建表");
      } else {
        message.success("已切换数据库，正在刷新…");
        window.setTimeout(() => {
          window.location.reload();
        }, 400);
        return;
      }
    } catch (err) {
      message.error(formatError(err, "切换失败"));
    } finally {
      setDbSaving(false);
    }
  }

  async function onDbInitSchema() {
    setDbInitializing(true);
    try {
      const result = await api.initDbSchema();
      const db = await api.getDbSettings();
      applyDbSnapshot(db);
      if (result.ok && result.schema_ready) {
        message.success(result.message || "表结构已初始化");
        window.setTimeout(() => {
          window.location.reload();
        }, 500);
      } else {
        message.error(result.message || "初始化未完成");
      }
    } catch (err) {
      message.error(formatError(err, "初始化失败"));
    } finally {
      setDbInitializing(false);
    }
  }

  function onDbModeChange(next: "sqlite" | "postgres") {
    setDbMode(next);
    invalidateDbTest();
    setDbTestResult(null);
  }

  const chatOptions = current?.chat_models ?? [];
  const embedOptions = current?.embed_models ?? [];

  return (
    <section className={styles.page}>
      <aside className={styles.subNav}>
        <h2>设置</h2>
        <button
          type="button"
          className={subNav === "model" ? styles.subActive : styles.subItem}
          onClick={() => setSubNav("model")}
        >
          <ApiOutlined /> 模型与 Key
        </button>
        <button
          type="button"
          className={subNav === "database" ? styles.subActive : styles.subItem}
          onClick={() => setSubNav("database")}
        >
          <DatabaseOutlined /> 数据库
        </button>
        <button
          type="button"
          className={subNav === "feed" ? styles.subActive : styles.subItem}
          onClick={() => setSubNav("feed")}
        >
          <ReadOutlined /> 喂养
        </button>
        <button type="button" className={styles.subItem} disabled>
          拒答规则
        </button>
        <button type="button" className={styles.subItem} disabled>
          备份导出
        </button>
        <button type="button" className={styles.subItem} disabled>
          关于
        </button>
      </aside>

      {subNav === "model" ? (
        <>
          <div className={styles.content}>
            <div className={styles.contentHead}>
              <div>
                <h1>模型与 Key</h1>
                <p className={styles.desc}>
                  按用途分类保存 API Key：大模型用于对话与入库；书源 Key 仅用于特定公版库全文下载。
                </p>
              </div>
              <Space size={8} wrap>
                <Tag color={configured ? "success" : "default"}>
                  AI {configured ? "已配置" : "未配置"}
                </Tag>
                <Tag color={ctextConfigured ? "success" : "default"}>
                  ctext {ctextConfigured ? "已配置" : "未配置"}
                </Tag>
              </Space>
            </div>

            {loading ? (
              <div className={styles.loading}>
                <Spin /> 正在加载服务商与配置…
              </div>
            ) : (
              <Tabs
                className={styles.keyTabs}
                activeKey={keyTab}
                onChange={(key) => {
                  const next = key as "ai" | "books";
                  setKeyTab(next);
                  setSearchParams(
                    (prev) => {
                      const p = new URLSearchParams(prev);
                      if (next === "books") p.set("keys", "books");
                      else p.delete("keys");
                      return p;
                    },
                    { replace: true },
                  );
                }}
                items={[
                  {
                    key: "ai",
                    label: `大模型（AI）${configured ? " · 已配置" : ""}`,
                    children: (
                      <Form layout="vertical" className={styles.form} onFinish={() => void onSave()}>
                        <p className={styles.tabHint}>
                          对话、AI 入库、向量检索等。Key 仅保存在本机。
                        </p>
                        <Form.Item label="服务商" required>
                          <Select
                            value={providerId}
                            onChange={onProviderChange}
                            options={providers.map((p) => ({ value: p.id, label: p.name }))}
                            placeholder="选择服务商"
                          />
                        </Form.Item>

                        <Form.Item
                          label="Base URL"
                          required
                          extra="API 基础地址，通常以 /v1 结尾。"
                        >
                          <Input
                            value={baseUrl}
                            onChange={(e) => setBaseUrl(e.target.value)}
                            readOnly={
                              current
                                ? !current.allow_custom_base_url && Boolean(current.base_url)
                                : false
                            }
                          />
                        </Form.Item>

                        <Form.Item
                          label={`API Key${masked ? `（当前 ${masked}）` : ""}`}
                          extra={
                            <span>
                              用于请求大模型 API。
                              {current?.keys_url || current?.docs_url ? (
                                <>
                                  {" "}
                                  <Typography.Link
                                    href={current.keys_url || current.docs_url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    获取 / 管理 Key
                                  </Typography.Link>
                                  {current?.docs_url && current?.keys_url ? (
                                    <>
                                      {" · "}
                                      <Typography.Link
                                        href={current.docs_url}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        文档
                                      </Typography.Link>
                                    </>
                                  ) : null}
                                </>
                              ) : (
                                " 请到服务商控制台申请。"
                              )}
                            </span>
                          }
                        >
                          <Input.Password
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder={masked ? "留空则保持原 Key" : "粘贴你的 Key"}
                            autoComplete="off"
                          />
                        </Form.Item>

                        <Form.Item
                          label="对话模型"
                          required
                          extra="用于对话（Chat Completion）的模型名称。"
                        >
                          {customChat ? (
                            <Space.Compact style={{ width: "100%" }}>
                              <Input
                                value={chatModel}
                                onChange={(e) => setChatModel(e.target.value)}
                                placeholder="例如 deepseek-v4-pro"
                              />
                              <Button
                                onClick={() => {
                                  setCustomChat(false);
                                  if (current) {
                                    setChatModel(
                                      pickRecommended(current.chat_models, "deepseek-v4-flash"),
                                    );
                                  }
                                }}
                              >
                                列表
                              </Button>
                            </Space.Compact>
                          ) : (
                            <Select
                              value={
                                chatOptions.some((m) => m.id === chatModel) ? chatModel : undefined
                              }
                              onChange={(v) => {
                                if (v === "__custom__") {
                                  setCustomChat(true);
                                  setChatModel("");
                                  return;
                                }
                                setChatModel(v);
                              }}
                              options={[
                                ...chatOptions.map((m) => ({
                                  value: m.id,
                                  label: `${m.label}${m.recommended ? "（推荐）" : ""}`,
                                })),
                                { value: "__custom__", label: "其它（手动输入）…" },
                              ]}
                            />
                          )}
                        </Form.Item>

                        <Form.Item
                          label="Embedding 模型"
                          required
                          extra="用于向量嵌入；留空则使用服务商默认（当前必选一项）。"
                        >
                          {customEmbed ? (
                            <Space.Compact style={{ width: "100%" }}>
                              <Input
                                value={embedModel}
                                onChange={(e) => setEmbedModel(e.target.value)}
                                placeholder="例如 text-embedding-3-small"
                              />
                              <Button
                                onClick={() => {
                                  setCustomEmbed(false);
                                  if (current) {
                                    setEmbedModel(
                                      pickRecommended(current.embed_models, "deepseek-v4-flash"),
                                    );
                                  }
                                }}
                              >
                                列表
                              </Button>
                            </Space.Compact>
                          ) : (
                            <Select
                              value={
                                embedOptions.some((m) => m.id === embedModel)
                                  ? embedModel
                                  : undefined
                              }
                              onChange={(v) => {
                                if (v === "__custom__") {
                                  setCustomEmbed(true);
                                  setEmbedModel("");
                                  return;
                                }
                                setEmbedModel(v);
                              }}
                              options={[
                                ...embedOptions.map((m) => ({
                                  value: m.id,
                                  label: `${m.label}${m.recommended ? "（推荐）" : ""}`,
                                })),
                                { value: "__custom__", label: "其它（手动输入）…" },
                              ]}
                            />
                          )}
                        </Form.Item>

                        <Space wrap>
                          <Button
                            type="primary"
                            htmlType="submit"
                            loading={saving}
                            disabled={testing}
                          >
                            保存 AI 配置
                          </Button>
                          <Button onClick={() => void onTest()} loading={testing} disabled={saving}>
                            测试连接
                          </Button>
                        </Space>

                        {testResult && (
                          <Alert
                            className={styles.testAlert}
                            type={testResult.ok ? "success" : "error"}
                            showIcon
                            message={testResult.ok ? "连接测试成功" : "连接测试失败"}
                            description={
                              <div>
                                <div>{testResult.message}</div>
                                {testResult.latency_ms != null && (
                                  <div>耗时：{testResult.latency_ms}ms</div>
                                )}
                                <div>模型：{chatModel}</div>
                                <div>时间：{testResult.at}</div>
                              </div>
                            }
                          />
                        )}
                      </Form>
                    ),
                  },
                  {
                    key: "books",
                    label: `公版书源${ctextConfigured ? " · ctext已配置" : ""}`,
                    children: (
                      <Form layout="vertical" className={styles.form}>
                        <p className={styles.tabHint}>
                          「中文公版」默认用推荐镜像动态搜书，一般不用改。ctext Key 仅中国哲书库需要。
                        </p>

                        <Form.Item label="中文公版 · 镜像仓库" extra={mirrorHint}>
                          <Space direction="vertical" style={{ width: "100%" }} size={10}>
                            {mirrorPresets.length > 0 ? (
                              <Select
                                value={
                                  mirrorPresets.some((p) => p.repo === mirrorRepo)
                                    ? mirrorRepo
                                    : "__custom__"
                                }
                                onChange={(v) => {
                                  if (v === "__custom__") return;
                                  const p = mirrorPresets.find((x) => x.repo === v);
                                  if (p) {
                                    setMirrorRepo(p.repo);
                                    setMirrorRef(p.ref || "master");
                                  }
                                }}
                                options={[
                                  ...mirrorPresets.map((p) => ({
                                    value: p.repo,
                                    label: p.name,
                                  })),
                                  { value: "__custom__", label: "自定义…" },
                                ]}
                              />
                            ) : null}
                            <Input
                              value={mirrorRepo}
                              onChange={(e) => setMirrorRepo(e.target.value)}
                              placeholder="owner/repo，例如 xp44mm/hanchuancaolu"
                            />
                            <Input
                              value={mirrorRef}
                              onChange={(e) => setMirrorRef(e.target.value)}
                              placeholder="分支，默认 master"
                              addonBefore="分支"
                            />
                            <Button
                              type="primary"
                              loading={mirrorSaving}
                              onClick={() => void onSaveMirror()}
                            >
                              保存镜像设置
                            </Button>
                          </Space>
                        </Form.Item>

                        <Form.Item
                          label={`ctext API Key${ctextMasked ? `（当前 ${ctextMasked}）` : ""}`}
                          extra={
                            <span>
                              {ctextHint}{" "}
                              <Typography.Link
                                href={ctextKeysUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                机构订阅 / 申请说明
                              </Typography.Link>
                              {" · "}
                              <Typography.Link
                                href={ctextDocsUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                API 文档
                              </Typography.Link>
                            </span>
                          }
                        >
                          <Input.Password
                            value={ctextKey}
                            onChange={(e) => setCtextKey(e.target.value)}
                            placeholder={
                              ctextMasked ? "粘贴新 Key 以覆盖" : "粘贴 ctext API Key（可选）"
                            }
                            autoComplete="off"
                          />
                        </Form.Item>
                        <Space wrap>
                          <Button
                            type="primary"
                            loading={ctextSaving}
                            onClick={() => void onSaveCtextKey()}
                          >
                            保存 ctext Key
                          </Button>
                          <Button
                            danger
                            disabled={!ctextConfigured && !ctextMasked}
                            loading={ctextSaving}
                            onClick={() => void onClearCtextKey()}
                          >
                            清除
                          </Button>
                        </Space>
                      </Form>
                    ),
                  },
                ]}
              />
            )}
          </div>

          <aside className={styles.tips}>
            <Card size="small" title={<><DollarOutlined /> 费用说明</>}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                大模型 Token 费用由你的服务商账户承担；ctext 为机构订阅制，个人通常无需配置。
              </Typography.Paragraph>
            </Card>
            <Card size="small" title={<><SafetyCertificateOutlined /> 安全提示</>}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Key 仅保存在本机；导出备份默认不包含 Key，避免泄露。
              </Typography.Paragraph>
            </Card>
            <Card size="small" title={<><InfoCircleOutlined /> 使用检查清单</>}>
              <ul className={styles.checklist}>
                <li>未配置 AI Key：对话 / AI 入库不可用</li>
                <li>未配置 Embedding：向量检索不可用</li>
                <li>未配置 ctext：不影响「中文公版」下载</li>
              </ul>
            </Card>
          </aside>
        </>
      ) : subNav === "database" ? (
        <>
          <div className={styles.content}>
            <div className={styles.contentHead}>
              <div>
                <h1>数据库</h1>
                <p className={styles.desc}>
                  个人版默认本地 SQLite（首次启动自动建表）。Postgres 需先保存连接，再手动初始化表结构；换库不会自动迁移数据。
                </p>
              </div>
              <Space size={8} wrap>
                <Tag color={dbConnected ? "success" : "warning"}>
                  {dbConnected ? "已连接" : "未连接"}
                </Tag>
                <Tag color={dbSchemaReady ? "success" : "warning"}>
                  {dbSchemaReady ? "表结构就绪" : "表结构未就绪"}
                </Tag>
              </Space>
            </div>

            {dbLoading ? (
              <div className={styles.loading}>
                <Spin /> 正在加载数据库配置…
              </div>
            ) : (
              <Form layout="vertical" className={styles.form} onFinish={() => void onDbSave()}>
                <Form.Item label="模式" required>
                  <Radio.Group
                    value={dbMode}
                    onChange={(e) => onDbModeChange(e.target.value)}
                    optionType="button"
                    buttonStyle="solid"
                    options={[
                      { value: "sqlite", label: "本地 SQLite（推荐）" },
                      { value: "postgres", label: "自备 Postgres（高级）" },
                    ]}
                  />
                </Form.Item>

                {dbMode === "sqlite" ? (
                  <Form.Item
                    label="本地数据库"
                    extra="由应用自动管理；首次启动会自动创建表并写入默认配置。"
                  >
                    <Input value={sqlitePath || "kongku.db"} readOnly disabled />
                  </Form.Item>
                ) : (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 16 }}
                      message="需要你自己提供的 Postgres 连接信息"
                      description="先测试并保存连接，再点击「初始化表结构」创建业务表。不会自动迁移本地库数据。"
                    />
                    <Form.Item label="主机地址" required>
                      <Input
                        value={pgHost}
                        onChange={(e) => {
                          setPgHost(e.target.value);
                          invalidateDbTest();
                        }}
                        placeholder="请输入 Postgres 主机地址"
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item label="端口" required>
                      <Input
                        value={pgPort}
                        onChange={(e) => {
                          setPgPort(e.target.value);
                          invalidateDbTest();
                        }}
                        placeholder="请输入 Postgres 端口"
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item label="数据库名称" required>
                      <Input
                        value={pgDatabase}
                        onChange={(e) => {
                          setPgDatabase(e.target.value);
                          invalidateDbTest();
                        }}
                        placeholder="请输入 Postgres 数据库名称"
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item label="用户名" required>
                      <Input
                        value={pgUsername}
                        onChange={(e) => {
                          setPgUsername(e.target.value);
                          invalidateDbTest();
                        }}
                        placeholder="请输入 Postgres 用户名"
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item
                      label="密码"
                      required={!postgresConfigured}
                      extra={
                        postgresConfigured
                          ? "已保存过密码；留空则保持原密码，修改任意项后需重新测试。"
                          : undefined
                      }
                    >
                      <Input.Password
                        value={pgPassword}
                        onChange={(e) => {
                          setPgPassword(e.target.value);
                          invalidateDbTest();
                        }}
                        placeholder={
                          postgresConfigured ? "留空则保持原密码" : "请输入 Postgres 密码"
                        }
                        autoComplete="new-password"
                      />
                    </Form.Item>
                  </>
                )}

                {!dbSchemaReady && dbConnected ? (
                  <Alert
                    style={{ marginBottom: 12 }}
                    type="warning"
                    showIcon
                    message="表结构未就绪"
                    description={
                      dbMissingTables.length
                        ? `缺少表：${dbMissingTables.join("、")}。${dbSchemaMessage}`
                        : dbSchemaMessage || "请点击下方「初始化表结构」。"
                    }
                  />
                ) : null}

                <Space wrap>
                  {dbMode === "postgres" ? (
                    <>
                      <Button onClick={() => void onDbTest()} loading={dbTesting} disabled={dbSaving}>
                        测试连接
                      </Button>
                      <Button
                        type="primary"
                        htmlType="submit"
                        loading={dbSaving}
                        disabled={dbTesting || !dbTestPassed}
                      >
                        保存并切换
                      </Button>
                    </>
                  ) : (
                    <Button type="primary" htmlType="submit" loading={dbSaving}>
                      切换回本地库
                    </Button>
                  )}
                  <Button
                    onClick={() => void onDbInitSchema()}
                    loading={dbInitializing}
                    disabled={!dbConnected || dbSaving || dbTesting}
                  >
                    初始化表结构
                  </Button>
                </Space>

                {dbMode === "postgres" && !dbTestPassed ? (
                  <Alert
                    style={{ marginTop: 12 }}
                    type="warning"
                    showIcon
                    message="请先测试连接成功后，才能保存自备 Postgres 配置"
                  />
                ) : null}

                {dbTestResult && (
                  <Alert
                    className={styles.testAlert}
                    type={dbTestResult.ok ? "success" : "error"}
                    showIcon
                    message={dbTestResult.ok ? "数据库测试成功" : "数据库测试失败"}
                    description={
                      <div>
                        <div>{dbTestResult.message}</div>
                        <div>时间：{dbTestResult.at}</div>
                      </div>
                    }
                  />
                )}
              </Form>
            )}
          </div>

          <aside className={styles.tips}>
            <Card size="small" title={<><InfoCircleOutlined /> 说明</>}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                连接配置保存在本机 data/runtime-db.json。SQLite 启动时自动建表；Postgres
                保存连接后需手动初始化表结构。
              </Typography.Paragraph>
            </Card>
            <Card size="small" title={<><SafetyCertificateOutlined /> 注意</>}>
              <ul className={styles.checklist}>
                <li>本地 SQLite：首次启动自动对齐表与默认配置</li>
                <li>自备 Postgres：测试 → 保存 → 初始化表结构</li>
                <li>切换数据库不会自动迁移数据</li>
              </ul>
            </Card>
          </aside>
        </>
      ) : (
        <>
          <div className={styles.content}>
            <div className={styles.contentHead}>
              <div>
                <h1>喂养</h1>
                <p className={styles.desc}>
                  公版电子书搜索相关选项。默认关闭「直接入库」，下载后仍走预览再入库。
                </p>
              </div>
              <Tag color={directIngest ? "success" : "default"}>
                {directIngest ? "直接入库已开" : "直接入库关闭"}
              </Tag>
            </div>

            {feedLoading ? (
              <div className={styles.loading}>
                <Spin /> 正在加载喂养设置…
              </div>
            ) : (
              <Form layout="vertical" className={styles.form} onFinish={() => void onSaveFeedSettings()}>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="公版书说明"
                  description={
                    feedDesc ||
                    "仅对接公版/开放书源（首期 Gutenberg）。开启后，搜索结果可使用「直接入库」。"
                  }
                />
                <Form.Item
                  label="公版书搜索结果允许直接入库"
                  extra="默认关闭：只能「下载到喂养」，抽取后预览再入库。开启后显示「直接入库」按钮。"
                >
                  <Switch checked={directIngest} onChange={setDirectIngest} />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={feedSaving}>
                  保存
                </Button>
              </Form>
            )}
          </div>

          <aside className={styles.tips}>
            <Card size="small" title={<><InfoCircleOutlined /> 说明</>}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                配置保存在 data/runtime-feed.json。与数据库连接配置相互独立。
              </Typography.Paragraph>
            </Card>
          </aside>
        </>
      )}
    </section>
  );
}
