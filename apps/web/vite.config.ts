import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEV_API_TARGET = process.env.VITE_DEV_API_TARGET ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Same-origin in dev: vite proxies auth + API to `wrangler dev`.
      "/auth": { target: DEV_API_TARGET, changeOrigin: true },
      "/v1": { target: DEV_API_TARGET, changeOrigin: true },
    },
  },
});
