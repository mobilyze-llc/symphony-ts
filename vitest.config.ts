import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "ops/token-report-ui/src/**/*.test.tsx"],
    coverage: {
      enabled: false,
    },
  },
});
