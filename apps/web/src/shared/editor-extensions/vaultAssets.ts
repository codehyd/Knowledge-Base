export const VAULT_FILES_PREFIX = "/api/vault/files/";

export function toEditorImageSrc(src: string): string {
  const s = (src || "").trim();
  if (!s) return s;
  if (
    /^(https?:|data:|blob:)/i.test(s) ||
    s.startsWith(VAULT_FILES_PREFIX) ||
    s.startsWith("/")
  ) {
    return s;
  }
  if (s.startsWith("_assets/")) return `${VAULT_FILES_PREFIX}${s}`;
  return s;
}

export function toMarkdownImageSrc(src: string): string {
  const s = (src || "").trim();
  if (s.startsWith(VAULT_FILES_PREFIX)) return s.slice(VAULT_FILES_PREFIX.length);
  return s;
}

export function rewriteMarkdownImagesForEditor(md: string): string {
  return (md || "").replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
    return `![${alt}](${toEditorImageSrc(String(src).trim())})`;
  });
}

export function rewriteMarkdownImagesForSave(md: string): string {
  return (md || "").replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
    return `![${alt}](${toMarkdownImageSrc(String(src).trim())})`;
  });
}

export function rewriteHtmlImageSrcs(html: string): string {
  return (html || "").replace(
    /(<img\b[^>]*\bsrc=")(_assets\/[^"]+)(")/gi,
    (_m, pre, src, post) => `${pre}${toEditorImageSrc(src)}${post}`,
  );
}
