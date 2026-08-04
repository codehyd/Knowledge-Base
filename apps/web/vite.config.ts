import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { yuqueAssets } from "yuque-editor-core/vite-assets";
import { fileURLToPath, URL } from "node:url";

/**
 * 语雀编辑态 openLink 默认为空；给 createOpenEditor 注入 window.__kongkuYuqueEnvAdapter。
 * 同时直接改 node_modules 不可靠（重装会丢），用 transform 保证开发/构建都生效。
 */
function yuqueEnvAdapterPlugin(): Plugin {
  const needle = "const editor = create(editorRoot, {";
  const inject = `const editor = create(editorRoot, {
        envAdapter: (typeof window !== "undefined" && window.__kongkuYuqueEnvAdapter)
            ? window.__kongkuYuqueEnvAdapter
            : undefined,`;

  return {
    name: "kongku-yuque-env-adapter",
    enforce: "pre",
    transform(code, id) {
      const norm = id.replace(/\\/g, "/");
      if (!norm.includes("yuque-editor-core") || !norm.includes("/editor.")) return;
      if (!code.includes(needle)) return;
      if (code.includes("__kongkuYuqueEnvAdapter")) return;
      return {
        code: code.replace(needle, inject),
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), yuqueAssets(), yuqueEnvAdapterPlugin()],
  // Electron loadFile 需要相对资源路径
  base: process.env.ELECTRON === "1" ? "./" : "/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  optimizeDeps: {
    // 避免预构建吞掉 envAdapter 注入 transform
    exclude: ["yuque-editor-core"],
  },
  server: {
    host: true,
    port: 41779,
    proxy: {
      "/api": "http://127.0.0.1:18765",
      "/health": "http://127.0.0.1:18765",
      "/doc.html": "http://127.0.0.1:18765",
      "/webjars": "http://127.0.0.1:18765",
      "/img": "http://127.0.0.1:18765",
      "/v3": "http://127.0.0.1:18765",
      "/openapi.json": "http://127.0.0.1:18765",
      "/docs": "http://127.0.0.1:18765",
    },
  },
});
