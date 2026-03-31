import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    unstubEnvs: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      enabled: false,
    },
  },
});
