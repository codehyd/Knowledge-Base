import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  BookOutlined,
  CommentOutlined,
  FormOutlined,
  KeyOutlined,
  RightOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UploadOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { api } from "@/shared/api/client";
import { getDesktopBridge } from "@/shared/desktop";
import styles from "./AppLayout.module.css";

/** 主导航：喂养 / 对话 / 知识 / 笔记 / 技能 / 设置；点品牌回首页 */
const nav = [
  { to: "/feed", label: "喂养", icon: UploadOutlined },
  { to: "/chat", label: "对话", icon: CommentOutlined },
  { to: "/knowledge", label: "知识", icon: BookOutlined },
  { to: "/notes", label: "笔记", icon: FormOutlined },
  { to: "/skills", label: "技能", icon: ThunderboltOutlined },
  { to: "/settings", label: "设置", icon: SettingOutlined },
];

const DEFAULT_DB_HINT =
  "未检测到可用数据库。请到「设置 → 数据库」检查连接；默认使用本地 SQLite。";

async function waitForHealthReady(retries = 20, intervalMs = 500) {
  const desktop = getDesktopBridge();
  const maxRetries = desktop ? 60 : retries; // 桌面端 sidecar 冷启动更慢
  let lastErr: unknown;
  for (let i = 0; i < maxRetries; i += 1) {
    try {
      return await api.health();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr;
}

export function AppLayout() {
  const location = useLocation();
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [serviceBanner, setServiceBanner] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;

    async function probeHealth(showFailure = true) {
      try {
        const health = await waitForHealthReady();
        if (cancelled) return;
        if (!health.database) {
          setServiceBanner(health.database_message || DEFAULT_DB_HINT);
        } else {
          setServiceBanner(null);
        }
        return true;
      } catch {
        if (cancelled || !showFailure) return false;
        const desktop = getDesktopBridge();
        let detail = "";
        if (desktop) {
          try {
            const cfg = await desktop.getConfig();
            if (cfg.apiLastError) detail = cfg.apiLastError;
            else if (cfg.apiStatus && cfg.apiStatus !== "ready") {
              detail = `状态：${cfg.apiStatus}`;
            }
          } catch {
            /* ignore */
          }
        }
        setServiceBanner(
          detail
            ? `后端服务未就绪。${detail}`
            : "后端服务未就绪。请确认 Electron 已拉起 API，或本机 18765 端口有空库 API 在运行。",
        );
        return false;
      }
    }

    void (async () => {
      const ok = await probeHealth(true);
      if (cancelled || ok) return;
      retryTimer = window.setInterval(() => {
        void probeHealth(false).then((ready) => {
          if (ready && retryTimer != null) {
            window.clearInterval(retryTimer);
            retryTimer = undefined;
          }
        });
      }, 3000);
    })();

    void (async () => {
      try {
        const overview = await api.overview();
        if (!cancelled) setKeyConfigured(overview.key_configured);
      } catch {
        if (!cancelled) setKeyConfigured(null);
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearInterval(retryTimer);
    };
  }, [location.pathname]);

  return (
    <div
      className={`${styles.shell}${
        location.pathname.startsWith("/chat") ? ` ${styles.shellChat}` : ""
      }`}
    >
      <aside className={styles.sidebar}>
        <NavLink to="/" className={styles.brand} end>
          <img
            className={styles.logo}
            src={`${import.meta.env.BASE_URL}logo-wordmark.png`}
            alt="空库"
            width={132}
            height={40}
          />
          <div className={styles.sub}>个人认知知识库</div>
        </NavLink>

        <nav className={styles.nav}>
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive ? `${styles.navItem} ${styles.active}` : styles.navItem
                }
              >
                <Icon className={styles.navIcon} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <NavLink to="/settings" className={styles.keyStatus}>
          <span className={styles.keyLeft}>
            <KeyOutlined />
            <span>
              {keyConfigured == null
                ? "Key 检测中"
                : keyConfigured
                  ? "Key 已配置"
                  : "Key 未配置"}
            </span>
          </span>
          <RightOutlined className={styles.keyChevron} />
        </NavLink>
      </aside>

      <main
        className={`${styles.main}${
          location.pathname.startsWith("/chat") ? ` ${styles.mainChat}` : ""
        }${
          location.pathname.startsWith("/knowledge") ||
          location.pathname.startsWith("/notes") ||
          location.pathname.startsWith("/settings")
            ? ` ${styles.mainFill}`
            : ""
        }`}
      >
        {serviceBanner ? (
          <div className={styles.serviceBanner} role="alert">
            <WarningOutlined />
            <span>{serviceBanner}</span>
          </div>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
