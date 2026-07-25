import {
  ExportOutlined,
  PlayCircleOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { App, Button, Space, Typography } from "antd";
import { getDesktopBridge } from "@/shared/desktop";
import { formatError } from "@/shared/ui/feedback";
import styles from "./VideoPreviewPanel.module.css";

type Props = {
  title?: string;
  url: string;
  compact?: boolean;
};

export function VideoPreviewPanel({ title, url, compact = false }: Props) {
  const { message } = App.useApp();
  const desktop = getDesktopBridge();
  const safeUrl = (url || "").trim();

  async function playInApp() {
    if (!safeUrl) return;
    if (desktop?.openVideoPreview) {
      try {
        const res = await desktop.openVideoPreview(safeUrl, title || "");
        if (!res.ok) {
          message.warning(res.message || "无法在应用内打开该链接");
        }
      } catch (err) {
        message.error(formatError(err, "打开视频失败"));
      }
      return;
    }
    window.open(safeUrl, "_blank", "noopener,noreferrer");
  }

  function openExternal() {
    if (!safeUrl) return;
    window.open(safeUrl, "_blank", "noopener,noreferrer");
  }

  if (!safeUrl) {
    return (
      <div className={styles.empty}>
        <Typography.Text type="secondary">暂无视频链接</Typography.Text>
      </div>
    );
  }

  return (
    <div className={`${styles.panel}${compact ? ` ${styles.compact}` : ""}`}>
      <div className={styles.poster} aria-hidden>
        <VideoCameraOutlined />
      </div>
      <div className={styles.body}>
        <Typography.Text className={styles.url} ellipsis={{ tooltip: safeUrl }}>
          {safeUrl}
        </Typography.Text>
        {!compact ? (
          <Typography.Paragraph type="secondary" className={styles.hint}>
            桌面端会使用与「抖音登录」相同的 Cookie 在应用内打开网页播放；B站/YouTube
            等也可尝试应用内播放或浏览器打开。
          </Typography.Paragraph>
        ) : null}
        <Space wrap>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => void playInApp()}>
            {desktop ? "应用内播放" : "打开视频"}
          </Button>
          <Button icon={<ExportOutlined />} onClick={openExternal}>
            浏览器打开
          </Button>
        </Space>
      </div>
    </div>
  );
}
