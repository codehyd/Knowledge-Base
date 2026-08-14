import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import {
  BoldOutlined,
  CheckSquareOutlined,
  CodeOutlined,
  ColumnWidthOutlined,
  EditOutlined,
  EyeOutlined,
  FontSizeOutlined,
  ItalicOutlined,
  LinkOutlined,
  MinusOutlined,
  OrderedListOutlined,
  PictureOutlined,
  StrikethroughOutlined,
  TableOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { App, Button, Tooltip } from "antd";
import { api } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { hasMark, rewriteMarkdownImagesForEditor, rewriteMarkdownImagesForSave, toEditorImageSrc } from "@/shared/editor-extensions";
import { MarkdownView } from "@/shared/ui/markdown/MarkdownView";
import { listSlashCommands, parseSlashInsert, setSlashRuntime, type MarkdownHost, type SlashCommandItem } from "./slashCommands";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { WikilinkSuggest, type WikilinkSuggestState } from "./wikilink/WikilinkSuggest";
import { headingMatches } from "./wikilink/parse";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
import { livePreview } from "./livePreview";
import styles from "./MarkdownEditor.module.css";

export type MarkdownEditorHandle = {
  getMarkdown: () => string;
  focus: () => void;
  setMarkdown: (md: string) => void;
  insertWikilink: (label: string) => void;
  scrollToHeading: (heading: string) => boolean;
};

type Props = {
  initialMarkdown?: string;
  placeholder?: string;
  dirty?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSave?: () => void | Promise<void>;
  saving?: boolean;
  excludeSourceId?: number | null;
  initialHeading?: string | null;
};

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

type ViewMode = "source" | "split" | "preview";

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", color: "#0f172a" },
  { tag: t.heading2, fontWeight: "700", color: "#1e293b" },
  { tag: t.heading3, fontWeight: "650", color: "#334155" },
  { tag: t.heading4, fontWeight: "650", color: "#475569" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "#0f766e" },
  { tag: t.monospace, color: "#0f766e" },
  { tag: t.meta, color: "#94a3b8" },
  { tag: t.processingInstruction, color: "#94a3b8" },
  { tag: t.quote, color: "#64748b", fontStyle: "italic" },
]);

function readViewMode(): ViewMode {
  try {
    const v = localStorage.getItem("kk-note-view-v2");
    if (v === "source" || v === "split" || v === "preview") return v;
  } catch {
    /* ignore */
  }
  return "source";
}

function lineBefore(view: EditorView) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  return { pos, line, before: line.text.slice(0, pos - line.from) };
}

function replaceRange(view: EditorView, from: number, to: number, insert: string) {
  const parsed = parseSlashInsert(insert);
  view.dispatch({
    changes: { from, to, insert: parsed.insert },
    selection: { anchor: from + parsed.anchor, head: from + parsed.head },
    scrollIntoView: true,
  });
  view.focus();
}

function findSlashRange(view: EditorView): { from: number; to: number } | null {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, Math.max(0, pos - line.from));
  const hit = /(?:^|\s)(\/[^\s]*)$/.exec(before);
  if (hit) return { from: pos - hit[1].length, to: pos };
  if (line.number > 1 && pos === line.from) {
    const prev = view.state.doc.line(line.number - 1);
    const hit2 = /(?:^|\s)(\/[^\s]*)$/.exec(prev.text);
    if (hit2) return { from: prev.to - hit2[1].length, to: pos };
  }
  return null;
}

