import { defineConfig } from "vitest/config";

// `bun.test.ts` imports `bun:test` and drives `Bun.plugin`/`Bun`'s own
// `import()` — Bun-runtime-only, so it runs under `bun run test:bun` instead
// (see package.json), not under this vitest project. `helpers.bun.test.ts`
// is the same shape for `mx`/`loadMx`'s own Bun branch (a `require` of a
// `data:` URL): vitest's own worker process has no `Bun` global even when
// invoked via `bunx` (measured), so it would only ever exercise the Node
// `registerHooks` branch if left in this project.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "src/bun.test.ts",
      "src/helpers.bun.test.ts",
      "src/example.bun.test.ts",
    ],
  },
});
