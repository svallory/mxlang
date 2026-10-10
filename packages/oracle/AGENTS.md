# oracle — agent instructions

## Oracle harness

`packages/oracle` (`@mxlang/oracle`) compares compiled `dom-expressions` output between `fixtures/<name>/input.solid.mx` and its hand-written `fixtures/<name>/twin.tsx` twin, across **both Solid 2 backends and both generate variants** — four rows per fixture. `bun run oracle` runs it standalone and prints a fixture/backend/variant/status table; see `fixtures/README.md` for the fixture and `divergences.md` contract.

Backends (`compile.ts`'s `backend: "babel" | "native"`):

- `babel` — `@solidjs/babel-plugin`, the `babel-preset-solid` successor, over a Babel JSX AST via `parserOverride`.
- `native` — `@solidjs/compiler`, Solid's Oxc compiler and `@solidjs/vite-plugin`'s default. Its only entry point is `transform(code, options)` over **source text**, so MX reaches it by printing its lowered AST back to JSX text first. Both backends must pass: they are separate codegen implementations.

Variant names are unchanged from Solid 1 (`generate: "dom" | "ssr"` plus `hydratable`) — both 2.0 packages document the same spelling.

Two native-compiler gotchas, worked around in `compile.ts`:

- The documented `syntax` option (README and `types.d.ts`) is **rejected at runtime** by rc.7. Frontend routing is by filename.
- The compiler picks its parser dialect from the **filename extension** and rejects `.solid.mx`. The oracle appends `.tsx` to MX filenames for that backend, like `@mxlang/vite-plugin`'s virtual id.

`@mxlang/tsx-bridge` exports two printer entry points, both sharing one set of `@babel/generator` options so they cannot drift: `print(source, filename)` for the ordinary case, and `printAst(ast, filename)` for callers that must run their own pass over the AST first. The oracle needs the second one — `.solid.mx` fixtures use TypeScript syntax, `@babel/preset-typescript` has to erase it before printing, and `print` would re-parse the source and skip that erasure, handing `interface Todo { ... }` to a JSX-only frontend.

A twin must not introduce whitespace MX drops. MX follows Marko's rules — a whitespace-only run containing a newline is dropped — so `text<p>…` goes on one line in the twin wherever the MX source separates them only by indentation. See `fixtures/README.md`.

`@mxlang/tsx-bridge` is wired into the harness (`packages/oracle` depends on it and `report.ts` passes its `parse` as `mxParser`), so fixtures compile for real. Statuses: `pass`, `fail` and `divergent` mean the parser ran; `skipped` means no parser was available (now a real failure, not "not implemented"); `pending` means the fixture carries a `PENDING` marker naming constructs the parser cannot lower yet. Neither `skipped` nor `pending` is a pass, and `--strict` fails the run on either — see `fixtures/README.md` for the `PENDING` contract.

Current state: `counter`, `todos`, `attrs`, `lists` and `render-props` all pass on both backends and both variants (20 rows). `bun run oracle` and `bun run oracle -- --strict` are both expected to exit 0 — `--strict` green is the standing bar, not an aspiration.

`packages/oracle/src/compile.ts` runs `@babel/preset-typescript` after parsing `.solid.mx` too, not only `.tsx`: the vendored MX parser accepts TS syntax (interfaces, type annotations, generics) but `mxParser`'s `parserOverride` only replaces the *parse* step, not the erasure pass, so TS type nodes are still in the AST afterward and need the same stripping a `.tsx` file gets — or they leak into the compiled output and break byte parity against a twin that went through the ordinary TS pipeline.

Golden snapshots (`fixtures/<name>/__golden__/twin.<backend>.<variant>.js`) pin `twin.tsx`'s own compiled output, independent of MX, to catch a Solid 2 pin bump changing generated code. Regenerate them deliberately with `bun run oracle -- --update` and call it out in the PR — never let a pin bump change them as a silent side effect.

`packages/tsx-bridge/src/mx/perf.test.ts`'s 500ms wall-clock budget only fails the test when `MX_PERF_STRICT` is set; otherwise it just `console.warn`s past the budget, since a plain `bun run verify` under machine contention (several agents/verifiers at once) can blow well past 500ms with no actual parser regression.

### `oracle:marko`: Marko parity for the stock `.marko` fixture set

Decision 51: the parity target for Marko-syntax constructs is Marko itself,
not Solid. Decision 68 retired `.mx`/`@mxlang/html`, so there is one dialect
and one table: `bun run oracle:marko` (`packages/oracle/src/report-marko.ts`,
delegating to `report-marko-stock.ts`) renders every fixture under
`packages/targets/html/fixtures-marko/<name>/{input.marko,input.json,expected.html}`
two ways — through the real Marko 6 toolchain (`@marko/compiler` 5.42.11 +
`marko/translator`, exactly matching `marko@6.4.4`'s own dependency) and
through `@mxlang/target-html`'s `compile()` — and compares both against
`expected.html` for **semantic** equality (`normalize-html.ts`'s
`htmlEquals`: both sides parsed with `parse5` and compared by decoded
tag/attribute/text/comment content, not by string spelling). `-- --strict` is
accepted for CLI symmetry with `oracle -- --strict` but does not fail on a
recorded, reasoned skip/divergence (`meta.json` in a fixture directory — see
`fixtures/README.md`'s "oracle:marko" section for the full contract) — that
classification is the settled state, not unfinished work like `oracle`'s own
`pending`/`skipped`. The run fails if the fixture glob is empty, a fixture is
missing one of its three files, or too few fixtures were processed (decision
55: a gate must assert it did work, not only that nothing failed). See the
script's own footer for the current pass/skip/bug count.

`bun run oracle:preact` and `bun run oracle:react` have the same shape for the
JSX hosts — see `packages/hosts/preact/AGENTS.md` and `packages/hosts/react/AGENTS.md`. Both ignore attribute order;
the React runner also removes React 19's leading, renderer-generated image
preload hints before comparing the authored markup.

Neither is part of `bun run verify` or `moon run :verify`
— the Marko toolchain is a real install/memory cost and this task's own load
rule is one heavy process at a time. Run it in CI as its own job if
`.github/workflows/` grows a verify workflow; none exists yet in this repo, so
there is nothing to wire it into today.

Two Marko-toolchain facts worth knowing before touching
`packages/oracle/src/marko-compile-stock.ts`:

- `compileFile`'s `translator` option must be resolved and passed as the imported module object (`import * as translator from "marko/translator"`), not the string `"marko/translator"` — passing the string fails to resolve relative to the compiler's own internal base path rather than the caller's `node_modules`.
- `optimize: true` is required to get a plain server-HTML render: without it, `@marko/compiler` emits Marko's resume/hydration markers (an HTML comment plus an inline `<script>`) even under `output: "html"`. It does not fully suppress them — `<input>` and dynamic spread attributes still emit one regardless of `optimize` — so `normalize-html.ts`'s `stripMarkoResumeMarker` strips the trailing `<!--M_$…--><script>…</script>` pair before comparison: it is Marko hydration plumbing with no `@mxlang/target-html` equivalent to compare against, not template content, and its id/script body is randomly generated per compile so it can never byte-match anyway.

