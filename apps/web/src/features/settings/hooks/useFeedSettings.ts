import { useCallback, useEffect, useState } from "react";
import { App } from "antd";
import { api } from "@/shared/api/client";
import { getDesktopBridge } from "@/shared/desktop";
import { formatError } from "@/shared/ui/feedback";

export function useFeedSettings(active: boolean) {
  const { message } = App.useApp();
  const desktop = getDesktopBridge();

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
  const [mediaCookiesReady, setMediaCookiesReady] = useState(false);
  const [mediaLoginBusy, setMediaLoginBusy] = useState(false);

  const applyCtextSnapshot = useCallback(
    (feed: Awaited<ReturnType<typeof api.getOpenBookSettings>>) => {
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
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const feed = await api.getOpenBookSettings();
        if (cancelled) return;
        applyCtextSnapshot(feed);
      } catch {
        /* 书源 Key 可选，失败不挡主流程 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyCtextSnapshot]);

  useEffect(() => {
    if (!active) return;
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
  }, [active, applyCtextSnapshot, message]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void desktop.getConfig().then((cfg) => {
      if (cancelled) return;
      setMediaCookiesReady(Boolean(cfg.mediaCookiesReady));
    });
    const off = desktop.onMediaCookiesExported?.((info) => {
      if (info.ok && info.loggedIn) {
        setMediaCookiesReady(true);
        message.success(
          info.message ||
            (info.count
              ? `已保存登录态（${info.count} 条 Cookie）`
              : "已保存抖音登录态"),
        );
      } else if (info.ok === false || info.loggedIn === false) {
        setMediaCookiesReady(false);
        if (info.message) message.warning(info.message);
      }
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [desktop, message]);

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

  async function onLoginDouyin() {
    if (!desktop?.loginMediaSite) {
      message.warning("请在空库桌面客户端（安装包）内使用，浏览器网页版无法应用内登录");
      return;
    }
    setMediaLoginBusy(true);
    try {
      await desktop.loginMediaSite("douyin");
      message.info("请在弹出窗口登录抖音网页版，完成后关闭该窗口");
    } catch (err) {
      message.error(formatError(err, "打开登录窗口失败"));
    } finally {
      setMediaLoginBusy(false);
    }
  }

  return {
    desktop,
    feedLoading,
    feedSaving,
    directIngest,
    feedDesc,
    ctextKey,
    ctextMasked,
    ctextConfigured,
    ctextKeysUrl,
    ctextDocsUrl,
    ctextHint,
    ctextSaving,
    mirrorRepo,
    mirrorRef,
    mirrorHint,
    mirrorPresets,
    mirrorSaving,
    mediaCookiesReady,
    mediaLoginBusy,
    setDirectIngest,
    setCtextKey,
    setMirrorRepo,
    setMirrorRef,
    onSaveFeedSettings,
    onSaveCtextKey,
    onClearCtextKey,
    onSaveMirror,
    onLoginDouyin,
  };
}
