import { useEffect, useMemo, useState } from "react";
import {
  ApiOutlined,
  DollarOutlined,
  InfoCircleOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
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
  const [subNav, setSubNav] = useState("model");

  const current = useMemo(
    () => providers.find((p) => p.id === providerId) ?? providers[0],
    [providers, providerId],
  );

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

      <div className={styles.content}>
        <div className={styles.contentHead}>
          <div>
            <h1>模型与 API Key</h1>
            <p className={styles.desc}>配置你的模型服务与 API Key，用于对话与 AI 入库等功能。</p>
          </div>
          <Tag color={configured ? "success" : "default"}>
            {configured ? "Key 已配置" : "Key 未配置"}
            {testResult?.ok && testResult.latency_ms != null
              ? ` · 延迟 ${testResult.latency_ms}ms`
              : ""}
          </Tag>
        </div>

        {loading ? (
          <div className={styles.loading}>
            <Spin /> 正在加载服务商与配置…
          </div>
        ) : (
          <Form layout="vertical" className={styles.form} onFinish={() => void onSave()}>
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
                  current ? !current.allow_custom_base_url && Boolean(current.base_url) : false
                }
              />
            </Form.Item>

            <Form.Item
              label={`API Key${masked ? `（当前 ${masked}）` : ""}`}
              extra="用于请求 API 的密钥，仅保存在本机。"
            >
              <Input.Password
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={masked ? "留空则保持原 Key" : "粘贴你的 Key"}
                autoComplete="off"
              />
            </Form.Item>

            <Form.Item label="对话模型" required extra="用于对话（Chat Completion）的模型名称。">
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
                        setChatModel(pickRecommended(current.chat_models, "deepseek-v4-flash"));
                      }
                    }}
                  >
                    列表
                  </Button>
                </Space.Compact>
              ) : (
                <Select
                  value={chatOptions.some((m) => m.id === chatModel) ? chatModel : undefined}
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
                        setEmbedModel(pickRecommended(current.embed_models, "deepseek-v4-flash"));
                      }
                    }}
                  >
                    列表
                  </Button>
                </Space.Compact>
              ) : (
                <Select
                  value={embedOptions.some((m) => m.id === embedModel) ? embedModel : undefined}
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
              <Button type="primary" htmlType="submit" loading={saving} disabled={testing}>
                保存配置
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
                    {testResult.latency_ms != null && <div>耗时：{testResult.latency_ms}ms</div>}
                    <div>模型：{chatModel}</div>
                    <div>时间：{testResult.at}</div>
                  </div>
                }
              />
            )}
          </Form>
        )}
      </div>

      <aside className={styles.tips}>
        <Card size="small" title={<><DollarOutlined /> 费用说明</>}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Token 费用由你的服务商账户承担，本工具不另收费。
          </Typography.Paragraph>
        </Card>
        <Card size="small" title={<><SafetyCertificateOutlined /> 安全提示</>}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Key 仅保存在本机；导出备份默认不包含 Key，避免泄露。
          </Typography.Paragraph>
        </Card>
        <Card size="small" title={<><InfoCircleOutlined /> 使用检查清单</>}>
          <ul className={styles.checklist}>
            <li>未配置时：对话不可用</li>
            <li>未配置时：AI 入库 / 归类不可用</li>
            <li>未配置 Embedding：向量检索不可用</li>
          </ul>
        </Card>
      </aside>
    </section>
  );
}
