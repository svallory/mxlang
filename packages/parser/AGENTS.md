# parser — agent instructions

`packages/parser` holds `src/template/`, the htmljs-parser-derived template
parser and its tests, and `src/frontend/`, the MX2 front end that builds the
MX AST from the template parser's events (PR 2 of the parser port; see
below). It is private and has no build; the entry is `src/template/index.ts`. The Babel fork is `packages/babel` and the bridge is
`packages/tsx-bridge`; neither depends on this package.
`@mxlang/babel` is a devDependency for `src/template/mx-atoms.test.ts`, which
checks atom claims against Babel's `parseExpression`, and for the front end's
type-only imports of the MX AST types (`@mxlang/babel/mx-ast`).

Biome **ignores** `src/template/` wholesale
(`packages/parser/src/template/{core,states,util,__tests__}`, plus
`index.ts` and `internal.ts`, in `biome.json`'s `files.includes`), to keep the
vendored copy byte-comparable with upstream. `biome check` on those paths
reports them as ignored and checks nothing, so "lint clean" is vacuous there:
match the repo's formatting by hand or via
`biome format --stdin-file-path=x.ts < <file>`.

`.pi-lens.json` at the repo root exempts `packages/parser/src/template/**` from
pi-lens's SAFETY-comment rule for `as unknown as`, for the same reason: the
directory is copied upstream source kept byte-identical except the two patched
state files and MX's own patches, so the rule asks every editor to change lines
that are outside their task and that upstream owns. The exemption was requested
by the repo's lead, who owns the tooling.

## `src/frontend/` (the MX AST front end)

- `parse(source, { statementKeywords, tagShape, base? })` builds the MX AST
  of `apps/docs/docs/architecture/ast.md` (one handler per row of its §7
  table); `lineColumnAt(document, offset)` gives 1-based line, 0-based column.
- **Not exported** from the package index or `package.json` until PR 3
  (`boundary.test.ts` pins it). Until then containers carry no payload: the
  tree is typed by the module-private `interim.ts`. `@mxlang/parse-differential`
  reads the module by relative path.
- It never throws on input: a template-parser error, an internal failure
  (`MX_FRONT_END_INTERNAL`) and a throw out of the template parser itself all
  come back in `errors` with the partial tree. Missing options are a
  `TypeError`.
- `seams.frontEndRules` is where PR 2b's `MX_*` rules run (once per tag);
  `seams.clamped` counts the one clamp for the disclosed silent end-of-input
  defects. Tests replace seams and restore them.
- `corpus.test.ts` runs the 1,688 grammar probes and compares each tree's
  projection with `corpus.snapshot.json`. A deliberate change regenerates it:
  `FRONTEND_SNAPSHOT_UPDATE=1 bunx vitest run --root ../.. --project @mxlang/parser frontend/corpus`,
  then `bunx biome format --write src/frontend/corpus.snapshot.json`, and the
  diff is reviewed.
- The long no-throw fuzz is not in the test run:
  `bun run src/frontend/test-support/long-fuzz.ts <seed> <count>` (count of at
  least 500,000 per generator for a report).
- Unlike `src/template/`, `src/frontend/` is linted and format-checked.
