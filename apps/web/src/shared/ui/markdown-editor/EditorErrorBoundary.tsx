import { Component, type ErrorInfo, type ReactNode } from "react";
import styles from "./MarkdownEditor.module.css";

type Props = { children: ReactNode };
type State = { error: string | null; nonce: number };

/** 包住 TipTap：渲染期异常不再把整页打成白屏。 */
export class EditorErrorBoundary extends Component<Props, State> {
  state: State = { error: null, nonce: 0 };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown, info: ErrorInfo) {
    console.error("[markdown-editor]", err, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className={styles.editorCrash}>
          <div className={styles.editorCrashTitle}>编辑器未能打开</div>
          <div className={styles.editorCrashMsg}>{this.state.error}</div>
          <button
            type="button"
            className={styles.editorCrashRetry}
            onClick={() => this.setState((s) => ({ error: null, nonce: s.nonce + 1 }))}
          >
            重试
          </button>
        </div>
      );
    }
    return (
      <div key={this.state.nonce} className={styles.boundary}>
        {this.props.children}
      </div>
    );
  }
}
