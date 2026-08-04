import { getDesktopBridge } from "@/shared/desktop";

/**
 * 语雀编辑态默认 envAdapter.openLink 为空实现；DOM 上的 ne-link 也不带 src。
 * 通过 window.__kongkuYuqueEnvAdapter 注入（由 vite 插件 / 补丁传给 createOpenEditor）。
 */

declare global {
  interface Window {
    __kongkuYuqueEnvAdapter?: {
      openLink: (url: string, blank?: boolean) => void;
      openLocalLink: (url: string) => void;
      openMentionLink?: (url: string, blank?: boolean) => void;
    };
  }
}

let patchDepth = 0;
let originalOpen: typeof window.open | null = null;
let adapterDepth = 0;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOOKS_LIKE_HOST = /^[\w.-]+\.[\w.-]+/;

export function normalizeLakeExternalUrl(raw: string): string | null {
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
  const open = originalOpen ?? window.open.bind(window);
  try {
    return open(url, "_blank", "noopener,noreferrer") != null;
  } catch {
    return false;
  }
}

/** 同步打开系统浏览器（Electron IPC 或 window.open） */
export function openInSystemBrowser(raw: string): boolean {
  const url = normalizeLakeExternalUrl(raw);
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

/** 挂到 window，供 yuque-editor-core createOpenEditor 读取 */
export function installYuqueEnvAdapter(): () => void {
  if (typeof window === "undefined") return () => {};

  adapterDepth += 1;
  window.__kongkuYuqueEnvAdapter = {
    openLink: (url: string) => {
      openInSystemBrowser(url);
    },
    openLocalLink: (url: string) => {
      openInSystemBrowser(url);
    },
    openMentionLink: (url: string) => {
      openInSystemBrowser(url);
    },
  };

  return () => {
    adapterDepth = Math.max(0, adapterDepth - 1);
    if (adapterDepth === 0) {
      delete window.__kongkuYuqueEnvAdapter;
    }
  };
}

/** @deprecated 使用 installYuqueEnvAdapter */
export function installYuqueDocOpenLinkPatch(): () => void {
  return installYuqueEnvAdapter();
}

export function installLakeWindowOpenPatch(): () => void {
  if (typeof window === "undefined") return () => {};

  if (patchDepth === 0) {
    originalOpen = window.open.bind(window);
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      const raw = url == null ? "" : String(url);
      const normalized = normalizeLakeExternalUrl(raw) ?? raw;
      if (isHttpLike(normalized)) {
        openInSystemBrowser(normalized);
        return null;
      }
      return originalOpen!(url as string | URL | undefined, target, features);
    }) as typeof window.open;
  }

  patchDepth += 1;
  return () => {
    patchDepth = Math.max(0, patchDepth - 1);
    if (patchDepth === 0 && originalOpen) {
      window.open = originalOpen;
      originalOpen = null;
    }
  };
}

export function readLakeLinkHref(el: Element | null, root?: Element | null): string | null {
  let cur: Element | null = el;
  while (cur && cur !== root) {
    const tag = cur.tagName?.toLowerCase?.() ?? "";
    if (tag === "ne-link" || cur.classList.contains("ne-link")) {
      for (const name of ["src", "href", "data-href", "data-src"]) {
        const v = cur.getAttribute(name)?.trim();
        if (v) return v;
      }
      const text = cur.textContent?.trim() || "";
      if (normalizeLakeExternalUrl(text)) return text;
    }
    if (tag === "a") {
      const href = cur.getAttribute("href") || cur.getAttribute("data-href");
      if (href?.trim()) return href.trim();
    }
    cur = cur.parentElement;
  }
  return null;
}
