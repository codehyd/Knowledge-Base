import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import { api } from "@/shared/api/client";
import styles from "./AppLayout.module.css";

const nav = [
  { to: "/", label: "首页", end: true },
  { to: "/feed", label: "喂养" },
  { to: "/chat", label: "对话" },
  { to: "/knowledge", label: "知识" },
  { to: "/settings", label: "设置" },
];

export function AppLayout() {
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const health = await api.health();
        setApiOk(health.ok);
        const overview = await api.overview();
        setKeyConfigured(overview.key_configured);
      } catch {
        setApiOk(false);
        setKeyConfigured(null);
      }
    })();
  }, []);

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.logo}>空库</div>
          <div className={styles.sub}>个人认知知识库</div>
        </div>
        <nav className={styles.nav}>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? `${styles.navItem} ${styles.active}` : styles.navItem
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className={styles.footer}>
          <div>API：{apiOk == null ? "检测中" : apiOk ? "正常" : "异常"}</div>
          <div>
            Key：
            {keyConfigured == null ? "—" : keyConfigured ? "已配置" : "未配置"}
          </div>
        </div>
      </aside>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
