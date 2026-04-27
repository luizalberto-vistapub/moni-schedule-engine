import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      LOG_LEVEL: "silent"
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/types/**"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  }
});