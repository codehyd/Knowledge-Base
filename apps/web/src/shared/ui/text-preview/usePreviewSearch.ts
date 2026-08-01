import { useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { MessageInstance } from "antd/es/message/interface";
import { formatError } from "@/shared/ui/feedback";
import type { PreviewSearchHit, PreviewSearchPage } from "./types";
import { PAD, type LoadAtOptions } from "./usePreviewLoader";

export const PAGE_SIZE = 100;

type SearchAll = (
  query: string,
  params?: { offset?: number; limit?: number },
) => Promise<PreviewSearchPage>;

type LoaderRefs = {
  bodyRef: RefObject<HTMLDivElement | null>;
  baseOffsetRef: MutableRefObject<number>;
  segmentRef: MutableRefObject<string>;
  loadAt: (offset: number, options?: LoadAtOptions) => Promise<LoadAtOptions | undefined>;
};

export function usePreviewSearch(searchAll: SearchAll, message: MessageInstance, loader: LoaderRefs) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PreviewSearchHit[]>([]);
  const [hitTotal, setHitTotal] = useState(0);
  const [pageOffset, setPageOffset] = useState(0);
  const [localIndex, setLocalIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [activeQuery, setActiveQuery] = useState("");

  const globalIndex = localIndex >= 0 ? pageOffset + localIndex : -1;

  function resetSearch() {
    setQuery("");
    setHits([]);
    setHitTotal(0);
    setPageOffset(0);
    setLocalIndex(-1);
    setActiveQuery("");
  }

  async function fetchHitPage(q: string, offset: number) {
    const res = await searchAll(q, { offset, limit: PAGE_SIZE });
    setHits(res.hits);
    setHitTotal(res.total);
    setPageOffset(res.offset);
    setActiveQuery(q);
    return res;
  }

  async function jumpToHit(hit: PreviewSearchHit, indexInPage: number, q: string = activeQuery) {
    setLocalIndex(indexInPage);
    const windowStart = Math.max(0, hit.offset - PAD);
    if (
      hit.offset >= loader.baseOffsetRef.current &&
      hit.offset + hit.length <= loader.baseOffsetRef.current + loader.segmentRef.current.length
    ) {
      setActiveQuery(q);
      requestAnimationFrame(() => {
        const mark = loader.bodyRef.current?.querySelector(
          `mark[data-abs="${hit.offset}"]`,
        ) as HTMLElement | null;
        mark?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      return;
    }
    await loader.loadAt(windowStart, {
      highlightOffset: hit.offset,
      highlightQuery: q,
      preserve: "none",
    });
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) {
      message.info("请输入要搜索的内容");
      return;
    }
    setSearching(true);
    try {
      const res = await fetchHitPage(q, 0);
      if (!res.hits.length) {
        setLocalIndex(-1);
        message.info("未找到匹配内容");
        return;
      }
      await jumpToHit(res.hits[0], 0, q);
    } catch (err) {
      message.error(formatError(err, "搜索失败"));
    } finally {
      setSearching(false);
    }
  }

  async function goHit(delta: number) {
    if (!activeQuery || hitTotal <= 0) return;
    let nextGlobal = globalIndex + delta;
    if (nextGlobal < 0) nextGlobal = hitTotal - 1;
    if (nextGlobal >= hitTotal) nextGlobal = 0;

    if (nextGlobal >= pageOffset && nextGlobal < pageOffset + hits.length) {
      const idx = nextGlobal - pageOffset;
      await jumpToHit(hits[idx], idx);
      return;
    }

    setSearching(true);
    try {
      const pageStart = Math.floor(nextGlobal / PAGE_SIZE) * PAGE_SIZE;
      const res = await fetchHitPage(activeQuery, pageStart);
      if (!res.hits.length) return;
      const idx = Math.min(nextGlobal - res.offset, res.hits.length - 1);
      await jumpToHit(res.hits[Math.max(0, idx)], Math.max(0, idx));
    } catch (err) {
      message.error(formatError(err, "加载更多命中失败"));
    } finally {
      setSearching(false);
    }
  }

  return {
    query,
    setQuery,
    hits,
    setHits,
    hitTotal,
    setHitTotal,
    pageOffset,
    setPageOffset,
    localIndex,
    setLocalIndex,
    searching,
    setSearching,
    activeQuery,
    setActiveQuery,
    globalIndex,
    resetSearch,
    fetchHitPage,
    jumpToHit,
    runSearch,
    goHit,
  };
}
