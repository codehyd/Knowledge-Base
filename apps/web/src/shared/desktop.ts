export type DesktopConfig = {
  apiOrigin?: string;
  isPackaged?: boolean;
  version?: string;
  apiStatus?: string;
  apiLastError?: string;
  apiSpawnedByUs?: boolean;
  dataDir?: string;
  mediaCookiesReady?: boolean;
  mediaCookiesPath?: string;
};

export type UpdateInfo = {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string | null | object;
};

export type UpdateProgress = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type UpdateCheckResult = {
  ok: boolean;
  reason?: string;
  message?: string;
  currentVersion?: string;
  remoteVersion?: string;
};

export type MediaCookiesExportResult = {
  ok: boolean;
  path?: string;
  count?: number;
  loggedIn?: boolean;
  message?: string;
};

export type KongkuDesktopBridge = {
  getConfig: () => Promise<DesktopConfig>;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  downloadUpdate: () => Promise<boolean | { ok: boolean; attempts?: number }>;
  installUpdate: () => Promise<void>;
  openReleasesPage: (version?: string) => Promise<boolean>;
  loginMediaSite: (site?: string) => Promise<{ ok: boolean; reused?: boolean }>;
  exportMediaCookies: () => Promise<MediaCookiesExportResult>;
  onMediaCookiesExported: (
    cb: (info: MediaCookiesExportResult) => void,
  ) => () => void;
  onUpdateAvailable: (cb: (info: UpdateInfo) => void) => () => void;
  onUpdateNotAvailable: (cb: (info: UpdateInfo) => void) => () => void;
  onUpdateProgress: (cb: (info: UpdateProgress) => void) => () => void;
  onUpdateDownloaded: (cb: (info: UpdateInfo) => void) => () => void;
  onUpdateError: (cb: (msg: string) => void) => () => void;
};

export function getDesktopBridge(): KongkuDesktopBridge | undefined {
  return (window as unknown as { kongkuDesktop?: KongkuDesktopBridge }).kongkuDesktop;
}
