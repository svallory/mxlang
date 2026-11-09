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
    // A fresh worker per file. With a module reset in a reused process only,
    // client-block.test.ts "`typeof q` renders undefined" gets '<p></p>'
    // instead of '<div>undefined</div>': `mx()`'s synthetic module ids collide
    // in the process-level module cache across files (dup-attr,
    // text-falsy-values and html-comment-render fail the same way). Without
    // even the module reset, ir-contract.test.ts "E3: prints Expr.code and
    // never re-derives it from Expr.node" fails (hoisted mock bypassed). The
    // threads pool isolates by default; forks isolation is read only from the
    // root config.
    pool: "threads",
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
