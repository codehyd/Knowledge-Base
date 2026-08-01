import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { YuqueRichText } from "yuque-editor-core/react";
import type { YuqueDocScheme, YuqueEditorRef } from "yuque-editor-core/editor";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import styles from "./LakeEditor.module.css";

// Lake 编辑器会把整套 antd v4 的 antd.css 全局插入 <head>，其裸 .ant-* 选择器
// 优先级高于应用 antd v6 的 :where() 样式，一旦加载就拖垮全站组件样式。
// 这里在编辑器卸载时禁用这些样式表（而非移除：包的加载注册表有缓存，
// 移除后重新挂载不会重新注入），挂载时再启用。
const setYuqueStylesEnabled = (enabled: boolean) => {
  document
    .querySelectorAll<HTMLLinkElement>("link[data-yuque-asset]")
    .forEach((link) => {
      link.disabled = !enabled;
    });
};

// 切换笔记会触发编辑器重挂载：仅当所有 Lake 实例都卸载后才禁用样式表，
// 否则旧实例的清理会把新实例正在用的语雀样式禁用掉
let activeLakeEditors = 0;

// 卸载后立即禁用样式表，并用观察者兜底：引擎资源是异步的，
// 卸载后才插入 <head> 的样式表一出现就禁用，避免污染窗口期
let headGuard: MutationObserver | null = null;
const startHeadGuard = () => {
  if (headGuard) return;
  headGuard = new MutationObserver((records) => {
    if (activeLakeEditors > 0) return;
    for (const rec of records) {
      rec.addedNodes.forEach((node) => {
        if (
          node instanceof HTMLLinkElement &&
          node.hasAttribute("data-yuque-asset")
        ) {
          node.disabled = true;
        }
      });
    }
  });
  headGuard.observe(document.head, { childList: true });
};

export type LakeEditorHandle = {
  getMarkdown: () => string;
  getLakeSource: () => string;
};

type Props = {
  initialContent: string;
  initialScheme?: YuqueDocScheme;
  onDirtyChange?: (dirty: boolean) => void;
  onSave?: () => void | Promise<void>;
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);

export const LakeEditor = forwardRef<LakeEditorHandle, Props>(function LakeEditor(
  { initialContent, initialScheme = "text/markdown", onDirtyChange, onSave },
  ref,
) {
  const editorRef = useRef<YuqueEditorRef>(null);
  const [ready, setReady] = useState(false);
  const mountedAt = useRef(Date.now());

  // 资源缓存后编辑器会秒加载，加载层一闪而过反而更别扭；
  // 这里保证加载层至少展示一拍，让每次切换的过渡节奏一致
  const MIN_LOADING_MS = 700;
  const onLoaded = () => {
    const elapsed = Date.now() - mountedAt.current;
    const wait = Math.max(0, MIN_LOADING_MS - elapsed);
    window.setTimeout(() => setReady(true), wait);
  };

  useImperativeHandle(ref, () => ({
    getMarkdown: () => {
      const ed = editorRef.current;
      if (!ed) return "";
      try {
        return ed.getContent("text/markdown") || "";
      } catch {
        try {
          return turndown.turndown(ed.getContent("text/html") || "");
        } catch {
          return "";
        }
      }
    },
    getLakeSource: () => {
      const ed = editorRef.current;
      if (!ed) return "";
      try {
        return ed.getContent("text/lake") || "";
      } catch {
        return "";
      }
    },
  }));

  useEffect(() => {
    activeLakeEditors += 1;
    setYuqueStylesEnabled(true);
    return () => {
      activeLakeEditors = Math.max(0, activeLakeEditors - 1);
      if (activeLakeEditors === 0) {
        setYuqueStylesEnabled(false);
        startHeadGuard();
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void onSave?.();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onSave]);

  return (
    <div className={styles.root}>
      {/* 引擎资源加载期间的白屏用加载层盖住，就绪后淡出 */}
      <div className={`${styles.loading}${ready ? ` ${styles.loadingDone}` : ""}`}>
        <span className={styles.spinner} />
        <span className={styles.loadingText}>语雀编辑器加载中…</span>
      </div>
      <div className={`${styles.editorHolder}${ready ? ` ${styles.editorHolderReady}` : ""}`}>
        <YuqueRichText
          ref={editorRef}
          value={initialContent}
          scheme={initialScheme}
          showToolbar
          showToc={false}
          onLoad={onLoaded}
          onChange={() => onDirtyChange?.(true)}
          onError={(err) => console.error("[lake-editor]", err)}
        />
      </div>
    </div>
  );
});
