import { getDesktopBridge } from "@/shared/desktop";

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOOKS_LIKE_HOST = /^[\w.-]+\.[\w.-]+/;

export function normalizeExternalUrl(raw: string): string | null {
  const u = String(raw || "").trim();
  if (!u || u === "about:blank") return null;
  if (/^(javascript|data|vbscript):/i.test(u)) return null;
  if (/^(https?|mailto|ftp):/i.test(u)) return u;
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("#") || u.startsWith("/") || u.startsWith("./") || u.startsWith("../")) {
    if (/^\/[\w.-]+\.[\w.-]+/.test(u)) return `https://${u.slice(1)}`;
    return null;
  }
  if (!HAS_SCHEME.test(u) && LOOKS_LIKE_HOST.test(u)) {
    return `https://${u}`;
  }
  try {
    const base = typeof window !== "undefined" ? window.location.href : "https://local.invalid";
    const parsed = new URL(u, base);
    if (
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      /^\/[\w.-]+\.[\w.-]+/.test(parsed.pathname)
    ) {
      return `https://${parsed.pathname.slice(1)}${parsed.search}${parsed.hash}`;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function isHttpLike(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^mailto:/i.test(url) || /^ftp:/i.test(url);
}

function nativeWindowOpen(url: string): boolean {
  try {
    return window.open(url, "_blank", "noopener,noreferrer") != null;
  } catch {
    return false;
  }
}

/** 同步打开系统浏览器（Electron IPC 或 window.open） */
export function openInSystemBrowser(raw: string): boolean {
  const url = normalizeExternalUrl(raw);
  if (!url || !isHttpLike(url)) return false;

  const desktop = getDesktopBridge();
  if (desktop?.openExternal) {
    void desktop.openExternal(url).catch(() => {
      nativeWindowOpen(url);
    });
    return true;
  }

  return nativeWindowOpen(url);
}
