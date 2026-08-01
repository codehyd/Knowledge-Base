import { useEffect, useRef, useState } from "react";
import { App, Button, Modal, Space, Typography } from "antd";
import { api } from "@/shared/api/client";
import { formatError } from "@/shared/ui/feedback";
import { AnnotationSidebar } from "./AnnotationSidebar";
import {
  DraftNoteModal,
  EditAnnotationModal,
  SelectionPopup,
  StackPopup,
} from "./AnnotationPopups";
import { PreviewBody } from "./PreviewBody";
import { PreviewToolbar } from "./PreviewToolbar";
import { buildHighlightedHtml, isChatAnchor } from "./previewHighlight";
import { readStoredFontSize, readStoredFontWeight } from "./previewProgress";
import type { PreviewSegment, PreviewSearchPage } from "./types";
import { PAD, usePreviewLoader } from "./usePreviewLoader";
import { PAGE_SIZE, usePreviewSearch } from "./usePreviewSearch";
import { usePreviewAnnotations } from "./usePreviewAnnotations";
import styles from "./TextPreviewModal.module.css";

export type { PreviewSegment, PreviewSearchHit, PreviewSearchPage } from "./types";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  loadSegment: (offset: number, limit: number) => Promise<PreviewSegment>;
  searchAll: (
    query: string,
    params?: { offset?: number; limit?: number },
  ) => Promise<PreviewSearchPage>;
  entryId?: number | null;
  sourceId?: number | null;
  initialQuery?: string;
  initialOffset?: number | null;
  initialAnnotationId?: number | null;
};

