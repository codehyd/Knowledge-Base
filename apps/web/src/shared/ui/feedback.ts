/** 把 API / 未知错误整理成可读文案，供 message 等反馈组件使用。 */
export function formatError(err: unknown, fallback = "操作失败"): string {
  if (err instanceof Error && err.message.trim()) {
    return softenFetchError(err.message.trim());
  }
  if (typeof err === "string" && err.trim()) {
    return softenFetchError(err.trim());
  }
  return fallback;
}

function softenFetchError(msg: string): string {
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return "无法连接后端服务。请确认桌面端已启动 API（本机 18765），或查看用户目录下 api-sidecar.log";
  }
  return msg;
}
