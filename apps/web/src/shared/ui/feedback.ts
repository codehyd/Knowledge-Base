/** 把 API / 未知错误整理成可读文案，供 message 等反馈组件使用。 */
export function formatError(err: unknown, fallback = "操作失败"): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err === "string" && err.trim()) {
    return err.trim();
  }
  return fallback;
}
