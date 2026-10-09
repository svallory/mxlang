import { defineConfig } from "vitest/config";

// Outside CI, cap the worker pool. A whole-suite run in this monorepo forks one
// worker per core and each loads full TypeScript programs (1-4 GB), which has
// filled a 16 GB laptop and crashed it twice. Override with VITEST_MAX_WORKERS=n.
const localWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 2);

export default defineConfig({
  test: {
    ...(process.env.CI ? {} : { maxWorkers: localWorkers }),
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
      "packages/web-elements",
      "packages/hosts/*",
      "packages/targets/*",
      "packages/tooling/*",
      "packages/editors/*",
    ],
  },
});
