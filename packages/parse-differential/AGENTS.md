# parse-differential — agent instructions

`@mxlang/parse-differential` is a **private test package** of the MX2 parser
port (decisions 158, 166; brief `port-pr2-front-end-structure`). It compares
the MX front end (`packages/parser/src/frontend`) with today's Marko tree and
is never published. It exists from PR 2 (tree differential) through PR 4 (the
IR differential goes here too) and is removed with the Marko path in PR 6.

- **Why a package of its own:** nothing published may gain a dependency edge
  for the comparison. It depends on `@mxlang/core` (for `markoCompiler()` and
  `CORE_TAGLIB`), `@mxlang/parser` and `@mxlang/babel`; it is the one package
  besides the parser allowed to depend on `@mxlang/parser`
  (`scripts/workspace-cycles.test.ts`).
- **The front end is read by relative path** (`../../parser/src/frontend/…`):
  it is not exported from `@mxlang/parser` until PR 3.
- **Today's tree:** `compileSync` with the html target's taglibs (MX's core
  taglib and Marko's built-ins) and an empty `translate`, as `parseFragment`
  does. The MX side gets `tagShape` from the same taglib lookup and the six
  statement keywords, so both parse with the same inputs.
- **Neutral form** (`src/neutral.ts`): what both trees are projected into.
  `src/mx.ts` projects the MX tree, `src/marko.ts` today's tree, applying the
  **mapping rules** of `src/rules.ts`: one per ast §2 accommodation, each with
  a test in `src/rules.test.ts`. The rules are the only allowed differences;
  adding a rule to make a difference disappear needs the lead.
- **Named difference lists** in `src/differential.test.ts` (async attribute
  start, the disclosed silent end-of-input probes, PR 2b's errors, today's
  crashes): any other difference fails the test, and each list must keep
  differing, so a fix shows up.
- **Counts for a reviewer:** `bun run --cwd packages/parse-differential report`
  prints the counts and every difference. Needs `bun install` and `bun run
  build` first: `@mxlang/core` resolves to its `dist/`, and a stale `dist/`
  compares against old behaviour silently.
- Tests: `bunx vitest run --root ../.. --project @mxlang/parse-differential`.
