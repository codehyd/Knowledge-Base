import {
  ApiOutlined,
  DatabaseOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  ReadOutlined,
} from "@ant-design/icons";
import type { SubNav } from "./types";
import styles from "./SettingsPage.module.css";

type SettingsSubNavProps = {
  subNav: SubNav;
  onSubNavChange: (nav: SubNav) => void;
};

export function SettingsSubNav({ subNav, onSubNavChange }: SettingsSubNavProps) {
  return (
    <aside className={styles.subNav}>
      <h2>设置</h2>
      <button
        type="button"
        className={subNav === "model" ? styles.subActive : styles.subItem}
        onClick={() => onSubNavChange("model")}
      >
        <ApiOutlined /> 模型与 Key
      </button>
      <button
        type="button"
        className={subNav === "database" ? styles.subActive : styles.subItem}
        onClick={() => onSubNavChange("database")}
      >
        <DatabaseOutlined /> 数据库
      </button>
      <button
        type="button"
        className={subNav === "feed" ? styles.subActive : styles.subItem}
        onClick={() => onSubNavChange("feed")}
      >
        <ReadOutlined /> 喂养
      </button>
      <button
        type="button"
        className={subNav === "library" ? styles.subActive : styles.subItem}
        onClick={() => onSubNavChange("library")}
      >
        <FolderOpenOutlined /> 我的资源
      </button>
      <button type="button" className={styles.subItem} disabled>
        拒答规则
      </button>
      <button type="button" className={styles.subItem} disabled>
        备份导出
      </button>
      <button
        type="button"
        className={subNav === "about" ? styles.subActive : styles.subItem}
        onClick={() => onSubNavChange("about")}
      >
        <InfoCircleOutlined /> 关于
      </button>
    </aside>
  );
}
