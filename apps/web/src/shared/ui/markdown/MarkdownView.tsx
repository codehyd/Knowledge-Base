import { useEffect, useMemo, useRef } from "react";
import katex from "katex";
import { renderMarkdown } from "./renderMarkdown";
import "katex/dist/katex.min.css";
import styles from "./MarkdownView.module.css";

type Props = {
  content: string;
  className?: string;
};

export function MarkdownView({ content, className }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    root.querySelectorAll<HTMLElement>("[data-type='math']").forEach((el) => {
      const latex = el.getAttribute("data-latex") || "";
      const display = el.getAttribute("data-display") === "inline" ? false : true;
      try {
        el.innerHTML = katex.renderToString(latex, { throwOnError: false, displayMode: display });
      } catch {
        el.textContent = latex;
      }
    });

    const mermaidBlocks = [...root.querySelectorAll("pre code.language-mermaid")];
    if (!mermaidBlocks.length) return;
    let cancelled = false;
    void import("mermaid").then((mod) => {
      if (cancelled) return;
      const mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
      mermaidBlocks.forEach((el, i) => {
        const code = el.textContent || "";
        const host = document.createElement("div");
        host.className = "kk-mermaid";
        const id = `kk-mmd-${i}-${Math.abs(hashCode(code))}`;
        void mermaid.render(id, code).then(({ svg }) => {
          if (cancelled) return;
          host.innerHTML = svg;
          el.parentElement?.replaceWith(host);
        }).catch(() => {
          host.textContent = code;
          el.parentElement?.replaceWith(host);
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [html]);

  if (!html) return null;
  return (
    <div
      ref={rootRef}
      className={`${styles.md}${className ? ` ${className}` : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function hashCode(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
