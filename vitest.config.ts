import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "scripts",
      "packages/core",
      "packages/oracle",
      "packages/parser",
      "packages/hosts/*",
      "packages/tooling/*",
      "packages/editors/*",
    ],
  },
});