export function TextPreviewModal({
  open,
  title,
  onClose,
  loadSegment,
  searchAll,
  entryId = null,
  sourceId = null,
  initialQuery = "",
  initialOffset = null,
  initialAnnotationId = null,
}: Props) {
  const { message } = App.useApp();
  const [fontSize, setFontSize] = useState(() => readStoredFontSize());
  const [fontWeight, setFontWeight] = useState(() => readStoredFontWeight());

  const setActiveQueryRef = useRef<(query: string) => void>(() => {});
  const setActiveAnnIdRef = useRef<(id: number) => void>(() => {});

  const loader = usePreviewLoader(loadSegment, message, sourceId, entryId, {
    setActiveQuery: (q) => setActiveQueryRef.current(q),
    setActiveAnnId: (id) => setActiveAnnIdRef.current(id),
  });
  const loaderRefs = {
    bodyRef: loader.bodyRef,
    baseOffsetRef: loader.baseOffsetRef,
    segmentRef: loader.segmentRef,
    loadAt: loader.loadAt,
  };
  const search = usePreviewSearch(searchAll, message, loaderRefs);
  const ann = usePreviewAnnotations(entryId, message, loaderRefs);

  setActiveQueryRef.current = search.setActiveQuery;
  setActiveAnnIdRef.current = ann.setActiveAnnId;

  useEffect(() => {
    if (!open) return;
    loader.initProgressKey();
    loader.setResumedHint(false);
    search.resetSearch();
    loader.setEdgeHint(null);
    ann.resetAnnotations();

    const focusQ = (initialQuery || "").replace(/…/g, " ").replace(/\s+/g, " ").trim();
    const focusOffset =
      initialOffset != null && Number.isFinite(initialOffset) && initialOffset >= 0
        ? Math.floor(initialOffset)
        : null;
    const focusAnnId =
      initialAnnotationId != null &&
      Number.isFinite(initialAnnotationId) &&
      initialAnnotationId > 0
        ? Math.floor(initialAnnotationId)
        : null;

    if (focusAnnId != null || focusOffset != null || focusQ) {
      loader.suppressProgressRef.current = false;
      if (focusQ) search.setQuery(focusQ);
      void (async () => {
        search.setSearching(true);
        try {
          if (focusAnnId != null && ann.notesEnabled && entryId != null) {
            try {
              const res = await api.listAnnotations(entryId);
              const items = res.items || [];
              ann.setAnnotations(items);
              const found = items.find((a) => a.id === focusAnnId);
              if (found) {
                ann.setActiveAnnId(found.id);
                ann.setNoteTab(isChatAnchor(found) ? "anchor" : "note");
                await ann.jumpToAnnotation(found);
                return;
              }
            } catch {
              /* 回退到偏移/搜索 */
            }
          }

          if (focusOffset != null) {
            const q = focusQ;
            if (q) {
              search.setActiveQuery(q);
              search.setQuery(q);
            }
            await loader.loadAt(Math.max(0, focusOffset - PAD), {
              highlightOffset: q ? focusOffset : undefined,
              highlightQuery: q || undefined,
              preserve: q ? "none" : "anchor",
              anchorChar: focusOffset,
            });
            if (q) {
              const res = await searchAll(q, { offset: 0, limit: PAGE_SIZE });
              search.setHits(res.hits);
              search.setHitTotal(res.total);
              search.setPageOffset(res.offset);
              search.setActiveQuery(q);
              if (res.hits.length) {
                const near =
                  res.hits.find((h) => Math.abs(h.offset - focusOffset) <= 120) ||
                  res.hits[0];
                const idx = Math.max(0, res.hits.indexOf(near));
                search.setLocalIndex(idx);
                if (Math.abs(near.offset - focusOffset) > 12) {
                  await loader.loadAt(Math.max(0, near.offset - PAD), {
                    highlightOffset: near.offset,
                    highlightQuery: q,
                    preserve: "none",
                  });
                }
              }
            }
            return;
          }

          let q = focusQ;
          let res = await searchAll(q, { offset: 0, limit: PAGE_SIZE });
          if (!res.hits.length && q.length > 16) {
            for (const len of [48, 36, 24, 16, 10]) {
              if (q.length <= len) continue;
              q = focusQ.slice(0, len).trim();
              if (q.length < 2) break;
              res = await searchAll(q, { offset: 0, limit: PAGE_SIZE });
              if (res.hits.length) break;
            }
          }
          if (!res.hits.length) {
            const parts = focusQ
              .split(/\s+/)
              .map((p) => p.trim())
              .filter((p) => p.length >= 4)
              .sort((a, b) => b.length - a.length);
            for (const part of parts.slice(0, 5)) {
              const probe = part.slice(0, 60);
              res = await searchAll(probe, { offset: 0, limit: PAGE_SIZE });
              if (res.hits.length) {
                q = probe;
                break;
              }
            }
          }
          search.setHits(res.hits);
          search.setHitTotal(res.total);
          search.setPageOffset(res.offset);
          search.setActiveQuery(q);
          search.setQuery(q);
          if (!res.hits.length) {
            search.setLocalIndex(-1);
            await loader.loadAt(0, { preserve: "top", highlightQuery: q });
            message.warning("未能定位到引用原文，已打开全文，可在上方搜索框改关键词");
            return;
          }
          const hit = res.hits[0];
          search.setLocalIndex(0);
          await loader.loadAt(Math.max(0, hit.offset - PAD), {
            highlightOffset: hit.offset,
            highlightQuery: q,
            preserve: "none",
          });
        } catch (err) {
          message.error(formatError(err, "定位引用失败"));
          void loader.loadAt(0, { preserve: "top" });
        } finally {
          search.setSearching(false);
        }
      })();
    } else {
      loader.restoreSavedProgress();
    }

    if (ann.notesEnabled) {
      void ann.refreshAnnotations().catch((err) => {
        message.error(formatError(err, "加载笔记失败"));
      });
    } else {
      ann.setAnnotations([]);
    }

    return () => {
      loader.cleanupProgress();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entryId, sourceId, initialQuery, initialOffset, initialAnnotationId]);

  const html = buildHighlightedHtml(
    loader.segment,
    loader.baseOffset,
    search.activeQuery,
    search.localIndex >= 0 && search.hits[search.localIndex]
      ? search.hits[search.localIndex].offset
      : null,
    ann.annotations,
    ann.activeAnnId,
    ann.pendingSel,
    ann.editOpen || ann.reselectMode ? ann.editRange : null,
    ann.editOpen || ann.reselectMode ? ann.editColor : null,
    ann.showHighlights,
    ann.activeAnnId != null && (ann.editOpen || ann.reselectMode),
  );

  const endPos = loader.baseOffset + loader.segment.length;
  const canUp = loader.baseOffset > 0;
  const canDown = endPos < loader.charCount;

  return (
    <>
      <Modal
        title={title || "正文预览"}
        open={open}
        onCancel={() => loader.handleClose(onClose)}
        width={ann.notesEnabled ? 980 : 820}
        destroyOnHidden
        footer={
          <Space wrap>
            <Typography.Text type="secondary" className={styles.scrollTip}>
              {ann.notesEnabled ? "划选记笔记 · 双击高亮查看 · 叠层单击选择 · " : ""}
              滚到顶部/底部可自动加载
              {loader.progressKeyRef.current ? " · 自动记住阅读位置" : ""}
            </Typography.Text>
            <Button type="primary" onClick={() => loader.handleClose(onClose)}>
              关闭
            </Button>
          </Space>
        }
      >
        <PreviewToolbar
          query={search.query}
          onQueryChange={search.setQuery}
          onSearch={() => void search.runSearch()}
          searching={search.searching}
          hitTotal={search.hitTotal}
          globalIndex={search.globalIndex}
          activeQuery={search.activeQuery}
          onGoHit={(delta) => void search.goHit(delta)}
          fontSize={fontSize}
          fontWeight={fontWeight}
          onFontSizeChange={setFontSize}
          onFontWeightChange={setFontWeight}
        />

        <PreviewBody
          bodyRef={loader.bodyRef}
          html={html}
          fontSize={fontSize}
          fontWeight={fontWeight}
          reselectMode={ann.reselectMode}
          loading={loader.loading}
          edgeHint={loader.edgeHint}
          canUp={canUp}
          canDown={canDown}
          notesEnabled={ann.notesEnabled}
          currentPage={loader.currentPage}
          totalPages={loader.totalPages}
          charCount={loader.charCount}
          userNotesCount={ann.userNotes.length}
          chatAnchorsCount={ann.chatAnchors.length}
          resumedHint={loader.resumedHint}
          hits={search.hits}
          pageOffset={search.pageOffset}
          globalIndex={search.globalIndex}
          onScroll={() =>
            loader.onBodyScroll(() => {
              ann.dismissPendingIfIdle();
              ann.setStackPopup(null);
            })
          }
          onMouseUp={ann.onBodyMouseUp}
          onClick={ann.onBodyClick}
          onDoubleClick={ann.onBodyDoubleClick}
          onCancelReselect={ann.cancelReselectMode}
          onJumpToHit={(hit, i) => void search.jumpToHit(hit, i)}
        >
          {ann.notesEnabled && (
            <AnnotationSidebar
              noteTab={ann.noteTab}
              onNoteTabChange={ann.setNoteTab}
              showHighlights={ann.showHighlights}
              onShowHighlightsChange={ann.setShowHighlights}
              userNotesCount={ann.userNotes.length}
              chatAnchorsCount={ann.chatAnchors.length}
              paneNotes={ann.paneNotes}
              activeAnnId={ann.activeAnnId}
              onFocusAnnotation={(a) => void ann.focusAnnotation(a)}
              onScroll={ann.dismissPendingIfIdle}
            />
          )}
        </PreviewBody>
      </Modal>

      {ann.stackPopup && (
        <StackPopup
          stackPopup={ann.stackPopup}
          stackPopupItems={ann.stackPopupItems}
          onOpenAnnotation={ann.openAnnotationDetail}
          onClose={() => ann.setStackPopup(null)}
        />
      )}

      {ann.pendingSel && !ann.draftOpen && !ann.reselectMode && !ann.editOpen && (
        <SelectionPopup
          pendingSel={ann.pendingSel}
          saving={ann.saving && !ann.draftOpen}
          onConfirmHighlight={() => void ann.confirmHighlight()}
          onOpenNoteDraft={ann.openNoteDraft}
          onClearPending={ann.clearPendingSel}
          onColorChange={ann.setPendingColor}
        />
      )}

      <DraftNoteModal
        open={ann.draftOpen}
        draftSel={ann.draftSel}
        draftNote={ann.draftNote}
        draftColor={ann.draftColor}
        saving={ann.saving}
        onCancel={() => {
          ann.setDraftOpen(false);
          ann.setDraftSel(null);
        }}
        onSave={() => {
          if (!ann.draftSel) return;
          void ann.saveAnnotation({
            start: ann.draftSel.start,
            end: ann.draftSel.end,
            quote: ann.draftSel.quote,
            note: ann.draftNote,
            color: ann.draftColor,
          });
        }}
        onDraftNoteChange={ann.setDraftNote}
        onDraftColorChange={ann.setDraftColor}
        onPendingColorChange={ann.setPendingColor}
      />

      <EditAnnotationModal
        open={ann.editOpen}
        editAnn={ann.editAnn}
        editNote={ann.editNote}
        editColor={ann.editColor}
        editRange={ann.editRange}
        saving={ann.saving}
        onCancel={() => {
          ann.setEditOpen(false);
          ann.setEditAnn(null);
          ann.setEditRange(null);
          ann.setReselectMode(false);
          ann.setActiveAnnId(null);
        }}
        onSave={() => void ann.saveEdit()}
        onSaveAndClose={() => void ann.saveEdit()}
        onDelete={() => ann.editAnn && void ann.removeAnn(ann.editAnn.id)}
        onPromote={() => void ann.promoteAnn()}
        onBeginReselect={ann.beginReselectRange}
        onClearEditRange={() => ann.setEditRange(null)}
        onEditNoteChange={ann.setEditNote}
        onEditColorChange={ann.setEditColor}
      />
    </>
  );
}
