export type TestResult = {
  ok: boolean;
  latency_ms?: number;
  message: string;
  at: string;
};

export type SubNav = "model" | "database" | "feed" | "library" | "about";

export type FeedTab = "general" | "books" | "media";
