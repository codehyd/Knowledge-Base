import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: string | null };

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

/** 兜底：任何未捕获渲染错误都不要把整窗打成白屏。 */
export class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(err: unknown) {
    return { error: formatErr(err) };
  }

  componentDidCatch(err: unknown, info: ErrorInfo) {
    console.error("[app]", err, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 32,
            maxWidth: 720,
            fontFamily: '"IBM Plex Sans", "PingFang SC", sans-serif',
            color: "#334155",
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 650, marginBottom: 12 }}>页面出错了</div>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              lineHeight: 1.5,
              color: "#64748b",
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              padding: 12,
            }}
          >
            {this.state.error}
          </pre>
          <button
            type="button"
            style={{
              marginTop: 16,
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              background: "#fff",
              cursor: "pointer",
            }}
            onClick={() => window.location.reload()}
          >
            刷新
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function installFatalErrorOverlay() {
  const show = (msg: string) => {
    const root = document.getElementById("root");
    if (!root || root.dataset.fatal === "1") return;
    root.dataset.fatal = "1";
    const box = document.createElement("div");
    box.setAttribute("role", "alert");
    box.style.cssText =
      "position:relative;z-index:999999;padding:32px;max-width:720px;font-family:IBM Plex Sans,PingFang SC,sans-serif;color:#334155;background:#fff;min-height:100vh;box-sizing:border-box";
    const title = document.createElement("div");
    title.textContent = "页面出错了";
    title.style.cssText = "font-size:18px;font-weight:650;margin-bottom:12px";
    const pre = document.createElement("pre");
    pre.textContent = msg;
    pre.style.cssText =
      "white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5;color:#64748b;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "刷新";
    btn.style.cssText =
      "margin-top:16px;padding:8px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer";
    btn.onclick = () => window.location.reload();
    box.append(title, pre, btn);
    root.innerHTML = "";
    root.appendChild(box);
  };

  window.addEventListener("error", (event) => {
    const msg = event.error instanceof Error ? event.error.stack || event.error.message : event.message;
    if (!msg) return;
    console.error("[app:error]", event.error || event.message);
    window.requestAnimationFrame(() => {
      const root = document.getElementById("root");
      if (!root || root.innerText.trim().length > 40) return;
      show(String(msg));
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[app:unhandled]", event.reason);
    window.requestAnimationFrame(() => {
      const root = document.getElementById("root");
      if (!root || root.innerText.trim().length > 40) return;
      show(formatErr(event.reason));
    });
  });
}
