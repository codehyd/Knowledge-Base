import { useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { api, type ProviderOption } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import type { TestResult } from "../types";
import { pickRecommended } from "../utils/pickRecommended";

export function useAiSettings() {
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
  const [asrMode, setAsrMode] = useState("auto");
  const [asrBaseUrl, setAsrBaseUrl] = useState("");
  const [asrApiKey, setAsrApiKey] = useState("");
  const [asrMasked, setAsrMasked] = useState("");
  const [asrModel, setAsrModel] = useState("");
  const [asrLocalModel, setAsrLocalModel] = useState("base");
  const [allowLocalAudio, setAllowLocalAudio] = useState(false);
  const [chatMaxTokens, setChatMaxTokens] = useState(1200);
  const [quoteRefineMaxTokens, setQuoteRefineMaxTokens] = useState(8000);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const current = useMemo(
    () => providers.find((p) => p.id === providerId) ?? providers[0],
    [providers, providerId],
  );

  const chatOptions = current?.chat_models ?? [];
  const embedOptions = current?.embed_models ?? [];

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
          setAsrMode(settings.asr_mode || "auto");
          setAsrBaseUrl(settings.asr_base_url || "");
          setAsrMasked(settings.asr_api_key_masked || "");
          setAsrModel(settings.asr_model || "");
          setAsrLocalModel(settings.asr_local_model || "base");
          setAllowLocalAudio(Boolean(settings.allow_local_audio));
          setChatMaxTokens(settings.chat_max_tokens ?? 1200);
          setQuoteRefineMaxTokens(settings.quote_refine_max_tokens ?? 8000);

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

  async function persistAiSettings(opts?: { successMessage?: string }) {
    const data = await api.saveAiSettings({
      provider: providerId,
      base_url: baseUrl,
      api_key: apiKey || undefined,
      chat_model: chatModel,
      embed_model: embedModel,
      asr_mode: asrMode,
      asr_base_url: asrBaseUrl,
      asr_api_key: asrApiKey || undefined,
      asr_model: asrModel,
      asr_local_model: asrLocalModel,
      allow_local_audio: allowLocalAudio,
      chat_max_tokens: chatMaxTokens,
      quote_refine_max_tokens: quoteRefineMaxTokens,
    });
    setMasked(data.api_key_masked);
    setConfigured(data.configured);
    setAsrMode(data.asr_mode || "auto");
    setAsrBaseUrl(data.asr_base_url || "");
    setAsrMasked(data.asr_api_key_masked || "");
    setAsrModel(data.asr_model || "");
    setAsrLocalModel(data.asr_local_model || "base");
    setAllowLocalAudio(Boolean(data.allow_local_audio));
    setChatMaxTokens(data.chat_max_tokens ?? chatMaxTokens);
    setQuoteRefineMaxTokens(data.quote_refine_max_tokens ?? quoteRefineMaxTokens);
    setApiKey("");
    setAsrApiKey("");
    message.success(opts?.successMessage ?? "已保存");
  }

  async function onSave() {
    setSaving(true);
    try {
      await persistAiSettings();
    } catch (err) {
      message.error(formatError(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  async function onSaveMediaSettings() {
    setSaving(true);
    try {
      await persistAiSettings({ successMessage: "视频转写设置已保存" });
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

  return {
    providers,
    providerId,
    baseUrl,
    apiKey,
    chatModel,
    embedModel,
    customChat,
    customEmbed,
    masked,
    configured,
    asrMode,
    asrBaseUrl,
    asrApiKey,
    asrMasked,
    asrModel,
    asrLocalModel,
    allowLocalAudio,
    chatMaxTokens,
    quoteRefineMaxTokens,
    loading,
    saving,
    testing,
    testResult,
    current,
    chatOptions,
    embedOptions,
    setBaseUrl,
    setApiKey,
    setChatModel,
    setEmbedModel,
    setCustomChat,
    setCustomEmbed,
    setAsrMode,
    setAsrBaseUrl,
    setAsrApiKey,
    setAsrModel,
    setAsrLocalModel,
    setAllowLocalAudio,
    setChatMaxTokens,
    setQuoteRefineMaxTokens,
    onProviderChange,
    onSave,
    onSaveMediaSettings,
    onTest,
  };
}
