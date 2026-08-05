import { useMemo } from "react";
import { renderMarkdown } from "./renderMarkdown";
import styles from "./MarkdownView.module.css";

type Props = {
  content: string;
  className?: string;
};

export function MarkdownView({ content, className }: Props) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  if (!html) return null;
  return (
    <div
      className={`${styles.md}${className ? ` ${className}` : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
