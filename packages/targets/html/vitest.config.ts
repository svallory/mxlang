import { defineConfig } from "vitest/config";

// `bun.test.ts` imports `bun:test` and drives `Bun.plugin`/`Bun`'s own
// `import()` — Bun-runtime-only, so it runs under `bun run test:bun` instead
// (see package.json), not under this vitest project. `helpers.bun.test.ts`
// is the same shape for `mx`/`loadMx`'s own Bun branch (a `require` of a
// `data:` URL): vitest's own worker process has no `Bun` global even when
// invoked via `bunx` (measured), so it would only ever exercise the Node
// `registerHooks` branch if left in this project. `contracts.bun.test.ts`
// joins them for the same reason: it asserts an edited `mx.contracts`
// module reloads, which only Bun's runtime reproduces (TODO
// `sync-esm-reload-node`).
export default defineConfig({
  test: {
    // A module reset per file in a reused forks process (the root config
    // reuses workers; this project's own `isolate` resets modules and mocks
    // per file). The reset is needed only by ir-contract.test.ts "E3: prints
    // Expr.code and never re-derives it from Expr.node": it hoists a
    // `vi.mock`, and without a reset the mock is bypassed by the module
    // graph an earlier file already loaded. The `mx()` module-id collisions
    // that used to force a fresh worker per file are gone: each loader's
    // virtual URLs carry a process-unique id.
    isolate: true,
    exclude: [
      "**/node_modules/**",
      "src/bun.test.ts",
      "src/helpers.bun.test.ts",
      "src/example.bun.test.ts",
      "src/marko-tags.bun.test.ts",
      "src/contracts.bun.test.ts",
    ],
  },
});
