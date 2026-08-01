import { useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { useNavigate } from "react-router-dom";
import { api, type LibraryOut } from "@/shared/api/client";
import { getDesktopBridge } from "@/shared/desktop";
import { formatError } from "@/shared/ui/feedback";

export function useLibrarySettings(active: boolean) {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const desktop = getDesktopBridge();

  const [library, setLibrary] = useState<LibraryOut | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryRebuilding, setLibraryRebuilding] = useState(false);
  const [libraryCatKey, setLibraryCatKey] = useState<string>("");

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      setLibraryLoading(true);
      try {
        const data = await api.getLibrary();
        if (!cancelled) {
          setLibrary(data);
          setLibraryCatKey((prev) => {
            if (prev && data.categories.some((c) => c.key === prev || c.label === prev)) {
              return prev;
            }
            const preferred =
              data.categories.find((c) => c.item_count > 0) ?? data.categories[0];
            return preferred?.key || preferred?.label || "";
          });
        }
      } catch (err) {
        if (!cancelled) message.error(formatError(err, "读取资源库失败"));
      } finally {
        if (!cancelled) setLibraryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, message]);

  const libraryCats = library?.categories ?? [];
  const activeLibraryCat = useMemo(() => {
    return (
      libraryCats.find((c) => c.key === libraryCatKey || c.label === libraryCatKey) ??
      libraryCats[0] ??
      null
    );
  }, [libraryCats, libraryCatKey]);

  async function onRebuildLibrary() {
    setLibraryRebuilding(true);
    try {
      const out = await api.rebuildLibrary();
      const data = await api.getLibrary();
      setLibrary(data);
      message.success(out.message || `已同步 ${out.synced} 项`);
    } catch (err) {
      message.error(formatError(err, "重建资源库失败"));
    } finally {
      setLibraryRebuilding(false);
    }
  }

  async function onOpenLibraryPath(targetPath: string) {
    if (!desktop?.openPath) {
      message.info("请在桌面端打开资源文件夹；网页模式可到 data/library 查看");
      return;
    }
    try {
      const res = await desktop.openPath(targetPath);
      if (!res.ok) message.error(res.message || "打开失败");
    } catch (err) {
      message.error(formatError(err, "打开文件夹失败"));
    }
  }

  async function onDeleteLibraryItem(sourceId: number, title: string) {
    if (!sourceId) {
      message.warning("无法删除：缺少来源编号，请先重建目录后再试");
      return;
    }
    modal.confirm({
      title: `删除「${title}」？`,
      content:
        "将永久删除喂养来源、已入库知识与资源目录。只在资源文件夹里删文件无效——点重建仍会回来。",
      okText: "永久删除",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const out = await api.deleteLibraryItem(sourceId);
          message.success(out.message || "已删除");
          const data = await api.getLibrary();
          setLibrary(data);
        } catch (err) {
          message.error(formatError(err, "删除失败"));
        }
      },
    });
  }

  return {
    library,
    libraryLoading,
    libraryRebuilding,
    libraryCatKey,
    libraryCats,
    activeLibraryCat,
    setLibraryCatKey,
    navigate,
    onRebuildLibrary,
    onOpenLibraryPath,
    onDeleteLibraryItem,
  };
}
