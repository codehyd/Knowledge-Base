import { useEffect, useState } from "react";
import { App } from "antd";
import { getDesktopBridge } from "@/shared/desktop";
import { formatError } from "@/shared/ui/feedback";
import { formatBytes } from "../utils/formatBytes";

export function useAppUpdate() {
  const { message } = App.useApp();
  const desktop = getDesktopBridge();

  const [appVersion, setAppVersion] = useState("");
  const [isPackaged, setIsPackaged] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  const [updatePercent, setUpdatePercent] = useState(0);
  const [updateTransferred, setUpdateTransferred] = useState(0);
  const [updateTotal, setUpdateTotal] = useState(0);
  const [updateSpeed, setUpdateSpeed] = useState(0);
  const [remoteVersion, setRemoteVersion] = useState("");
  const [updateReady, setUpdateReady] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<{
    type: "info" | "success" | "warning" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void desktop.getConfig().then((cfg) => {
      if (cancelled) return;
      setAppVersion(cfg.version || "");
      setIsPackaged(Boolean(cfg.isPackaged));
    });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    const offs = [
      desktop.onUpdateAvailable((info) => {
        const ver = info.version || "";
        setRemoteVersion(ver);
        setUpdateReady(false);
        setUpdateStatus({
          type: "info",
          message: ver ? `发现新版本 ${ver}` : "发现新版本",
        });
        setCheckingUpdate(false);
      }),
      desktop.onUpdateNotAvailable(() => {
        setRemoteVersion("");
        setUpdateReady(false);
        setUpdateStatus({ type: "success", message: "当前已是最新版本" });
        setCheckingUpdate(false);
      }),
      desktop.onUpdateProgress((p) => {
        const percent = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
        const transferred = Number(p.transferred) || 0;
        const total = Number(p.total) || 0;
        const speed = Number(p.bytesPerSecond) || 0;
        setDownloadingUpdate(true);
        setUpdatePercent(percent);
        setUpdateTransferred(transferred);
        setUpdateTotal(total);
        setUpdateSpeed(speed);
        const sizeText =
          total > 0
            ? `${formatBytes(transferred)} / ${formatBytes(total)}`
            : formatBytes(transferred);
        const speedText = speed > 0 ? ` · ${formatBytes(speed)}/s` : "";
        setUpdateStatus({
          type: "info",
          message: `正在下载更新 ${percent}%（${sizeText}${speedText}）`,
        });
      }),
      desktop.onUpdateDownloaded((info) => {
        setDownloadingUpdate(false);
        setUpdatePercent(100);
        setUpdateSpeed(0);
        setUpdateReady(true);
        const ver = info.version || "";
        if (ver) setRemoteVersion(ver);
        setUpdateStatus({
          type: "success",
          message: ver
            ? `版本 ${ver} 已下载，重启后完成安装`
            : "更新已下载，重启后完成安装",
        });
      }),
      desktop.onUpdateError((msg) => {
        setCheckingUpdate(false);
        setDownloadingUpdate(false);
        setUpdateSpeed(0);
        setUpdateStatus({
          type: "error",
          message: formatError(msg, "检查更新失败"),
        });
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [desktop]);

  async function onCheckUpdate() {
    if (!desktop) {
      message.info("请在桌面客户端中检查更新");
      return;
    }
    setCheckingUpdate(true);
    setUpdateStatus({ type: "info", message: "正在检查更新…" });
    setUpdateReady(false);
    setUpdatePercent(0);
    setUpdateTransferred(0);
    setUpdateTotal(0);
    setUpdateSpeed(0);
    try {
      const result = await desktop.checkForUpdates();
      if (!result.ok) {
        setUpdateStatus({
          type: result.reason === "dev" ? "warning" : "error",
          message: result.message || "检查更新失败",
        });
        setCheckingUpdate(false);
        return;
      }
      window.setTimeout(() => setCheckingUpdate(false), 8000);
    } catch (err) {
      setCheckingUpdate(false);
      setUpdateStatus({
        type: "error",
        message: formatError(err, "检查更新失败"),
      });
    }
  }

  async function onDownloadUpdate() {
    if (!desktop) return;
    setDownloadingUpdate(true);
    setUpdatePercent(0);
    setUpdateTransferred(0);
    setUpdateTotal(0);
    setUpdateSpeed(0);
    setUpdateStatus({
      type: "info",
      message: "正在下载更新（网络不稳会自动重试）…",
    });
    try {
      await desktop.downloadUpdate();
    } catch (err) {
      setDownloadingUpdate(false);
      setUpdateSpeed(0);
      setUpdateStatus({
        type: "error",
        message: formatError(err, "下载更新失败"),
      });
    }
  }

  async function onInstallUpdate() {
    if (!desktop) return;
    try {
      await desktop.installUpdate();
    } catch (err) {
      message.error(formatError(err, "安装更新失败"));
    }
  }

  async function onOpenReleases() {
    if (!desktop?.openReleasesPage) {
      window.open(
        remoteVersion
          ? `https://github.com/codehyd/Knowledge-Base/releases/tag/v${remoteVersion}`
          : "https://github.com/codehyd/Knowledge-Base/releases/latest",
        "_blank",
        "noopener,noreferrer",
      );
      return;
    }
    try {
      await desktop.openReleasesPage(remoteVersion || undefined);
    } catch (err) {
      message.error(formatError(err, "打开下载页失败"));
    }
  }

  return {
    desktop,
    appVersion,
    isPackaged,
    checkingUpdate,
    downloadingUpdate,
    updatePercent,
    updateTransferred,
    updateTotal,
    updateSpeed,
    remoteVersion,
    updateReady,
    updateStatus,
    onCheckUpdate,
    onDownloadUpdate,
    onInstallUpdate,
    onOpenReleases,
  };
}
