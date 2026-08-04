/**
 * 外链规范化：补协议，并纠正相对路径误解析（localhost/www.x.com）。
 */

function normalizeExternalUrl(raw) {
  let next = String(raw || "").trim();
  if (!next || next === "about:blank") return null;
  if (/^(javascript|data|vbscript):/i.test(next)) return null;

  if (!/^[a-z][a-z0-9+.-]*:/i.test(next) && /^[\w.-]+\.[\w.-]+/.test(next)) {
    next = `https://${next}`;
  } else {
    try {
      const parsed = new URL(next);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
        /^\/[\w.-]+\.[\w.-]+/.test(parsed.pathname)
      ) {
        next = `https://${parsed.pathname.slice(1)}${parsed.search}${parsed.hash}`;
      }
    } catch {
      /* keep */
    }
  }

  if (!/^(https?:|mailto:|ftp:)/i.test(next)) return null;
  return next;
}

module.exports = { normalizeExternalUrl };
