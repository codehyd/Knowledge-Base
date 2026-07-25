/**
 * 主进程可变状态（窗口、API 子进程）。
 * 各模块共享同一引用，避免循环 require 传参地狱。
 */

module.exports = {
  /** @type {import('electron').BrowserWindow | null} */
  mainWindow: null,
  /** @type {import('electron').BrowserWindow | null} */
  mediaLoginWindow: null,
  /** @type {import('electron').BrowserWindow | null} */
  mediaPreviewWindow: null,
  /** @type {import('child_process').ChildProcess | null} */
  apiChild: null,
  /** 是否由本进程拉起的 API（外部已占用端口时为 false，退出不杀） */
  apiSpawnedByUs: false,
  /** @type {"unknown" | "starting" | "ready" | "failed"} */
  apiStatus: "unknown",
  apiLastError: "",
  apiStoppingIntentionally: false,
};
