# fixtures

Golden/oracle fixtures for `@mxlang/oracle` (`packages/oracle`). Exit criterion
this harness checks: byte-parity (whitespace normalized) between compiled
`dom-expressions` output of a `.solid.mx` file and its hand-written `.tsx`
twin, across **both Solid 2 compiler backends** and both generate variants —
four rows per fixture.

## Backends and variants

| Axis | Values | Where it comes from |
|---|---|---|
| backend | `babel`, `native` | `babel` is `@solidjs/babel-plugin` (the `babel-preset-solid` successor, a Babel plugin over a JSX AST); `native` is `@solidjs/compiler`, Solid's Oxc compiler and `@solidjs/vite-plugin`'s default, whose only entry point is `transform(code, options)` over source text |
| variant | `dom`, `ssr-hydratable` | Solid's own `generate: "dom" \| "ssr"` plus `hydratable`. The 2.0 option names are unchanged from `babel-preset-solid` — both 2.0 packages document the same `generate`/`hydratable` spelling |

Both backends are checked because they are separate codegen
implementations: passing one says nothing about the other. MX reaches the
native backend by printing its lowered AST back to JSX **source text**
(`print()`, spec section 3.2) — the native compiler has no AST-injection API,
so source text is the only way in.

Two native-compiler facts the spec did not predict, both worked around in
`packages/oracle/src/compile.ts`:

- The documented `syntax: "auto" | "jsx" | "tsrx"` option (in the README and
  `types.d.ts`) is **rejected at runtime** by rc.7 (`received unknown option
  "syntax"`). Frontend routing is by filename instead.
- The compiler picks its parser dialect from the **filename extension** and
  rejects `.solid.mx` outright (`Unknown file extension`). The oracle appends
  `.tsx` to MX filenames for that backend, the same trick
  `@mxlang/vite-plugin` uses on its virtual id.

## Layout

```
fixtures/
  <name>/
    input.solid.mx      MX source
    twin.tsx             hand-written Solid JSX with equivalent behavior
    README.md             optional, notes about the fixture
    PENDING               optional, marks the fixture as not-yet-parseable
    __golden__/
      twin.babel.dom.js              normalized twin.tsx output
      twin.babel.ssr-hydratable.js
      twin.native.dom.js
      twin.native.ssr-hydratable.js
  divergences.md
  README.md (this file)
```

Golden filenames are `twin.<backend>.<variant>.js`.

Fixtures are discovered by directory scan (`discoverFixtures` in
`packages/oracle/src/fixtures.ts`); adding a fixture is just adding a
directory with `input.solid.mx` and `twin.tsx`, no code change.

## Adding a fixture

1. `mkdir fixtures/<name>`
2. Write `twin.tsx`: real, working Solid JSX.
3. Write `input.solid.mx`: the MX spelling of the same component, per
   `notes/solidmx-jsx-mapping.md` and `notes/solidmx-spec.md` sections 4-5
   at the space root. If a construct isn't covered by the mapping doc, leave
   `// TODO(mx): unmapped` in the `.solid.mx` file and note it in your PR —
   do not invent MX syntax.
4. Run `bun run oracle` (or `bun run test`) once to write the golden
   snapshots under `__golden__/`. Commit them.
5. A fixture directory must contain both `input.solid.mx` and `twin.tsx`;
   `discoverFixtures` throws if a directory has only one of the two.

## PENDING fixtures

A fixture directory containing a `PENDING` file reports status `pending` for
every variant and is never compiled. Use it for a fixture whose MX source is
written and correct but uses constructs the parser cannot lower yet.

Put one line inside naming the missing constructs, so the marker says why it
exists:

```
fixtures/todos/PENDING
  Needs `<if=cond>` / `<else>` control flow and `<for|item, i| of= by=>`
  list lowering, none of which the parser lowers yet.
```

`pending` behaves like `skipped`: never a pass, never a failure, always
listed in the table, and `--strict` fails on it. That is the point — the
marker keeps an unfinished fixture visible instead of letting it look green,
and `--strict` in CI makes removing the marker part of finishing the work.
Delete the file once the parser handles the fixture; the fixture then
compiles and reports `pass`/`fail`/`divergent` like any other.

## divergences.md

A markdown table (`fixture | variant | reason`) of deliberate, known
differences between a fixture's `.solid.mx` and `.tsx` output. When a
fixture+variant pair is listed here, `compare()` reports status `divergent`
instead of `fail` — the diff is still shown, it just doesn't fail the suite.
Add a row only when the difference is understood and accepted, never as a
way to silence an unexplained failure.

