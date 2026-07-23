export type ModelOption = {
  id: string;
  label: string;
  desc?: string;
  recommended?: boolean;
};

export type ProviderOption = {
  id: string;
  name: string;
  base_url: string;
  docs_url?: string;
  keys_url?: string;
  chat_models: ModelOption[];
  embed_models: ModelOption[];
  allow_custom_base_url?: boolean;
  allow_custom_model?: boolean;
};

export type AiSettings = {
  provider: string;
  base_url: string;
  api_key_masked: string;
  chat_model: string;
  embed_model: string;
  configured: boolean;
};

export type DbSettings = {
  mode: "sqlite" | "postgres";
  sqlite_path: string;
  postgres_url_masked: string;
  postgres_configured: boolean;
  postgres_host?: string;
  postgres_port?: string;
  postgres_database?: string;
  postgres_username?: string;
  effective_url_masked: string;
  connected: boolean;
  message: string;
  schema_ready: boolean;
  missing_tables: string[];
  schema_message: string;
};

export type OpenBookItem = {
  id: string;
  title: string;
  authors: string[];
  languages: string[];
  download_count: number;
  cover_url: string;
  has_epub: boolean;
  has_text: boolean;
  source: string;
  detail_url: string;
  snippet?: string;
};

export type OpenBookSourceInfo = {
  id: string;
  name: string;
  description: string;
  languages: string[];
};

export type SourceItem = {
  id: number;
  type: string;
  title: string;
  filename: string;
  source_uri: string;
  status: string;
  stage: string;
  progress: number;
  error_message: string;
  char_count: number;
  created_at?: string | null;
  updated_at?: string | null;
};

export type IngestResult = {
  source_id: number;
  entry_id: number;
  title: string;
  category: string;
  categories?: string[];
};

export type EntryListItem = {
  id: number;
  title: string;
  summary: string;
  source_id?: number | null;
  categories: string[];
  created_at?: string | null;
};

export type EntryDetail = EntryListItem & {
  preview: string;
  preview_truncated?: boolean;
  char_count?: number;
  source_filename: string;
  source_type: string;
};

export type TextPreview = {
  title: string;
  char_count: number;
  text: string;
  offset: number;
  limit: number;
  truncated: boolean;
  source_id?: number | null;
  entry_id?: number;
};

export type PreviewSearchHit = {
  offset: number;
  length: number;
  snippet: string;
};

export type EntryAnnotation = {
  id: number;
  entry_id: number;
  start_offset: number;
  end_offset: number;
  quote: string;
  note: string;
  color: string;
  created_at?: string | null;
  updated_at?: string | null;
};

export type CategoryItem = {
  id: number;
  name: string;
  count: number;
};

export type ChatCitation = {
  entry_id: number;
  title: string;
  snippet: string;
  score: number;
};

export type ChatResult = {
  answer: string;
  refused: boolean;
  citations: ChatCitation[];
  retrieval?: string;
  session_id?: number | null;
};

export type ChatSession = {
  id: number;
  title: string;
  category_id?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ChatMessageItem = {
  id: number;
  session_id: number;
  role: "user" | "assistant" | string;
  content: string;
  refused: boolean;
  citations: ChatCitation[];
  created_at?: string | null;
};

function parseErrorBody(text: string, status: number): string {
  const raw = text.trim();
  if (!raw) return `请求失败（HTTP ${status}）`;
  try {
    const data = JSON.parse(raw) as { detail?: unknown; message?: unknown };
    const detail = data.detail ?? data.message;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (Array.isArray(detail)) {
      const parts = detail
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "msg" in item) {
            return String((item as { msg: unknown }).msg);
          }
          return "";
        })
        .filter(Boolean);
      if (parts.length) return parts.join("；");
    }
  } catch {
    // 非 JSON，原样返回（截断过长正文）
  }
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}

/** Electron 下指向本机 API；浏览器开发态走 Vite 同源代理（空字符串） */
let apiBase = "";

