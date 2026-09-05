import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: true,
    // Vite 5.4+ rejects requests whose Host header isn't in the allowlist
    // (DNS-rebinding protection). Set VITE_DEV_ALLOW_ALL_HOSTS=1 (dev sandbox /
    // Tailscale access) to accept any host instead of seeing "Blocked request".
    allowedHosts: process.env.VITE_DEV_ALLOW_ALL_HOSTS ? true : undefined,
    port: Number(process.env.PORT ?? 5173),
    strictPort: !!process.env.PORT,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7421",
        rewrite: (p) => p.replace(/^\/api/, ""),
        changeOrigin: true, // ensures Cookie / Set-Cookie headers flow correctly
      },
      // QR mobile login — /mobile-auth is daemon-handled but not under /api,
      // so it needs its own proxy entry when the tunnel points at Vite.
      "/mobile-auth": {
        target: "http://127.0.0.1:7421",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:7421",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
