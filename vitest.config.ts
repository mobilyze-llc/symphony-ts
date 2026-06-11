import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    reporters: ["verbose"],
    unstubEnvs: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      // Disabled by default; CI's diff-coverage job enables it via --coverage.
      enabled: false,
      provider: "v8",
      // Include untested src files so diff coverage sees 0%-covered new files.
      all: true,
      include: ["src/**/*.ts"],
      reporter: ["json"],
      reportsDirectory: "coverage",
    },
  },
});
