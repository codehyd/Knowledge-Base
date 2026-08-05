import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const BLOCKED_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "style",
  "form",
  "input",
  "button",
  "textarea",
  "select",
]);

/** 轻量消毒：去掉可执行标签与事件属性（对话内容来自本机模型，仍做基本防护）。 */
export function sanitizeHtml(html: string): string {
  if (!html || typeof DOMParser === "undefined") return html || "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll([...BLOCKED_TAGS].join(",")).forEach((el) => el.remove());
  doc.body.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value || "";
      if (name.startsWith("on") || /javascript:/i.test(value) || name === "srcdoc") {
        el.removeAttribute(attr.name);
      }
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });
  return doc.body.innerHTML;
}

export function renderMarkdown(md: string): string {
  const raw = (md || "").trim();
  if (!raw) return "";
  const html = marked.parse(raw, { async: false }) as string;
  return sanitizeHtml(html);
}
