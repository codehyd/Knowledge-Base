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
  if (
    /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(
      msg,
    )
  ) {
    return "下载更新时网络中断（GitHub 大文件在国内易断开）。请重试，或改用浏览器手动下载安装包。";
  }
  return msg;
}
