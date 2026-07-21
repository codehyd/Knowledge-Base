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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ ok: boolean }>("/health"),
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
};
