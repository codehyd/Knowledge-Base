import { useEffect, useState } from "react";
import { Modal, Segmented } from "antd";
import styles from "./NotesPage.module.css";

type ShortcutRow = { keys: string; desc: string };
type Platform = "win" | "mac";

type Props = {
  open: boolean;
  onClose: () => void;
  /** 当前是否语雀模式，用于高亮对应分区 */
  lakeMode?: boolean;
  /** 打开时默认选中的平台（本机） */
  isMac?: boolean;
};

function rows(mod: string, alt: string, shift: string): { title: string; items: ShortcutRow[]; hint?: string }[] {
  return [
    {
      title: "通用（Markdown / 语雀）",
      items: [
        { keys: `${mod}+S`, desc: "保存笔记（并尝试入库）" },
        { keys: `${mod}+${shift}+L`, desc: "打开双链面板，插入 [[笔记]] 或 [[笔记#标题]]" },
        { keys: "Esc", desc: "关闭双链/命令菜单、对话框；语雀全屏时退出全屏" },
      ],
    },
    {
      title: "Markdown 模式",
      hint: "关闭顶部「语雀」开关时生效",
      items: [
        { keys: "/", desc: "打开插入命令菜单（标题、列表、任务等）" },
        { keys: "[[", desc: "双链补全；输入 笔记# 可选多级标题" },
        { keys: "Esc", desc: "关闭双链补全或 / 命令菜单，焦点回到正文" },
        { keys: `${mod}+B`, desc: "加粗" },
        { keys: `${mod}+I`, desc: "斜体" },
        { keys: `${mod}+U`, desc: "下划线" },
        { keys: `${mod}+${shift}+X`, desc: "删除线" },
        { keys: `${mod}+\``, desc: "行内代码" },
        { keys: `${mod}+${alt}+C`, desc: "代码块" },
        { keys: `${mod}+${alt}+1…4`, desc: "一至四级标题" },
        { keys: `${mod}+${shift}+8`, desc: "无序列表" },
        { keys: `${mod}+${shift}+7`, desc: "有序列表" },
        { keys: `${mod}+${shift}+9`, desc: "任务列表" },
        { keys: `${mod}+${shift}+B`, desc: "引用" },
        { keys: `${mod}+K`, desc: "插入/编辑普通链接（URL）" },
        { keys: `${mod}+Z / ${mod}+${shift}+Z`, desc: "撤销 / 重做" },
      ],
    },
    {
      title: "语雀模式",
      hint: "打开顶部「语雀」开关时生效（实验）",
      items: [
        { keys: `${mod}+S`, desc: "保存（同时写 .md 与 .lake）" },
        { keys: `${mod}+${shift}+L`, desc: "插入双链（写入正文）" },
        { keys: "[[（文末）", desc: "在正文末尾输入 [[ 可弹出笔记补全" },
        { keys: "顶部「插入双链」", desc: "按钮插入双链到正文" },
        { keys: "点击链接", desc: "在系统浏览器打开（可写 www.baidu.com 或完整 https://）" },
        { keys: "Esc", desc: "退出语雀全屏，回到应用界面" },
        { keys: "语雀工具栏", desc: "标题、列表、表格等排版由语雀编辑器提供" },
      ],
    },
  ];
}

function platformLabels(platform: Platform) {
  if (platform === "mac") {
    return { mod: "⌘", alt: "⌥", shift: "⇧" };
  }
  return { mod: "Ctrl", alt: "Alt", shift: "Shift" };
}

export function NoteShortcutsHelp({ open, onClose, lakeMode = false, isMac = false }: Props) {
  const [platform, setPlatform] = useState<Platform>(isMac ? "mac" : "win");

  useEffect(() => {
    if (open) setPlatform(isMac ? "mac" : "win");
  }, [open, isMac]);

  const { mod, alt, shift } = platformLabels(platform);
  const sections = rows(mod, alt, shift);

  return (
    <Modal
      title="笔记快捷键"
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      destroyOnHidden
      centered={false}
      rootClassName={styles.shortcutsModalRoot}
      className={styles.shortcutsModal}
      styles={{
        content: {
          maxHeight: "calc(100vh - 32px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        },
        body: {
          flex: "1 1 auto",
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          paddingTop: 4,
        },
      }}
    >
      <div className={styles.shortcutsBody}>
        <div className={styles.shortcutsToolbar}>
          <p className={styles.shortcutsLead}>
            当前为{lakeMode ? "语雀" : "Markdown"}模式
            {platform === "mac" ? " · 显示 Mac 键位" : " · 显示 Windows 键位"}
          </p>
          <Segmented
            size="small"
            value={platform}
            onChange={(v) => setPlatform(v as Platform)}
            options={[
              { label: "Windows", value: "win" },
              { label: "Mac", value: "mac" },
            ]}
          />
        </div>
        <div className={styles.shortcutsScroll}>
          {sections.map((sec) => (
            <section
              key={sec.title}
              className={`${styles.shortcutsSection}${
                (lakeMode && sec.title.startsWith("语雀")) ||
                (!lakeMode && sec.title.startsWith("Markdown"))
                  ? ` ${styles.shortcutsSectionActive}`
                  : ""
              }`}
            >
              <h3 className={styles.shortcutsSectionTitle}>{sec.title}</h3>
              {sec.hint ? <p className={styles.shortcutsHint}>{sec.hint}</p> : null}
              <table className={styles.shortcutsTable}>
                <tbody>
                  {sec.items.map((item) => (
                    <tr key={`${sec.title}-${item.keys}`}>
                      <td className={styles.shortcutsKeys}>
                        {item.keys.split(" / ").map((k, i) => (
                          <span key={k}>
                            {i > 0 ? <span className={styles.shortcutsOr}> / </span> : null}
                            <kbd className={styles.shortcutsKbd}>{k}</kbd>
                          </span>
                        ))}
                      </td>
                      <td className={styles.shortcutsDesc}>{item.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