function wrapSelection(view: EditorView, before: string, after = before) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.doc.sliceString(from, to);
  const insert = `${before}${selected}${after}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: selected
      ? { anchor: from + before.length, head: from + before.length + selected.length }
      : { anchor: from + before.length },
    scrollIntoView: true,
  });
  view.focus();
}

const MarkdownEditorBody = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditorBody(
  {
    initialMarkdown = "",
    placeholder = "输入正文，或按 / 插入块；[[ 笔记 或 笔记#标题…",
    dirty = false,
    onDirtyChange,
    onSave,
    saving = false,
    excludeSourceId = null,
    initialHeading = null,
  },
  ref,
) {
  const { message } = App.useApp();
  const hostElRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef(onSave);
  const onDirtyRef = useRef(onDirtyChange);
  const sourceIdRef = useRef(excludeSourceId);
  onSaveRef.current = onSave;
  onDirtyRef.current = onDirtyChange;
  sourceIdRef.current = excludeSourceId;

  const [toolbarOpen, setToolbarOpen] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [previewMd, setPreviewMd] = useState(initialMarkdown);
  const [slash, setSlash] = useState<{
    query: string;
    left: number;
    caretTop: number;
    caretBottom: number;
  } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [wikiSuggest, setWikiSuggest] = useState<WikilinkSuggestState | null>(null);
  const enableWikilink = hasMark("wikilink");
  const mod = useMemo(() => (isMac() ? "⌘" : "Ctrl"), []);
  const scanMenusRef = useRef<(view: EditorView) => void>(() => undefined);
  const setPreviewMdRef = useRef(setPreviewMd);
  const slashRef = useRef(slash);
  const slashIndexRef = useRef(slashIndex);
  const slashQueryRef = useRef("");
  const hostApiRef = useRef<() => MarkdownHost>(() => ({
    replaceSlash() {},
    insert() {},
    wrap() {},
    startWikilink() {},
  }));
  const runSlashRef = useRef<() => boolean>(() => false);
  setPreviewMdRef.current = setPreviewMd;
  slashRef.current = slash;
  slashIndexRef.current = slashIndex;

  const uploadImage = useCallback(
    async (file: File) => {
      const id = sourceIdRef.current;
      if (id == null) {
        message.warning("请先保存笔记再插入图片");
        return null;
      }
      try {
        const res = await api.uploadVaultAsset(id, file);
        return toEditorImageSrc(res.path);
      } catch (err) {
        message.error(formatError(err, "图片上传失败"));
        return null;
      }
    },
    [message],
  );

  useEffect(() => {
    setSlashRuntime({ sourceId: excludeSourceId, uploadImage });
  }, [excludeSourceId, uploadImage]);

  const scanMenus = useCallback(
    (view: EditorView) => {
      const { pos, before } = lineBefore(view);
      const slashHit = /(?:^|\s)\/([^\s]*)$/.exec(before);
      if (slashHit) {
        const query = slashHit[1] || "";
        const coords = view.coordsAtPos(pos);
        setWikiSuggest(null);
        setSlash({
          query,
          left: coords?.left ?? 24,
          caretTop: coords?.top ?? 80,
          caretBottom: coords?.bottom ?? 80,
        });
        if (query !== slashQueryRef.current) setSlashIndex(0);
        slashQueryRef.current = query;
        return;
      }
      slashQueryRef.current = "";
      setSlash(null);
      if (!enableWikilink) {
        setWikiSuggest(null);
        return;
      }
      const wikiHit = /\[\[([^\]\n]*)$/.exec(before);
      if (!wikiHit) {
        setWikiSuggest(null);
        return;
      }
      const coords = view.coordsAtPos(pos);
      setWikiSuggest({
        active: true,
        query: wikiHit[1] || "",
        from: pos - wikiHit[0].length,
        to: pos,
        left: Math.min(coords?.left ?? 24, window.innerWidth - 320),
        top: Math.min((coords?.bottom ?? 80) + 6, window.innerHeight - 280),
      });
    },
    [enableWikilink],
  );
  scanMenusRef.current = scanMenus;

  const applyViewMode = useCallback((mode: ViewMode) => {
    setPreviewMd(viewRef.current?.state.doc.toString() || "");
    setViewMode(mode);
    try {
      localStorage.setItem("kk-note-view-v2", mode);
    } catch {
      /* ignore */
    }
    if (mode !== "preview") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => viewRef.current?.requestMeasure());
      });
    }
  }, []);

  const hostApi = useCallback((): MarkdownHost => {
    return {
      replaceSlash(text: string) {
        const view = viewRef.current;
        if (!view) return;
        const range = findSlashRange(view);
        const pos = view.state.selection.main.head;
        if (!range) {
          replaceRange(view, pos, pos, text);
          return;
        }
        replaceRange(view, range.from, range.to, text);
      },
      insert(text: string) {
        const view = viewRef.current;
        if (!view) return;
        const pos = view.state.selection.main.head;
        replaceRange(view, pos, pos, text);
      },
      wrap(before, after) {
        const view = viewRef.current;
        if (!view) return;
        wrapSelection(view, before, after ?? before);
      },
      startWikilink() {
        const view = viewRef.current;
        if (!view) return;
        const pos = view.state.selection.main.head;
        replaceRange(view, pos, pos, "[[");
        scanMenus(view);
      },
    };
  }, [scanMenus]);
  hostApiRef.current = hostApi;
  runSlashRef.current = () => {
    const s = slashRef.current;
    if (!s) return false;
    const items = listSlashCommands(s.query);
    const item = items[slashIndexRef.current];
    if (!item) return false;
    slashRef.current = null;
    slashQueryRef.current = "";
    setSlash(null);
    item.run(hostApiRef.current());
    return true;
  };

  useEffect(() => {
    const parent = hostElRef.current;
    if (!parent) return;
    let ready = false;
    let previewTimer = 0;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: rewriteMarkdownImagesForEditor(initialMarkdown || ""),
        extensions: [
          history(),
          markdown({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false }),
          syntaxHighlighting(mdHighlight),
          livePreview,
          cmPlaceholder(placeholder),
          Prec.highest(
            keymap.of([
              {
                key: "Enter",
                run: () => runSlashRef.current(),
              },
              {
                key: "Tab",
                run: () => runSlashRef.current(),
              },
              {
                key: "ArrowDown",
                run: () => {
                  if (!slashRef.current) return false;
                  const items = listSlashCommands(slashRef.current.query);
                  setSlashIndex((i) => (items.length ? (i + 1) % items.length : 0));
                  return true;
                },
              },
              {
                key: "ArrowUp",
                run: () => {
                  if (!slashRef.current) return false;
                  const items = listSlashCommands(slashRef.current.query);
                  setSlashIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
                  return true;
                },
              },
              {
                key: "Escape",
                run: () => {
                  if (!slashRef.current) return false;
                  slashRef.current = null;
                  slashQueryRef.current = "";
                  setSlash(null);
                  return true;
                },
              },
            ]),
          ),
          Prec.high(keymap.of(markdownKeymap)),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                void onSaveRef.current?.();
                return true;
              },
            },
            {
              key: "Mod-b",
              run: (v) => {
                wrapSelection(v, "**");
                return true;
              },
            },
            {
              key: "Mod-i",
              run: (v) => {
                wrapSelection(v, "*");
                return true;
              },
            },
            {
              key: "Mod-k",
              run: (v) => {
                wrapSelection(v, "[", "](https://)");
                return true;
              },
            },
            indentWithTab,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged && ready) onDirtyRef.current?.(true);
            if (u.docChanged || u.selectionSet) scanMenusRef.current(u.view);
            if (u.docChanged) {
              window.clearTimeout(previewTimer);
              previewTimer = window.setTimeout(() => {
                setPreviewMdRef.current(u.view.state.doc.toString());
              }, 140);
            }
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "16px", backgroundColor: "transparent" },
            ".cm-scroller": {
              fontFamily: 'ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
              lineHeight: "1.75",
            },
            ".cm-content": { padding: "28px 40px 96px", caretColor: "#0f172a", maxWidth: "46rem", margin: "0 auto" },
            ".cm-gutters": { display: "none" },
            "&.cm-focused": { outline: "none" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    setPreviewMdRef.current(view.state.doc.toString());
    const boot = window.requestAnimationFrame(() => {
      ready = true;
      if (initialHeading?.trim()) {
        const needle = initialHeading.trim();
        const doc = view.state.doc;
        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          const title = line.text.replace(/^#{1,6}\s+/, "").trim();
          if (headingMatches(needle, title) || headingMatches(needle, line.text)) {
            view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
            break;
          }
        }
      }
      view.focus();
    });
    return () => {
      window.cancelAnimationFrame(boot);
      window.clearTimeout(previewTimer);
      view.destroy();
      viewRef.current = null;
    };
    // parent remounts via key=note id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () =>
        rewriteMarkdownImagesForSave(viewRef.current?.state.doc.toString() ?? initialMarkdown ?? ""),
      focus: () => viewRef.current?.focus(),
      setMarkdown: (md: string) => {
        const view = viewRef.current;
        if (!view) return;
        const next = rewriteMarkdownImagesForEditor(md || "");
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
        });
        setPreviewMdRef.current(next);
      },
      insertWikilink: (label: string) => {
        const view = viewRef.current;
        if (!view) return;
        const pos = view.state.selection.main.head;
        replaceRange(view, pos, pos, `[[${(label || "笔记名").trim()}]]`);
      },
      scrollToHeading: (heading: string) => {
        const view = viewRef.current;
        if (!view || !heading.trim()) return false;
        const doc = view.state.doc;
        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          const title = line.text.replace(/^#{1,6}\s+/, "").trim();
          if (headingMatches(heading, title) || headingMatches(heading, line.text)) {
            view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
            return true;
          }
        }
        return false;
      },
    }),
    [initialMarkdown],
  );

  useEffect(() => {
    if (!slash && !wikiSuggest?.active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        slashRef.current = null;
        slashQueryRef.current = "";
        setSlash(null);
        setWikiSuggest(null);
        return;
      }
      if (!slashRef.current) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
      }
      const items = listSlashCommands(slashRef.current.query);
      if (event.key === "ArrowDown") {
        setSlashIndex((i) => (items.length ? (i + 1) % items.length : 0));
      } else if (event.key === "ArrowUp") {
        setSlashIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
      } else if ((event.key === "Enter" || event.key === "Tab") && items.length) {
        runSlashRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [slash, wikiSuggest]);

  const btn = (tip: string, onClick: () => void, icon: ReactNode) => (
    <Tooltip title={tip}>
      <Button type="text" size="small" className={styles.toolbarBtn} icon={icon} onClick={onClick} />
    </Tooltip>
  );

  const withView = (fn: (view: EditorView) => void) => {
    const view = viewRef.current;
    if (view) fn(view);
  };

  const showSource = viewMode !== "preview";
  const showPreview = viewMode !== "source";
  const previewEmpty = !previewMd.trim();

  const viewBtn = (mode: ViewMode, tip: string, icon: ReactNode) => (
    <Tooltip title={tip}>
      <Button
        type="text"
        size="small"
        className={`${styles.toolbarBtn}${viewMode === mode ? ` ${styles.toolbarBtnActive}` : ""}`}
        icon={icon}
        onClick={() => applyViewMode(mode)}
      />
    </Tooltip>
  );

  return (
    <div className={styles.root}>
      <div className={styles.chrome}>
        <div className={`${styles.toolbarDock}${toolbarOpen ? ` ${styles.toolbarDockOpen}` : ""}`}>
          {btn(`${mod}+B 加粗`, () => withView((v) => wrapSelection(v, "**")), <BoldOutlined />)}
          {btn(`${mod}+I 斜体`, () => withView((v) => wrapSelection(v, "*")), <ItalicOutlined />)}
          {btn("删除线", () => withView((v) => wrapSelection(v, "~~")), <StrikethroughOutlined />)}
          {btn("行内代码", () => withView((v) => wrapSelection(v, "`")), <CodeOutlined />)}
          <span className={styles.sep} />
          {btn("无序列表", () => withView((v) => wrapSelection(v, "- ", "")), <UnorderedListOutlined />)}
          {btn("有序列表", () => withView((v) => wrapSelection(v, "1. ", "")), <OrderedListOutlined />)}
          {btn("任务", () => withView((v) => wrapSelection(v, "- [ ] ", "")), <CheckSquareOutlined />)}
          <span className={styles.sep} />
          {btn(`${mod}+K 链接`, () => withView((v) => wrapSelection(v, "[", "](https://)")), <LinkOutlined />)}
          {btn("分割线", () => hostApi().insert("\n---\n"), <MinusOutlined />)}
          {btn("表格", () => hostApi().insert(`\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n`), <TableOutlined />)}
          {btn("图片", () => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/png,image/jpeg,image/gif,image/webp";
            input.onchange = () => {
              const file = input.files?.[0];
              if (!file) return;
              void uploadImage(file).then((src) => {
                if (src) hostApi().insert(`![图片](${src})`);
              });
            };
            input.click();
          }, <PictureOutlined />)}
        </div>
        <div className={styles.chromeRight}>
          <div className={styles.viewSwitch} role="group" aria-label="视图">
            {viewBtn("source", "编辑（边写边排版）", <EditOutlined />)}
            {viewBtn("split", "源码 | 预览", <ColumnWidthOutlined />)}
            {viewBtn("preview", "阅读", <EyeOutlined />)}
          </div>
          <Tooltip title={toolbarOpen ? "收起格式工具栏" : "格式工具栏"}>
            <Button
              type="text"
              size="small"
              className={`${styles.toolbarToggle}${toolbarOpen ? ` ${styles.toolbarToggleActive}` : ""}`}
              icon={<FontSizeOutlined />}
              onClick={() => setToolbarOpen((v) => !v)}
            />
          </Tooltip>
        </div>
      </div>

      <div className={`${styles.editorWrap} ${styles[`mode_${viewMode}`]}`}>
        <div className={styles.sourcePane} data-visible={showSource ? "true" : "false"}>
          {viewMode === "split" ? <div className={styles.paneLabel}>编辑</div> : null}
          <div ref={hostElRef} className={styles.cmHost} data-placeholder={placeholder} />
        </div>
        <div className={styles.previewPane} data-visible={showPreview ? "true" : "false"}>
          {viewMode === "split" ? <div className={styles.paneLabel}>预览</div> : null}
          <div className={styles.previewBody}>
            {previewEmpty ? (
              <p className={styles.previewEmpty}>
                {viewMode === "preview" ? "这篇笔记还是空的" : "在左侧输入 Markdown，这里会实时渲染"}
              </p>
            ) : (
              <MarkdownView content={previewMd} className={styles.previewMd} />
            )}
          </div>
        </div>
        {slash && !wikiSuggest?.active && showSource ? (
          <SlashCommandMenu
            query={slash.query}
            left={slash.left}
            caretTop={slash.caretTop}
            caretBottom={slash.caretBottom}
            selectedIndex={slashIndex}
            onSelectedIndexChange={setSlashIndex}
            onRun={(item: SlashCommandItem) => {
              slashRef.current = null;
              slashQueryRef.current = "";
              item.run(hostApi());
            }}
            onClose={() => setSlash(null)}
          />
        ) : null}
        {wikiSuggest?.active && showSource ? (
          <WikilinkSuggest
            state={wikiSuggest}
            excludeSourceId={excludeSourceId}
            onClose={() => setWikiSuggest(null)}
            onPick={(label) => {
              const view = viewRef.current;
              if (!view) return;
              replaceRange(view, wikiSuggest.from, wikiSuggest.to, `[[${label}]]`);
            }}
          />
        ) : null}
      </div>

      <div className={styles.footer}>
        <span className={dirty ? styles.saveStateDirty : undefined}>
          {dirty ? (saving ? "保存中…" : "未保存") : "已保存"}
        </span>
        <span className={styles.footerHint}>{mod}+S 保存 · `/` 插入 · `[[` 笔记 · 回车延续列表</span>
      </div>
    </div>
  );
});

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(props, ref) {
  return (
    <EditorErrorBoundary>
      <MarkdownEditorBody {...props} ref={ref} />
    </EditorErrorBoundary>
  );
});