## Golden snapshots

`__golden__/twin.<backend>.<variant>.js` pins the normalized output of
`twin.tsx` alone (no MX involved). Purpose: catch a Solid 2 pin bump
(`@solidjs/babel-plugin`, `@solidjs/compiler`, `solid-js`, `@solidjs/web`)
that silently changes generated output, independent of whether `parser`
exists yet.

- Written automatically the first time a fixture is compared, if missing.
- To regenerate deliberately (e.g. after a documented pin bump), run
  `bun run oracle -- --update`, which rewrites every golden regardless of
  whether it already exists (`compare()`'s `updateGoldens` option). Never
  let a golden change as a silent side effect of a pin bump — call it out
  in the PR that bumps the pin, and review the diff of the regenerated
  goldens before committing.

## `normalize()`

Defined in `packages/oracle/src/normalize.ts`. What it does, exactly:

- Converts CRLF to LF.
- Collapses runs of spaces/tabs outside string literals (`"..."`, `'...'`)
  and template literals (`` `...` ``, including their `${}` interpolations
  treated as code, not string content) to a single space.
- Comments (`//...` to end of line, `/*...*/`) are copied through verbatim,
  like literals — their contents are never touched, and a quote inside a
  comment never starts string-literal state.
- Trims trailing whitespace from each line.
- Does **not** reorder, rename, delete, or otherwise touch anything else —
  a real difference in generated code always shows up as a diff.

## Whitespace in a twin

MX follows Marko's whitespace rule, not JSX's, and the rule is **line-based**
(decision 33): split a text run into lines, trim each line, drop the lines
that are then empty, join what remains with a single space, then collapse
internal whitespace runs to one space. Boundary trimming against sibling tags
applies on top of that.

What this means when writing a twin:

| MX source | Renders | Note |
|---|---|---|
| `\n  static\n  ` before `<span>` | `static` | Indentation is dropped, **not** collapsed to a space — no trailing space before the sibling |
| `a\n  b` | `a b` | Two non-empty lines join with one space, so prose across a line break still reads as prose |
| `\n  ` between two elements | nothing | Every line trims to empty, so the whole run disappears |
| `a b` / `<span>a</span> <span>b</span>` | one space | A whitespace run with no newline is a deliberate space |

So a twin can be indented the way a JSX author would naturally write it: MX
and JSX agree except that MX drops indentation JSX would keep.
`fixtures/attrs` exercises the first row. `${" "}` is MX's escape hatch when a
space is wanted where the rule would drop one.

## `skipped` and `pending` are not `pass`

A `.solid.mx` compile reports `skipped` when no MX parser is wired in at all
(the harness throws `MxParserUnavailable`), and `pending` when the fixture
carries a `PENDING` marker. Neither is a pass. `bun run oracle` prints a loud
`ALL SKIPPED` banner whenever every row is skipped as a reminder, and
`--strict` fails the run on either status.

`@mxlang/tsx-bridge` is wired in now, so a `skipped` row means the parser genuinely
failed to load — treat it as a failure, not as "not implemented yet".

## `bun run oracle` flags

- `--strict` — also fail (non-zero exit) when any row is `skipped` or
  `pending`. Use this in CI to catch a fixture regressing back to unparseable
  and to keep `PENDING` markers from going stale.
- `--update` — force-rewrite every golden snapshot, not just missing ones.
  See "Golden snapshots" above.

Flags pass through `bun run`, e.g. `bun run oracle -- --strict --update`.

## `oracle:marko`: Marko parity for the stock `.marko` fixture set

Decision 51: the parity target for Marko syntax is Marko itself, not Solid.
Decision 68 retired the `.mx` dialect and `@mxlang/html`, so there is one
dialect (stock Marko) and one table. `bun run oracle:marko`
(`packages/oracle/src/report-marko.ts`, delegating to
`report-marko-stock.ts`) renders every fixture under
`packages/targets/html/fixtures-marko/<name>/` (`input.marko`, `input.json`,
`expected.html`, plus any sibling component or `tags/` directory) two ways —
through the real Marko 6 toolchain (`@marko/compiler` + `marko/translator`)
and through `@mxlang/target-html`'s own `compile()` — and compares both
against that fixture's `expected.html` for **semantic** equality —
`htmlEquals()` (`packages/oracle/src/normalize-html.ts`) parses both sides
with `parse5` and compares decoded tag names, attribute names/values, text
content and comment content, not raw string spelling. A round-1 regex-based
raw-string normalizer could not tell a real content difference from a
spelling one (`&gt;` vs `>` never compared equal as strings, so it could not
confirm whether an unescaped character was a genuine escaping gap or a safe
alternate spelling); parsing decodes both the same way a browser would, so a
match there means the same rendered output. Before comparison, a trailing
Marko resume/hydration marker (`<!--M_$…--><script>…</script>`) is stripped —
hydration plumbing with no `@mxlang/target-html` equivalent, not template
content, and its id/script body is randomly generated per compile so it could
never byte-match regardless. Not compared: attribute quote character, entity
spelling, void self-closing spelling, or inter-tag whitespace (all collapsed
before parsing). Attribute *order* is compared — a real reordering still
shows as a mismatch.

Prints a `fixture | marko | translator | verdict` table plus a `processed: N
stock fixtures (minimum required: N)` footer. `bun run oracle:marko --
--strict` accepts the same `--strict` flag as `oracle` for CLI symmetry, but
the two do not mean the same thing: `oracle --strict` fails on any
`skipped`/`pending` row, while `oracle:marko --strict` does **not** fail on a
recorded, reasoned skip or divergence — that classification *is* the settled
state here, not an unfinished one. The run fails (in either mode) if the
fixture glob expands to nothing, if any fixture directory is missing
`input.marko`, `input.json` or `expected.html`, or if fewer than the required
minimum were actually processed — a broken glob must never read as a silent
pass (decision 55).

This asks a narrow, strict question: for a template an ordinary Marko user
would write, does the expressions-only translator emit what Marko's own
server render emits? **Every fixture is expected to pass**, and a skip needs a
decision-65 reason — *this target cannot*, never *my code cannot*. See
`packages/targets/html/README.md`'s policy table (decision 65) for what "this
target cannot" means in practice, and the script's own footer for the current
pass/skip/bug count — the authoritative number, not one retyped here.

Same comparison (`htmlEquals`, parse5, decoded content, resume markers
stripped) and the same decision-55 floor: the run fails if the glob expands
to nothing, if a fixture is missing one of its three files, or if fewer than
25 fixtures were processed. `meta.json` classifies a skip or divergence
exactly as it does for the first table.

`expected.html` is generated by rendering the fixture through the real Marko
6 toolchain, never written by hand — a hand-written expectation proves only
that two of our own opinions agree.

### `meta.json`: the Marko column's skip/divergence marker

An optional `meta.json` in a fixture directory classifies why that fixture's
real-Marko rendering does not match `@mxlang/target-html`'s:

```json
{ "marko": "skip", "reason": "why this fixture is never compiled by Marko" }
```
```json
{ "marko": "divergence", "reason": "why the mismatch is expected and accepted" }
```

- `"skip"` — the fixture is never rendered through Marko at all; the table
  shows `skipped (reason)` for both columns. Use this only when compiling
  through Marko cannot be made to work at all (not yet used by any fixture
  here — every fixture compiles, even the ones that then mismatch or error at
  render time).
- `"divergence"` — both sides are rendered and compared as normal; a mismatch
  (including a Marko compile/render error) is expected and reported as
  `skipped (reason)` instead of `mx bug`. Used for a real, understood
  difference: a settled MX decision Marko does not share (S3's attribute-tag
  calling convention; S11/decision 47's lowercase-binding dispatch, which
  covers both an imported component and a `<define>`d tag called by name),
  a documented parser limitation the `<fragment>` wrapper works around
  (`notes/team-standalone-mx.md`'s defect 3), or a genuine Marko-side
  behavior with no MX equivalent to reconcile against (dropping HTML
  comments; `<fragment>` as an explicit multi-root wrapper being unnecessary
  and rejected outright; requiring a taglib entry for an unknown custom tag;
  leaving an element-less template's sole placeholder unescaped). Every
  reason cites the specific decision, doc, or verified Marko behavior it
  rests on — never a way to silence an unexplained failure. A `meta.json`
  with `marko: "skip"` and no `reason` fails the run.
- No `meta.json` — the fixture is expected to match both ways. A mismatch is
  reported as `mx bug` and always fails the run, `--strict` or not.

`report-marko.ts`'s own top-of-file comment is the authoritative contract;
this section is a summary.
