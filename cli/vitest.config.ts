import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts", "src/**/__tests__/**/*.{test,spec}.ts"],
  },
});
