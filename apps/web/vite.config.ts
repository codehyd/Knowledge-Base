import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  // Electron loadFile 需要相对资源路径
  base: process.env.ELECTRON === "1" ? "./" : "/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
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
