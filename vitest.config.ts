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
      // Do NOT add coverage.thresholds expecting `pnpm test` to fail on them:
      // scripts/test.mjs derives its exit code from test/suite counts
      // (SYMPH-389), so a threshold-only failure would be overridden. Enforce
      // coverage in scripts/ci/diff-coverage.mjs instead.
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
