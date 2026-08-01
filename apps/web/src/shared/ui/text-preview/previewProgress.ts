export const PAGE_CHARS = 8000;
export const PROGRESS_KEY_PREFIX = "kongku.preview.progress.";
export const PROGRESS_SAVE_MS = 500;
/** 恢复滚动后短暂禁止写进度，避免未定位完成时把进度冲成更靠前的位置 */
export const PROGRESS_RESUME_GUARD_MS = 900;

export const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 18, 20, 22] as const;
export const FONT_WEIGHT_OPTIONS = [
  { value: 400, label: "常规" },
  { value: 500, label: "中等" },
  { value: 600, label: "半粗" },
  { value: 700, label: "粗体" },
] as const;
export const FONT_SIZE_KEY = "kongku.preview.fontSize";
export const FONT_WEIGHT_KEY = "kongku.preview.fontWeight";

type StoredProgress = { offset: number; updatedAt: number };

export function progressStorageKey(sourceId?: number | null, entryId?: number | null): string | null {
  if (sourceId != null && sourceId > 0) return `${PROGRESS_KEY_PREFIX}source:${sourceId}`;
  if (entryId != null && entryId > 0) return `${PROGRESS_KEY_PREFIX}entry:${entryId}`;
  return null;
}

export function readStoredProgress(key: string | null): number {
  if (!key) return 0;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as StoredProgress;
    const offset = Number(parsed?.offset);
    return Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  } catch {
    return 0;
  }
}

export function writeStoredProgress(key: string | null, offset: number) {
  if (!key) return;
  const pos = Math.max(0, Math.floor(offset));
  try {
    const payload: StoredProgress = { offset: pos, updatedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    /* ignore quota / private mode */
  }
}

export function calcPageInfo(viewPos: number, totalChars: number) {
  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalChars) / PAGE_CHARS));
  const currentPage = Math.min(
    totalPages,
    Math.max(1, Math.floor(Math.max(0, viewPos) / PAGE_CHARS) + 1),
  );
  return { currentPage, totalPages };
}

export function readStoredFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_SIZE_KEY));
    if (FONT_SIZE_OPTIONS.includes(n as (typeof FONT_SIZE_OPTIONS)[number])) return n;
  } catch {
    /* ignore */
  }
  return 13;
}

export function readStoredFontWeight(): number {
  try {
    const n = Number(localStorage.getItem(FONT_WEIGHT_KEY));
    if (FONT_WEIGHT_OPTIONS.some((o) => o.value === n)) return n;
  } catch {
    /* ignore */
  }
  return 400;
}
