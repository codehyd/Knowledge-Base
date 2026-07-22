import { Link, useLocation } from "react-router-dom";
import styles from "./NotFoundPage.module.css";

export function NotFoundPage() {
  const location = useLocation();

  return (
    <section className={styles.page}>
      <p className={styles.eyebrow}>页面不存在</p>
      <p className={styles.code}>404</p>
      <h1 className={styles.title}>这里没有内容</h1>
      <p className={styles.desc}>
        路径 <code className={styles.path}>{location.pathname}</code>{" "}
        不在空库里。可能是链接写错了，或功能尚未开放。
      </p>
      <div className={styles.actions}>
        <Link className={styles.primary} to="/">
          回首页
        </Link>
        <Link className={styles.ghost} to="/feed">
          去喂养
        </Link>
      </div>
    </section>
  );
}
