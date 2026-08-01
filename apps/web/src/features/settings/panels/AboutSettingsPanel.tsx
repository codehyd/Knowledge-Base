import {
  CloudDownloadOutlined,
  InfoCircleOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Form,
  Progress,
  Tag,
  Typography,
} from "antd";
import type { KongkuDesktopBridge } from "@/shared/desktop";
import { formatBytes } from "../utils/formatBytes";
import styles from "../SettingsPage.module.css";

type AboutSettingsPanelProps = {
  desktop: KongkuDesktopBridge | undefined;
  appVersion: string;
  isPackaged: boolean;
  checkingUpdate: boolean;
  downloadingUpdate: boolean;
  updatePercent: number;
  updateTransferred: number;
  updateTotal: number;
  updateSpeed: number;
  remoteVersion: string;
  updateReady: boolean;
  updateStatus: {
    type: "info" | "success" | "warning" | "error";
    message: string;
  } | null;
  onCheckUpdate: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  onOpenReleases: () => void;
};

export function AboutSettingsPanel({
  desktop,
  appVersion,
  isPackaged,
  checkingUpdate,
  downloadingUpdate,
  updatePercent,
  updateTransferred,
  updateTotal,
  updateSpeed,
  remoteVersion,
  updateReady,
  updateStatus,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  onOpenReleases,
}: AboutSettingsPanelProps) {
  return (
    <>
      <div className={styles.content}>
        <div className={styles.contentHead}>
          <div>
            <h1>关于</h1>
            <p className={styles.desc}>查看版本信息，并从 GitHub Releases 检查桌面端更新。</p>
          </div>
          {appVersion ? <Tag color="processing">v{appVersion}</Tag> : null}
        </div>

        <div className={styles.contentBody}>
          <Form layout="vertical" className={styles.form}>
            <Form.Item label="应用">
              <Typography.Text>空库（Kongku）</Typography.Text>
            </Form.Item>
            <Form.Item label="当前版本">
              <Typography.Text>
                {appVersion ? `v${appVersion}` : desktop ? "读取中…" : "浏览器模式（无桌面版本号）"}
              </Typography.Text>
            </Form.Item>
            <Form.Item label="运行环境">
              <Typography.Text>
                {!desktop
                  ? "网页"
                  : isPackaged
                    ? "桌面安装包"
                    : "桌面开发模式"}
              </Typography.Text>
            </Form.Item>

            {updateStatus ? (
              <Alert
                className={styles.testAlert}
                type={updateStatus.type}
                showIcon
                message={updateStatus.message}
                description={
                  remoteVersion ? `远端版本：v${remoteVersion}` : undefined
                }
              />
            ) : null}

            {downloadingUpdate || updatePercent > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <Progress
                  percent={updatePercent}
                  status={updateReady ? "success" : downloadingUpdate ? "active" : "normal"}
                />
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  {updateReady
                    ? "下载完成"
                    : updateTotal > 0
                      ? `${formatBytes(updateTransferred)} / ${formatBytes(updateTotal)}${
                          updateSpeed > 0 ? ` · ${formatBytes(updateSpeed)}/s` : ""
                        }`
                      : downloadingUpdate
                        ? "正在连接并开始下载…"
                        : null}
                </Typography.Text>
              </div>
            ) : null}

            {!desktop ? (
              <Alert
                style={{ marginTop: 16 }}
                type="info"
                showIcon
                message="自动更新仅在桌面客户端可用"
              />
            ) : null}
          </Form>
        </div>
        <div className={styles.contentFooter}>
          <Button
            type="primary"
            icon={<SyncOutlined spin={checkingUpdate} />}
            loading={checkingUpdate}
            disabled={!desktop || downloadingUpdate}
            onClick={() => void onCheckUpdate()}
          >
            检查更新
          </Button>
          {remoteVersion && !updateReady ? (
            <Button
              icon={<CloudDownloadOutlined />}
              loading={downloadingUpdate}
              disabled={!desktop || checkingUpdate}
              onClick={() => void onDownloadUpdate()}
            >
              下载更新
            </Button>
          ) : null}
          {updateReady ? (
            <Button type="primary" danger onClick={() => void onInstallUpdate()}>
              重启并安装
            </Button>
          ) : null}
          <Button onClick={() => void onOpenReleases()}>浏览器下载安装包</Button>
        </div>
      </div>

      <aside className={styles.tips}>
        <Card size="small" title={<><InfoCircleOutlined /> 说明</>}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            更新来自 GitHub Releases。安装包约 200MB，国内网络可能中途断开；可点「下载更新」自动重试，或「浏览器下载安装包」手动安装。
          </Typography.Paragraph>
        </Card>
        <Card size="small" title={<><SafetyCertificateOutlined /> 注意</>}>
          <ul className={styles.checklist}>
            <li>Windows 安装包支持下载后重启安装</li>
            <li>Linux 建议使用 AppImage 以支持自动更新</li>
            <li>macOS 未签名时更新后可能被系统拦截</li>
          </ul>
        </Card>
      </aside>
    </>
  );
}
