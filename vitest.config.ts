import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "scripts",
      "patches",
      "packages/babel",
      "packages/core",
      "packages/oracle",
      "packages/parser",
      "packages/parse-differential",
      "packages/stock-marko",
      "packages/tsx-bridge",
      "packages/target-registry",
      "packages/hosts/*",
      "packages/targets/*",
      "packages/tooling/*",
      "packages/editors/*",
    ],
  },
});
