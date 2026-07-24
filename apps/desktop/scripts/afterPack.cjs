/**
 * electron-builder afterPack：
 * - 确保 Linux/macOS sidecar 可执行
 * - macOS：给 PyInstaller sidecar 打上 entitlements（含 ad-hoc），避免 Hardened Runtime 拦库加载
 */
const { chmodSync, existsSync, writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");
const { execFileSync } = require("child_process");

function sidecarPath(context) {
  const isMac = context.electronPlatformName === "darwin";
  const bin = context.electronPlatformName === "win32" ? "kongku-api.exe" : "kongku-api";
  if (isMac) {
    return join(context.appOutDir, "Contents", "Resources", "api", bin);
  }
  return join(context.appOutDir, "resources", "api", bin);
}

exports.default = async function afterPack(context) {
  const target = sidecarPath(context);
  if (!existsSync(target)) {
    console.warn("[afterPack] sidecar missing:", target);
    return;
  }

  if (context.electronPlatformName !== "win32") {
    try {
      chmodSync(target, 0o755);
      console.log("[afterPack] chmod 755", target);
    } catch (err) {
      console.warn("[afterPack] chmod failed:", err);
    }
  }

  if (context.electronPlatformName === "darwin") {
    const entitlements = join(__dirname, "..", "build", "entitlements.mac.plist");
    try {
      // 无开发者证书时用 ad-hoc（-），正式发版有 CSC 时 electron-builder 还会再签主程序
      const args = ["--force", "--options", "runtime", "--sign", "-"];
      if (existsSync(entitlements)) {
        args.push("--entitlements", entitlements);
      }
      args.push(target);
      execFileSync("codesign", args, { stdio: "inherit" });
      console.log("[afterPack] codesign sidecar (ad-hoc + entitlements)");
    } catch (err) {
      console.warn("[afterPack] codesign sidecar failed:", err);
    }
  }

  // 便于 CI 日志确认产物在包内
  try {
    const markerDir = join(context.appOutDir, context.electronPlatformName === "darwin" ? "Contents/Resources/api" : "resources/api");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, ".sidecar-ready"), `${new Date().toISOString()}\n${target}\n`);
  } catch {
    /* ignore */
  }
};
