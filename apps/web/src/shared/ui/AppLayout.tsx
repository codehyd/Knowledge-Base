import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  BookOutlined,
  CommentOutlined,
  KeyOutlined,
  RightOutlined,
  SettingOutlined,
  UploadOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { api } from "@/shared/api/client";
import styles from "./AppLayout.module.css";

/** 对齐 figma/01：主导航为喂养 / 对话 / 知识 / 设置；点品牌回首页 */
const nav = [
  { to: "/feed", label: "喂养", icon: UploadOutlined },
  { to: "/chat", label: "对话", icon: CommentOutlined },
  { to: "/knowledge", label: "知识", icon: BookOutlined },
  { to: "/settings", label: "设置", icon: SettingOutlined },
];

const DEFAULT_DB_HINT =
  "未检测到数据库服务。请先在本机启动 Postgres（开发可用 Docker），并确认 DATABASE_URL 配置正确。";

export function AppLayout() {
  const location = useLocation();
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [serviceBanner, setServiceBanner] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const health = await api.health();
        if (!health.database) {
          setServiceBanner(health.database_message || DEFAULT_DB_HINT);
        } else {
          setServiceBanner(null);
        }
      } catch {
        setServiceBanner(
          "后端服务未就绪。请确认 Electron 已拉起 API，或本机 18765 端口有空库 API 在运行。",
        );
      }

      try {
        const overview = await api.overview();
        setKeyConfigured(overview.key_configured);
      } catch {
        setKeyConfigured(null);
      }
    })();
  }, [location.pathname]);

  return (
    <div
      className={`${styles.shell}${
        location.pathname.startsWith("/chat") ? ` ${styles.shellChat}` : ""
      }`}
    >
      <aside className={styles.sidebar}>
        <NavLink to="/" className={styles.brand} end>
          <div className={styles.logo}>空库</div>
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
          location.pathname.startsWith("/knowledge") ? ` ${styles.mainFill}` : ""
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
