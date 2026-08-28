import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/repo-context-contract.test.ts", "tests/fixtures/repo-context/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 85,
        branches: 80,
      },
    },
  },
});
