import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";

/** 与 global.css 主色对齐；聚焦描边改轻，避免输入框「硬蓝边」感 */
const theme = {
  token: {
    colorPrimary: "#2a6f6a",
    colorInfo: "#2a6f6a",
    colorSuccess: "#2a6f6a",
    borderRadius: 8,
    controlOutline: "rgba(42, 111, 106, 0.14)",
    controlOutlineWidth: 3,
    fontFamily:
      '"IBM Plex Sans", "PingFang SC", "Noto Sans SC", system-ui, sans-serif',
  },
};

type Props = { children: ReactNode };

/** 全局 Ant Design：主题 + 中文 + message/modal 上下文 */
export function UiProvider({ children }: Props) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={theme}
      modal={{
        centered: true,
      }}
    >
      <App message={{ maxCount: 3, duration: 3 }}>{children}</App>
    </ConfigProvider>
  );
}
