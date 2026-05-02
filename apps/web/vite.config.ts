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
    port: Number(process.env.PORT ?? 5173),
    strictPort: !!process.env.PORT,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7421",
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
      "/ws": {
        target: "ws://127.0.0.1:7421",
        ws: true,
      },
    },
  },
});
