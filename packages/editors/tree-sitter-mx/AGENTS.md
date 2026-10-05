# tree-sitter-mx — agent instructions

MX's own tree-sitter grammar (`.mx`): `marko-js/tree-sitter` at a pin plus
`patches/`. Read `UPSTREAM.md` before changing anything.

- Every edit to a vendored file (`grammar.js`, `src/scanner.c`, `queries/`,
  `__tests__/`, `tools/check-wasm.mts`, `README.md`, `tree-sitter.json`) must
  also land as a new patch in `patches/`, or `bun run vendor:check` fails.
- After editing `grammar.js`, run `bun run generate` and commit `src/`;
  `scripts/test.sh` fails when `src/` is stale.
- The tests are `*.bun-test.mts` on purpose (not vitest). Run them with
  `bun run test`, which builds the wasm they load first.
- Zed only sees committed code: after a grammar commit, move `rev` in
  `packages/editors/zed/extension.toml` `[grammars.mx]`.
