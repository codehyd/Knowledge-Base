import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { YuqueRichText } from "yuque-editor-core/react";
import type { YuqueDocScheme, YuqueEditorRef } from "yuque-editor-core/editor";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { api } from "@/shared/api/client";
import {
  extractWikilinkTargets,
  flattenVaultNotes,
  restoreWikilinkMarkers,
  type WikiNoteOption,
} from "@/shared/ui/markdown-editor/wikilinks";
import {
  LakeWikiPicker,
  readTrailingWikilinkQuery,
  replaceTrailingWikilink,
} from "./LakeWikiPicker";
import {
  installLakeWindowOpenPatch,
  installYuqueEnvAdapter,
  normalizeLakeExternalUrl,
  openInSystemBrowser,
  readLakeLinkHref,
} from "./openExternalLink";
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
  /** 在引擎光标处插入纯文本（如 [[笔记名]]） */
  insertText: (text: string) => void;
  focus: () => void;
};

type Props = {
  initialContent: string;
  initialScheme?: YuqueDocScheme;
  onDirtyChange?: (dirty: boolean) => void;
  onSave?: () => void | Promise<void>;
};

type WikiUi =
  | { mode: "insert"; query: string }
  | { mode: "complete"; query: string; left: number; top: number }
  | null;

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
  const rootRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [wikiNotes, setWikiNotes] = useState<WikiNoteOption[]>([]);
  const [wikiUi, setWikiUi] = useState<WikiUi>(null);
  const [linkHint, setLinkHint] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const mountedAt = useRef(Date.now());
  const completeOpenRef = useRef(false);
  const wikiUiRef = useRef<WikiUi>(null);

  const MIN_LOADING_MS = 700;
  const onLoaded = () => {
    const elapsed = Date.now() - mountedAt.current;
    const wait = Math.max(0, MIN_LOADING_MS - elapsed);
    window.setTimeout(() => setReady(true), wait);
  };

  const readMarkdown = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return "";
    let md = "";
    try {
      md = restoreWikilinkMarkers(ed.getContent("text/markdown") || "");
    } catch {
      try {
        md = restoreWikilinkMarkers(turndown.turndown(ed.getContent("text/html") || ""));
      } catch {
        md = "";
      }
    }
    // 语雀导出偶发丢掉 [[…]]：用 HTML 纯文本兜底补回
    try {
      const html = ed.getContent("text/html") || "";
      const plain = html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, "");
      const decoded = plain
        .replace(/&\[/g, "[")
        .replace(/&#91;/g, "[")
        .replace(/&#93;/g, "]")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      const fromPlain = extractWikilinkTargets(decoded);
      const fromMd = new Set(extractWikilinkTargets(md).map((t) => t.toLowerCase()));
      for (const t of fromPlain) {
        if (!fromMd.has(t.toLowerCase())) {
          md = `${md.trimEnd()}${md.trim() ? "\n\n" : ""}[[${t}]]`;
          fromMd.add(t.toLowerCase());
        }
      }
    } catch {
      /* ignore */
    }
    return md;
  }, []);

  const focusEngine = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const el =
      root.querySelector<HTMLElement>("[contenteditable='true']") ||
      root.querySelector<HTMLElement>(".ne-engine") ||
      root.querySelector<HTMLElement>(".lake-engine") ||
      root.querySelector<HTMLElement>("[data-selection-area]");
    el?.focus();
  }, []);

  /** 聚焦编辑区并把光标放到文末（新建 / 切换笔记时用） */
  const focusEnd = useCallback(() => {
    const ed = editorRef.current as
      | (YuqueEditorRef & { focusToEnd?: () => void; focusToStart?: () => void })
      | null;
    focusEngine();
    try {
      if (typeof ed?.focusToEnd === "function") {
        ed.focusToEnd();
        return;
      }
    } catch {
      /* fall through */
    }
    const root = rootRef.current;
    const el =
      root?.querySelector<HTMLElement>("[contenteditable='true']") ||
      root?.querySelector<HTMLElement>(".ne-engine") ||
      root?.querySelector<HTMLElement>(".lake-engine");
    if (!el) return;
    try {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      try {
        ed?.focusToStart?.();
      } catch {
        /* ignore */
      }
    }
  }, [focusEngine]);

  const writeWikilink = useCallback(
    (name: string, mode: "insert" | "complete") => {
      const ed = editorRef.current;
      if (!ed) return false;
      const marker = `[[${name}]]`;
      // 用引擎原始 markdown，避免 HTML 兜底“假阳性”导致以为已写入而不再 setContent
      let raw = "";
      try {
        raw = restoreWikilinkMarkers(ed.getContent("text/markdown") || "");
      } catch {
        raw = readMarkdown();
      }
      const next =
        mode === "complete"
          ? replaceTrailingWikilink(raw, name)
          : !raw.trim()
            ? marker
            : `${raw}${/\s$/.test(raw) ? "" : "\n\n"}${marker}`;

      try {
        ed.setContent(next, "text/markdown");
      } catch {
        focusEngine();
        try {
          ed.insertText(marker);
        } catch {
          return false;
        }
      }
      return true;
    },
    [focusEngine, readMarkdown],
  );

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => readMarkdown(),
      getLakeSource: () => {
        const ed = editorRef.current;
        if (!ed) return "";
        try {
          return ed.getContent("text/lake") || "";
        } catch {
          return "";
        }
      },
      insertText: (text: string) => {
        const ed = editorRef.current;
        if (!ed || !text) return;
        try {
          ed.insertText(text);
        } catch (err) {
          console.error("[lake-editor] insertText", err);
        }
      },
      focus: () => {
        focusEnd();
      },
    }),
    [focusEnd, focusEngine, readMarkdown],
  );

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => focusEnd(), 80);
    return () => window.clearTimeout(timer);
  }, [ready, focusEnd]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getVaultTree()
      .then((res) => {
        if (!cancelled) setWikiNotes(flattenVaultNotes(res.nodes || []));
      })
      .catch(() => {
        if (!cancelled) setWikiNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 必须在语雀 createOpenEditor 之前挂好 envAdapter（编辑态默认 openLink 是空函数）
  useLayoutEffect(() => installYuqueEnvAdapter(), []);

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

  // 语雀点击链接：补全 https；桌面端走系统浏览器
  useEffect(() => {
    if (!ready) return;
    return installLakeWindowOpenPatch();
  }, [ready]);

  // 点击 ne-link / a：直接用系统浏览器打开
  useEffect(() => {
    if (!ready) return;
    const root = rootRef.current;
    if (!root) return;

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target) return;

      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && root.contains(sel.anchorNode)) return;

      const insideEditor = root.contains(target);

      // 悬浮条「访问链接」可能挂在 editor 外的 overlay
      const visitBtn = target.closest?.("button, [role='button']");
      if (visitBtn) {
        const tip =
          visitBtn.getAttribute("aria-label") ||
          visitBtn.getAttribute("title") ||
          visitBtn.textContent ||
          "";
        if (/访问链接|浏览器访问|Visit link|Open in browser/i.test(tip)) {
          const field =
            document.querySelector<HTMLInputElement>(".ne-link-editor input") ||
            document.querySelector<HTMLInputElement>(".ne-link-editor-field input");
          const fromField = field?.value?.trim();
          const fromLink = readLakeLinkHref(
            root.querySelector("ne-link") ||
              document.querySelector("ne-link.ne-active, ne-link:hover, a.ne-link"),
            null,
          );
          const raw = fromField || fromLink;
          if (raw && normalizeLakeExternalUrl(raw)) {
            event.preventDefault();
            event.stopPropagation();
            openInSystemBrowser(raw);
            return;
          }
        }
      }

      if (!insideEditor) return;
      const href = readLakeLinkHref(target, root);
      if (!href || !normalizeLakeExternalUrl(href)) return;
      event.preventDefault();
      event.stopPropagation();
      openInSystemBrowser(href);
    };

    root.addEventListener("click", onClick, true);
    document.addEventListener("click", onClick, true);
    return () => {
      root.removeEventListener("click", onClick, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [ready]);

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

  const refreshLinkHint = useCallback((md: string) => {
    setLinkHint(extractWikilinkTargets(md).length);
  }, []);

  const handleChange = useCallback(() => {
    onDirtyChange?.(true);
    const md = readMarkdown();
    refreshLinkHint(md);
    const q = readTrailingWikilinkQuery(md);
    if (q == null) {
      if (completeOpenRef.current) {
        completeOpenRef.current = false;
        wikiUiRef.current = null;
        setWikiUi((prev) => (prev?.mode === "complete" ? null : prev));
      }
      return;
    }
    // 正文末尾出现未闭合 [[… 时，在编辑器右下角弹出补全
    const rect = rootRef.current?.getBoundingClientRect();
    const left = Math.min((rect?.left ?? 24) + 24, window.innerWidth - 320);
    const top = Math.min((rect?.bottom ?? 200) - 360, window.innerHeight - 360);
    completeOpenRef.current = true;
    const next: WikiUi = {
      mode: "complete",
      query: q,
      left: Math.max(12, left),
      top: Math.max(12, top),
    };
    wikiUiRef.current = next;
    setWikiUi(next);
  }, [onDirtyChange, readMarkdown, refreshLinkHint]);

  const openInsertPicker = () => {
    completeOpenRef.current = false;
    const next: WikiUi = { mode: "insert", query: "" };
    wikiUiRef.current = next;
    setWikiUi(next);
  };

  const closeWiki = () => {
    completeOpenRef.current = false;
    wikiUiRef.current = null;
    setWikiUi(null);
  };

  const pickWiki = (title: string) => {
    const name = title.trim() || "笔记名";
    const mode = wikiUiRef.current?.mode === "complete" ? "complete" : "insert";
    // 先关弹层，避免焦点还在搜索框时命令写丢
    closeWiki();
    window.setTimeout(() => {
      const ok = writeWikilink(name, mode);
      onDirtyChange?.(true);
      window.setTimeout(() => {
        const md = readMarkdown();
        refreshLinkHint(md);
        const hit = extractWikilinkTargets(md).some((t) => t.toLowerCase() === name.toLowerCase());
        if (ok && hit) {
          setFlash(`已写入 [[${name}]]`);
        } else if (ok) {
          // setContent 后引擎可能尚未完成导出，再强制写一次
          writeWikilink(name, "insert");
          const md2 = readMarkdown();
          refreshLinkHint(md2);
          setFlash(
            extractWikilinkTargets(md2).some((t) => t.toLowerCase() === name.toLowerCase())
              ? `已写入 [[${name}]]`
              : `已尝试写入 [[${name}]]，请保存后到关系图确认`,
          );
        } else {
          setFlash("写入失败，请重试或改用 Markdown 模式");
        }
        window.setTimeout(() => setFlash(null), 3200);
      }, 120);
    }, 30);
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <div className={styles.wikiBar}>
        <button type="button" className={styles.wikiBtn} onClick={openInsertPicker} disabled={!ready}>
          <span className={styles.wikiBtnGlyph}>[[</span>
          插入双链
        </button>
        <span className={`${styles.wikiBarHint}${flash ? ` ${styles.wikiBarHintFlash}` : ""}`}>
          {flash
            ? flash
            : linkHint > 0
              ? `已写入 ${linkHint} 条双链 · 保存后可在关系图查看`
              : "点按钮插入双链（会写入正文末尾）"}
        </span>
      </div>

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
          onLoad={() => {
            onLoaded();
            window.setTimeout(() => refreshLinkHint(readMarkdown()), 100);
          }}
          onChange={handleChange}
          onError={(err) => console.error("[lake-editor]", err)}
        />
      </div>

      <LakeWikiPicker
        open={wikiUi != null}
        query={wikiUi?.query ?? ""}
        notes={wikiNotes}
        mode={wikiUi?.mode === "complete" ? "complete" : "insert"}
        onQueryChange={(q) =>
          setWikiUi((prev) => {
            const next = prev ? { ...prev, query: q } : { mode: "insert" as const, query: q };
            wikiUiRef.current = next;
            return next;
          })
        }
        onPick={pickWiki}
        onClose={closeWiki}
        anchorLeft={wikiUi?.mode === "complete" ? wikiUi.left : undefined}
        anchorTop={wikiUi?.mode === "complete" ? wikiUi.top : undefined}
      />
    </div>
  );
});
