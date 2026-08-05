/** PDF 阅读页码进度（按 source / entry 记忆） */

export const PDF_PAGE_KEY_PREFIX = "kongku.pdf.page.";
export const PDF_PAGE_SAVE_MS = 400;

type StoredPdfPage = { page: number; updatedAt: number };

export function pdfPageStorageKey(
  sourceId?: number | null,
  entryId?: number | null,
): string | null {
  if (sourceId != null && sourceId > 0) return `${PDF_PAGE_KEY_PREFIX}source:${sourceId}`;
  if (entryId != null && entryId > 0) return `${PDF_PAGE_KEY_PREFIX}entry:${entryId}`;
  return null;
}

export function readStoredPdfPage(key: string | null): number {
  if (!key) return 0;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as StoredPdfPage;
    const page = Number(parsed?.page);
    return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 0;
  } catch {
    return 0;
  }
}

export function writeStoredPdfPage(key: string | null, page: number) {
  if (!key) return;
  const n = Math.max(1, Math.floor(page));
  try {
    const payload: StoredPdfPage = { page: n, updatedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    /* ignore quota / private mode */
  }
}
