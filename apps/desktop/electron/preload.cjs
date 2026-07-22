const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kongkuDesktop", {
  getConfig: () => ipcRenderer.invoke("kongku:getConfig"),
  onUpdateAvailable: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on("updater:available", listener);
    return () => ipcRenderer.removeListener("updater:available", listener);
  },
  onUpdateError: (cb) => {
    const listener = (_event, msg) => cb(msg);
    ipcRenderer.on("updater:error", listener);
    return () => ipcRenderer.removeListener("updater:error", listener);
  },
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),
});
