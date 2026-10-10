import { defineConfig } from "vitest/config";

// `bun.test.ts` imports `bun:test` and drives `Bun.plugin`/`Bun`'s own
// `import()` — Bun-runtime-only, so it runs under `bun run test:bun` instead
// (see package.json), not under this vitest project. Same arrangement as
// `@mxlang/target-html`, whose Bun loader is tested the same way.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    exclude: ["**/node_modules/**", "src/bun.test.ts"],
  },
});
