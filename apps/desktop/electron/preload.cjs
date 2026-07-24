const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kongkuDesktop", {
  getConfig: () => ipcRenderer.invoke("kongku:getConfig"),
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),
  openReleasesPage: (version) =>
    ipcRenderer.invoke("updater:open-releases", version || ""),
  onUpdateAvailable: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on("updater:available", listener);
    return () => ipcRenderer.removeListener("updater:available", listener);
  },
  onUpdateNotAvailable: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on("updater:not-available", listener);
    return () => ipcRenderer.removeListener("updater:not-available", listener);
  },
  onUpdateProgress: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on("updater:progress", listener);
    return () => ipcRenderer.removeListener("updater:progress", listener);
  },
  onUpdateDownloaded: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on("updater:downloaded", listener);
    return () => ipcRenderer.removeListener("updater:downloaded", listener);
  },
  onUpdateError: (cb) => {
    const listener = (_event, msg) => cb(msg);
    ipcRenderer.on("updater:error", listener);
    return () => ipcRenderer.removeListener("updater:error", listener);
  },
});
