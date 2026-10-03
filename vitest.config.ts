import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "scripts",
      "packages/core",
      "packages/oracle",
      "packages/parser",
      "packages/target-registry",
      "packages/hosts/*",
      "packages/targets/*",
      "packages/tooling/*",
      "packages/editors/*",
    ],
  },
});