export async function initApiBase(): Promise<void> {
  const desktop = (
    window as unknown as {
      kongkuDesktop?: { getConfig: () => Promise<{ apiOrigin?: string }> };
    }
  ).kongkuDesktop;
  if (!desktop) {
    apiBase = "";
    return;
  }
  try {
    const cfg = await desktop.getConfig();
    apiBase = (cfg.apiOrigin || "").replace(/\/$/, "");
  } catch {
    apiBase = "http://127.0.0.1:18765";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (!isForm && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const url = path.startsWith("http") ? path : `${apiBase}${path}`;
  const res = await fetch(url, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseErrorBody(text, res.status));
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export type HealthStatus = {
  ok: boolean;
  service?: string;
  database: boolean;
  database_message?: string;
};

export const api = {
  health: () => request<HealthStatus>("/health"),
  overview: () =>
    request<{ entries: number; key_configured: boolean; empty_library: boolean }>(
      "/api/stats/overview",
    ),
  getProviders: () => request<{ providers: ProviderOption[] }>("/api/settings/ai/providers"),
  getAiSettings: () => request<AiSettings>("/api/settings/ai"),
  saveAiSettings: (body: {
    provider: string;
    base_url: string;
    api_key?: string;
    chat_model: string;
    embed_model: string;
  }) =>
    request<AiSettings>("/api/settings/ai", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testAiSettings: () =>
    request<{ ok: boolean; latency_ms?: number; message: string }>("/api/settings/ai/test", {
      method: "POST",
    }),

  getDbSettings: () => request<DbSettings>("/api/settings/db"),
  saveDbSettings: (body: {
    mode: "sqlite" | "postgres";
    sqlite_path: string;
    postgres_url?: string | null;
    postgres_host?: string | null;
    postgres_port?: string | null;
    postgres_database?: string | null;
    postgres_username?: string | null;
    postgres_password?: string | null;
  }) =>
    request<DbSettings>("/api/settings/db", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testDbSettings: (body: {
    mode: "sqlite" | "postgres";
    sqlite_path: string;
    postgres_url?: string | null;
    postgres_host?: string | null;
    postgres_port?: string | null;
    postgres_database?: string | null;
    postgres_username?: string | null;
    postgres_password?: string | null;
  }) =>
    request<{ ok: boolean; message: string }>("/api/settings/db/test", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  initDbSchema: () =>
    request<{
      ok: boolean;
      message: string;
      created_tables: string[];
      schema_ready: boolean;
      missing_tables: string[];
      vector_extension: boolean;
    }>("/api/settings/db/init", { method: "POST" }),

  getOpenBookSettings: () =>
    request<{
      open_ebook_direct_ingest: boolean;
      description: string;
      ctext_api_key_masked?: string;
      ctext_configured?: boolean;
      ctext_keys_url?: string;
      ctext_docs_url?: string;
      ctext_hint?: string;
      mirror_repo?: string;
      mirror_ref?: string;
      mirror_presets?: { id: string; name: string; repo: string; ref: string; desc?: string }[];
      mirror_hint?: string;
    }>("/api/open-books/settings"),
  saveOpenBookSettings: (body: {
    open_ebook_direct_ingest?: boolean;
    ctext_api_key?: string | null;
    mirror_repo?: string | null;
    mirror_ref?: string | null;
  }) =>
    request<{
      open_ebook_direct_ingest: boolean;
      description: string;
      ctext_api_key_masked?: string;
      ctext_configured?: boolean;
      ctext_keys_url?: string;
      ctext_docs_url?: string;
      ctext_hint?: string;
      mirror_repo?: string;
      mirror_ref?: string;
      mirror_presets?: { id: string; name: string; repo: string; ref: string; desc?: string }[];
      mirror_hint?: string;
    }>("/api/open-books/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  listOpenBookSources: () =>
    request<{ items: OpenBookSourceInfo[]; default_source: string }>(
      "/api/open-books/sources",
    ),
  searchOpenBooks: (q: string, source: string, page = 1) =>
    request<{
      query: string;
      source: string;
      total: number;
      items: OpenBookItem[];
      notice: string;
    }>(
      `/api/open-books/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}&page=${page}`,
    ),
  importOpenBook: (body: { source: string; book_id: string; direct_ingest?: boolean }) =>
    request<{
      job_id: string;
      status: string;
      progress: number;
      message: string;
      source_id?: number | null;
      title: string;
      filename: string;
      direct_ingest: boolean;
      error: string;
    }>("/api/open-books/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getOpenBookJob: (jobId: string) =>
    request<{
      job_id: string;
      status: string;
      progress: number;
      message: string;
      source_id?: number | null;
      title: string;
      filename: string;
      direct_ingest: boolean;
      error: string;
    }>(`/api/open-books/jobs/${encodeURIComponent(jobId)}`),

  listSources: () => request<{ items: SourceItem[]; total: number }>("/api/sources"),
  uploadSource: (file: File, type: "ebook" | "note") => {
    const form = new FormData();
    form.append("file", file);
    form.append("type", type);
    return request<SourceItem>("/api/sources/upload", { method: "POST", body: form });
  },
  pasteSource: (body: { title?: string; content: string }) =>
    request<SourceItem>("/api/sources/paste", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  urlSource: (url: string) =>
    request<SourceItem>("/api/sources/url", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  retrySource: (id: number) =>
    request<SourceItem>(`/api/sources/${id}/retry`, { method: "POST" }),
  attachTranscript: (id: number, content: string) =>
    request<SourceItem>(`/api/sources/${id}/transcript`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
    clearFinishedSources: () =>
      request<{ removed: number }>("/api/sources/queue/finished", { method: "DELETE" }),
    deleteSource: (id: number) =>
      request<{ ok: boolean; id: number }>(`/api/sources/${id}`, { method: "DELETE" }),
    ingestSource: (id: number) =>
      request<IngestResult>(`/api/sources/${id}/ingest`, { method: "POST" }),
  ingestReadySources: () =>
    request<{ ingested: IngestResult[]; skipped: number; failed: { source_id: number; detail: string }[] }>(
      "/api/sources/ingest-ready",
      { method: "POST" },
    ),
  previewSource: (id: number, params?: { offset?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.offset != null) qs.set("offset", String(params.offset));
    if (params?.limit != null) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<TextPreview & { source_id: number; filename: string; status: string }>(
      `/api/sources/${id}/preview${suffix}`,
    );
  },
  searchSourcePreview: (
    id: number,
    q: string,
    params?: { offset?: number; limit?: number },
  ) => {
    const qs = new URLSearchParams({ q });
    if (params?.offset != null) qs.set("offset", String(params.offset));
    if (params?.limit != null) qs.set("limit", String(params.limit));
    return request<{
      query: string;
      total: number;
      offset: number;
      limit: number;
      hits: PreviewSearchHit[];
    }>(`/api/sources/${id}/preview/search?${qs.toString()}`);
  },

  listCategories: () =>
    request<{ items: CategoryItem[]; total_entries: number }>("/api/categories"),
  listEntries: (params?: { q?: string; category?: string; page?: number; page_size?: number }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.category) qs.set("category", params.category);
    if (params?.page) qs.set("page", String(params.page));
    if (params?.page_size) qs.set("page_size", String(params.page_size));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ items: EntryListItem[]; total: number; page: number; page_size: number }>(
      `/api/entries${suffix}`,
    );
  },
  getEntry: (id: number) => request<EntryDetail>(`/api/entries/${id}`),
  previewEntry: (id: number, params?: { offset?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.offset != null) qs.set("offset", String(params.offset));
    if (params?.limit != null) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<TextPreview>(`/api/entries/${id}/preview${suffix}`);
  },
  searchEntryPreview: (
    id: number,
    q: string,
    params?: { offset?: number; limit?: number },
  ) => {
    const qs = new URLSearchParams({ q });
    if (params?.offset != null) qs.set("offset", String(params.offset));
    if (params?.limit != null) qs.set("limit", String(params.limit));
    return request<{
      query: string;
      total: number;
      offset: number;
      limit: number;
      hits: PreviewSearchHit[];
    }>(`/api/entries/${id}/preview/search?${qs.toString()}`);
  },
  listAnnotations: (entryId: number) =>
    request<{ items: EntryAnnotation[] }>(`/api/entries/${entryId}/annotations`),
  createAnnotation: (
    entryId: number,
    body: {
      start_offset: number;
      end_offset: number;
      quote: string;
      note?: string;
      color?: string;
    },
  ) =>
    request<EntryAnnotation>(`/api/entries/${entryId}/annotations`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAnnotation: (annId: number, body: { note?: string; color?: string }) =>
    request<EntryAnnotation>(`/api/annotations/${annId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAnnotation: (annId: number) =>
    request<void>(`/api/annotations/${annId}`, { method: "DELETE" }),
  deleteEntry: (id: number) =>
    request<void>(`/api/entries/${id}`, { method: "DELETE" }),
  chat: (body: {
    message: string;
    category_id?: number | null;
    session_id?: number | null;
  }) =>
    request<ChatResult>("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listChatSessions: () => request<{ items: ChatSession[] }>("/api/chat/sessions"),
  createChatSession: (body?: { category_id?: number | null; title?: string }) =>
    request<ChatSession>("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify(body || {}),
    }),
  listChatMessages: (sessionId: number) =>
    request<{ items: ChatMessageItem[] }>(`/api/chat/sessions/${sessionId}/messages`),
  deleteChatSession: (sessionId: number) =>
    request<void>(`/api/chat/sessions/${sessionId}`, { method: "DELETE" }),
  reindexKnowledge: (mode: "missing" | "all" = "missing") =>
    request<{ entries: number; chunks: number; mode: string }>(
      `/api/knowledge/reindex?mode=${mode}`,
      { method: "POST" },
    ),
};
