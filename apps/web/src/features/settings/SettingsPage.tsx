import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api, type ProviderOption } from "@/shared/api/client";
import styles from "./SettingsPage.module.css";

function pickRecommended(models: { id: string; recommended?: boolean }[], fallback: string) {
  return models.find((m) => m.recommended)?.id ?? models[0]?.id ?? fallback;
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [providerId, setProviderId] = useState("deepseek");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [chatModel, setChatModel] = useState("deepseek-v4-flash");
  const [embedModel, setEmbedModel] = useState("deepseek-v4-flash");
  const [customChat, setCustomChat] = useState(false);
  const [customEmbed, setCustomEmbed] = useState(false);
  const [masked, setMasked] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const current = useMemo(
    () => providers.find((p) => p.id === providerId) ?? providers[0],
    [providers, providerId],
  );

  useEffect(() => {
    void (async () => {
      const [{ providers: list }, settings] = await Promise.all([
        api.getProviders(),
        api.getAiSettings(),
      ]);
      setProviders(list);
      setProviderId(settings.provider || "deepseek");
      setBaseUrl(settings.base_url);
      setChatModel(settings.chat_model);
      setEmbedModel(settings.embed_model);
      setMasked(settings.api_key_masked);

      const p = list.find((x) => x.id === settings.provider);
      if (p) {
        setCustomChat(!p.chat_models.some((m) => m.id === settings.chat_model));
        setCustomEmbed(!p.embed_models.some((m) => m.id === settings.embed_model));
      }
    })();
  }, []);

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

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const data = await api.saveAiSettings({
        provider: providerId,
        base_url: baseUrl,
        api_key: apiKey || undefined,
        chat_model: chatModel,
        embed_model: embedModel,
      });
      setMasked(data.api_key_masked);
      setApiKey("");
      setMessage("已保存");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setMessage("测试中…");
    try {
      const data = await api.testAiSettings();
      setMessage(
        data.ok
          ? `连接成功${data.latency_ms != null ? ` · ${data.latency_ms}ms` : ""}`
          : data.message || "连接失败",
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "测试失败");
    }
  }

  const chatOptions = current?.chat_models ?? [];
  const embedOptions = current?.embed_models ?? [];
  const chatMeta = chatOptions.find((m) => m.id === chatModel);
  const embedMeta = embedOptions.find((m) => m.id === embedModel);

  return (
    <section className={styles.page}>
      <h1>模型与 API Key</h1>
      <p className={styles.desc}>
        先选服务商，再选具体型号。Key 自备，仅保存在本机。DeepSeek 请优先选
        V4 Flash / V4 Pro。
      </p>

      <form className={styles.form} onSubmit={onSave}>
        <label>
          <span>服务商</span>
          <select value={providerId} onChange={(e) => onProviderChange(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>API Base URL</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
            readOnly={current ? !current.allow_custom_base_url && Boolean(current.base_url) : false}
          />
        </label>

        <label>
          <span>API Key {masked ? `（当前 ${masked}）` : ""}</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={masked ? "留空则保持原 Key" : "粘贴你的 Key"}
          />
        </label>

        <label>
          <span>对话模型</span>
          {!customChat ? (
            <select
              value={chatOptions.some((m) => m.id === chatModel) ? chatModel : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__custom__") {
                  setCustomChat(true);
                  setChatModel("");
                  return;
                }
                setChatModel(v);
              }}
              required
            >
              {chatOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.recommended ? "（推荐）" : ""}
                </option>
              ))}
              <option value="__custom__">其它（手动输入）…</option>
            </select>
          ) : (
            <input
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
              placeholder="例如 deepseek-v4-pro"
              required
            />
          )}
          {chatMeta?.desc ? <small className={styles.hint}>{chatMeta.desc}</small> : null}
          {customChat ? (
            <button
              type="button"
              className={styles.linkish}
              onClick={() => {
                setCustomChat(false);
                if (current) setChatModel(pickRecommended(current.chat_models, "deepseek-v4-flash"));
              }}
            >
              返回列表选择
            </button>
          ) : null}
        </label>

        <label>
          <span>Embedding 模型（检索用）</span>
          {!customEmbed ? (
            <select
              value={embedOptions.some((m) => m.id === embedModel) ? embedModel : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__custom__") {
                  setCustomEmbed(true);
                  setEmbedModel("");
                  return;
                }
                setEmbedModel(v);
              }}
              required
            >
              {embedOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.recommended ? "（推荐）" : ""}
                </option>
              ))}
              <option value="__custom__">其它（手动输入）…</option>
            </select>
          ) : (
            <input
              value={embedModel}
              onChange={(e) => setEmbedModel(e.target.value)}
              placeholder="例如 text-embedding-3-small"
              required
            />
          )}
          {embedMeta?.desc ? <small className={styles.hint}>{embedMeta.desc}</small> : null}
          {customEmbed ? (
            <button
              type="button"
              className={styles.linkish}
              onClick={() => {
                setCustomEmbed(false);
                if (current) setEmbedModel(pickRecommended(current.embed_models, "deepseek-v4-flash"));
              }}
            >
              返回列表选择
            </button>
          ) : null}
        </label>

        <div className={styles.actions}>
          <button type="submit" disabled={saving}>
            {saving ? "保存中…" : "保存配置"}
          </button>
          <button type="button" className={styles.secondary} onClick={() => void onTest()}>
            测试连接
          </button>
        </div>
      </form>
      {message ? <p className={styles.message}>{message}</p> : null}
    </section>
  );
}
