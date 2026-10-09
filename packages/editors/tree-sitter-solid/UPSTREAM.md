# Upstream: `tree-sitter-typescript`

This package vendors the tsx dialect of `tree-sitter-typescript` and patches it
so that `<` in expression position opens an MX region rather than JSX.

## Pin

| Field | Value |
|---|---|
| Repository | `https://github.com/tree-sitter/tree-sitter-typescript` |
| Tag | `v0.23.2` |
| Commit | `f975a621f4e7f532fe322e13c4f79495e0a7b2e7` |
| Date | 2024-11-10 |

`v0.23.2` is the latest *tag*. `main` has moved ahead (`75b3874`, 2025-01-30)
but is untagged; the pin follows the tag deliberately.

`vendor/` is not committed (see `.gitignore`) — it is reconstructed from this
pin plus `patches/` by `scripts/vendor.sh`. What *is* committed is the generated
output in `src/`, because Zed compiles that directly and never runs
`tree-sitter generate`.

## Toolchain used to generate the committed output

| Tool | Version |
|---|---|
| `tree-sitter-cli` | **0.26.9** |
| `tree-sitter-javascript` | 0.23.1 |

Both are exact-pinned devDependencies (no `^`/`~`), matching the repo's
exact-pin policy. `tree-sitter-typescript` v0.23.2 declares
`tree-sitter-cli: ^0.24.4`, so 0.26.9 is inside upstream's own supported range.
(2026-09-13, zed-solidmx-followups: this table previously said 0.24.7, which
no longer matched `package.json`'s actual pin — `src/parser.c` had to be
regenerated during that task anyway to fix an unrelated grammar-patch defect,
which is the deliberate CLI-version bump this file's own warning below asks
for; corrected here rather than left to drift further.)

### `tree-sitter-cli` version split (resolved): 0.26.9 for the wasm build fallback too

(2026-10-09, ci-docker-hub-rate-limit) `scripts/zed-compile-check.sh`'s
`tree-sitter build --wasm` fallback path (used when Zed's own wasi-sdk clang
isn't installed — always true on CI) now runs `bunx --package
"tree-sitter-cli@0.26.9"`, the same version as `package.json`. 0.26.9's
`build --wasm` downloads its own wasi-sdk, so the fallback needs neither
Docker nor a local emsdk, and it compiles the clean clone's committed `src/`
as-is; `tree-sitter-mx`'s own `zed-compile-check.sh` already worked this way.
`ZED_COMPILE_CHECK_WASM_BUILD_ARGS` stays as a pass-through, empty by default.

History: from 2026-09-13 (round 3 of zed-solidmx-followups) this pin was
0.24.7, because 0.26.9 dropped `build --wasm`'s `--docker` flag and CI passed
`--docker` (`tree-sitter-amx` was briefly bumped and reverted for the same
reason, commit `11d1acaf`). `--docker` pulled an emscripten image from Docker
Hub anonymously, and once the unauthenticated pull rate limit was hit
(`toomanyrequests`) every PR's `zed-compile-check` and `test-bun-grammar`
went red. 0.24.7 also regenerated `src/parser.c` from `grammar.js` before
compiling, so it never compiled the committed parser. Do not reintroduce
`--docker` or a Docker-based fallback.

**Regenerating with a different CLI produces a different `src/parser.c`.** That
shows up as a large spurious diff, so bump the CLI deliberately and say so in
the PR — never let it drift as a side effect.

`tree-sitter` is not on PATH on the operator's machine. Every script invokes it
through the package manager (`bunx tree-sitter`); no script may assume a global
binary.

## Layout

- `common/define-grammar.js` — the real grammar, as a function of dialect,
  extending `tree-sitter-javascript`. **This is the only file MX patches.**
- `common/scanner.h` — the shared external scanner. Vendored **untouched**; the
  MX scanner lives in `src/scanner_mx.c` so an upstream rewrite of this file
  fails loudly at the vendor step instead of silently merging into MX code.
- `tsx/grammar.js` — two lines calling `defineGrammar('tsx')`. MX's own
  `grammar.js` at the package root plays this role, calling
  `defineGrammar("tsx", "solid")`.

`tsx/src/parser.c` is ~8.4 MB upstream and MX's generated `src/parser.c` is
~8.1 MB. First clang compile is slow (tens of seconds); that is a known,
expected cost of `tree-sitter test` / `parse` / `highlight` after a regenerate,
not a symptom of a problem.

## Committed copy of `scanner.h`

`src/tree_sitter_typescript_scanner.h` is a byte-identical copy of
`vendor/tree-sitter-typescript/common/scanner.h`, refreshed automatically by
`./scripts/vendor.sh` (its normal, non-`--check` mode) and diffed against the
freshly-fetched pin by `./scripts/vendor.sh --check`. `src/scanner.c`
`#include`s this copy, never the `vendor/` path directly.

This exists because `vendor/` is `.gitignore`'d (see "A real defect this
caused" below) — it is reconstructed from the pin on demand, not committed.
`src/`, by contrast, is committed in full, because Zed compiles it directly
and never runs `tree-sitter generate` (see "A real defect this caused"). A
header `src/scanner.c` needs to compile must therefore live inside `src/`
itself, copied rather than included from outside it.

## A real defect this caused

**Zed's file:// dev install of this grammar failed to compile** the first
time it was tried (`~/Library/Logs/Zed/Zed.log`):

```
failed to compile grammar 'solidmx': failed to compile solidmx parser with clang:
.../grammars/solidmx/packages/editors/tree-sitter-solidmx/src/scanner.c:18:10:
fatal error: '../vendor/tree-sitter-typescript/common/scanner.h' file not found
```

Root cause: `src/scanner.c` originally `#include`d
`"../vendor/tree-sitter-typescript/common/scanner.h"` directly.
That path resolves fine from a working tree, where `scripts/vendor.sh` has
populated `vendor/` — every check that ran before this was caught
(`tree-sitter test`, `scripts/parse-all.sh`, `scripts/highlight-smoke.sh`, CI)
compiles from the working tree and could not see the problem. Zed's `file://`
dev install, per Z7, git-clones this repo **at the pinned committed rev** and
compiles only what's there — `vendor/` is `.gitignore`'d, so it simply isn't
present in that clone.

Fixed by copying the header into `src/tree_sitter_typescript_scanner.h` (see
above) and changing the `#include` to the relative, in-`src/` path. Guarded
by `scripts/zed-compile-check.sh`, which reproduces Zed's own compile step
against a **clean clone of HEAD** (never the working tree) — the class of
gate that would have caught this before a real dev install did. Run via
`bun run zed-compile-check` or as the last step of `bun run test`
(`scripts/test.sh`). Confirmed failing against the pre-fix commit and passing
after — see `scratch/reports/zed-solidmx.md`.

## A second, related defect found while adding `--check` coverage for it

Verifying the header-copy fix's `--check` mode surfaced a second, independent
and pre-existing bug: **`apply_patches` silently no-op'd on every run.**
`fetch_upstream` stripped `vendor/tree-sitter-typescript/.git` before
`apply_patches` ran; `git -C <dir> apply` with no real repo at `<dir>`
resolves `-C` **upward** to whatever repo actually encloses it (this
package's own monorepo), the patch's paths (`common/define-grammar.js`)
don't exist there, and `git apply` reports "Skipped patch" while exiting 0.
`vendor/tree-sitter-typescript/common/define-grammar.js` was therefore always
the unpatched upstream file — no `mx_element`, no `defineGrammar(dialect,
name)` — even though every prior `./scripts/vendor.sh` run printed "patches
applied" and exited 0.

This did **not** corrupt the committed `src/parser.c`/`grammar.json` — those
were generated correctly at some point before this ordering bug's effect
took hold, and `tree-sitter generate` after the fix reproduces them
byte-identically (confirmed). It would have corrupted the **next** bump: a
future `./scripts/vendor.sh` re-vendor, followed by `bun run generate`, would
have silently regenerated an unpatched (plain tsx, no MX) grammar, and
nothing before this would have caught it — `tree-sitter test`'s corpus
compiles from committed `src/`, not from a fresh `vendor.sh` run.

Fixed by reordering: `fetch_upstream` now leaves `.git` in place;
`apply_patches` applies the patch, verifies success, *then* strips `.git`.
`apply_patches` also now refuses to run at all against a directory with no
`.git` (`exit 1`, not a silent no-op) as a second line of defense.
`--verbose` on the `git apply` call makes success/no-op visibly different in
every future run's output ("Applied patch ... cleanly" vs. "Skipped patch").

## Local modifications

All of them live in `patches/*.patch`, produced with `git format-patch` and
applied in order by `scripts/vendor.sh` (a plain `git apply` per file, not
`git am`, so each patch just needs to apply cleanly against the previous
one's result — see "A third defect" below for why a patch is edited by
adding a new file, never by rewriting an existing one in place). Both patches
touch only `common/define-grammar.js`:

`0001-*.patch`:

1. **`externals`** — declare `mx_element`, the opaque whole-region token.
2. **`expression`** — in the `tsx` branch, drop `_jsx_element` (the choice of
   `jsx_element` / `jsx_self_closing_element`) and add `mx_element` in its
   place. This is what makes `<` in expression position start MX, not JSX.
3. **`defineGrammar(dialect, name = dialect)`** — take the grammar *name* as a
   second parameter. The generated C symbols derive from the name
   (`tree_sitter_solid_external_scanner_scan`), so Solid must be named
   `solid` while still selecting every `tsx` dialect branch. Defaulting to
   `dialect` leaves upstream's own two grammars unaffected.

`0002-*.patch` (task `solidmx-grammar-fragments`):

4. **`externals`** — declare `mx_fragment_open` and `mx_fragment_close`
   (`<>` / `</>`), scanned by `src/scanner_mx.c`'s `mx_scan_at_lt`.
5. **`expression`** — in the `tsx` branch, additionally push `$.mx_fragment`
   alongside `$.mx_element`.
6. **`rules.mx_fragment`** — `seq(mx_fragment_open, repeat(choice(mx_element,
   jsx_expression, mx_fragment)), mx_fragment_close)`. Each `<tag>` child is
   an ordinary `mx_element`; `jsx_expression` (from the base JS grammar,
   reachable directly since it is a named rule, not inlined) is the `{expr}`
   child; `mx_fragment` recurses for nesting. No direct text child is
   declared, so `<>` with bare text in it is a grammar-level parse error.

### Deliberately NOT carried over

Upstream declares `[$.jsx_opening_element, $.type_parameter]` in `conflicts` so
GLR can explore both `<T,>(x) => x` and `<div>`. MX declares **no** equivalent
for `mx_element`, and adding one is an error rather than harmless: `mx_element`
is a single external *token*, so the decision is made in the lexer and never
reaches a GLR fork. `tree-sitter generate` reports the declaration as
`Warning: unnecessary conflicts`.

**Where the `<T,>` / `<T extends U>` check actually happens:** in the lexer's
external-then-internal fallback — at a `<` in expression position tree-sitter
offers the external `mx_element` first, the scanner scans forward for a matching
close tag, finds none before the input ends, and returns false, whereupon
tree-sitter re-lexes the same position internally and the ordinary `<` token
yields `type_parameters`.

So a generic arrow is rejected by the scanner *failing to find an element*, not
by any lookahead, precedence or conflict. Verified with `tree-sitter parse
--debug`: at the `<` of `<T,>(x: T) => x` the trace shows `lex_external` running
and consuming to end-of-line, then `lex_internal` re-lexing from the original
column and emitting `sym:<`. An instrumented build confirms the scanner *is*
offered that position (so `valid_symbols` is not what declines it).

`test/corpus/generics.txt` pins both directions: `<T,>`, `<T extends U>` and
`<A, B>` parse as `type_parameters`, while `<div>` and `<div.card>` parse as
`mx_element`.

## What the corpus is measured against

`test/corpus/*.txt` is scored against **`notes/zed/solidmx-corpus-checklist.md`**
— 74 catalogued constructs from spec sections 3 and 4, derived from the Solid
spec by the squad rather than from this grammar. That file lives in the
operator's `notes/` at the project-space root and is **not versioned with this
repo**, so record the number here for it to mean anything later:

**Coverage at the time of writing: 59 of 74 constructs.** The uncovered ones are
checklist 56-59 (`<let>`, `<const>`, `<effect>`, `:=`), which the checklist
itself marks NON-GOAL for v1, plus entries that are file-level or lowering-level
rather than syntactic (60-61, 69, 74-88) and so have no distinct parse to pin.

Note what a corpus entry can and cannot assert here. The MX region is one opaque
token, so a construct's test pins **that the scanner finds the right region end**
— not that the construct is semantically valid. The legacy namespaces
(`on:`/`oncapture:`/`attr:`/`bool:`/`use:`, checklist 20-24), `fallback=<Spin/>`
(32, 68) and `<for step=>` (46) are all specified as *parse errors*, but they are
errors raised by `@mxlang/tsx-bridge` during lowering, not by this grammar:
`test/corpus/legacy-namespaces.txt` pins that each still scans as a
well-formed `mx_element` so the editor highlights the line instead of collapsing
the rest of the file into an error node. Diagnosing them is the parser's job.

## Bump procedure

1. Update `PIN_SHA` / `PIN_TAG` in `scripts/vendor.sh` and the table above.
2. `./scripts/vendor.sh` — fetches the new pin and applies `patches/`. If a
   patch does not apply, upstream moved under it: rebuild the patch rather than
   editing `vendor/` by hand.
3. Re-check the external token order. `src/scanner_mx.c`'s `enum MxTokenType`
   holds *indices into `valid_symbols`* and must match `src/grammar.json`'s
   `externals` array exactly:

   ```sh
   python3 -c "import json; print([e.get('name') or e.get('value') for e in json.load(open('src/grammar.json'))['externals']])"
   ```

   An off-by-one here is silent — the scanner reads another token's flag, never
   fires, and every MX region degrades to a TypeScript parse error. This
   actually happened during development.
4. `bun run generate` (takes the `flock /tmp/mx-zed-generate.lock` lock).
5. `bun run test` — corpus, then the parse and highlight gates.
6. Commit the regenerated `src/` and record the CLI version above if it changed.

## Drift detection

`./scripts/vendor.sh --check` re-fetches the pin into a temporary directory,
applies `patches/`, and diffs the result against `vendor/` for the three files
the build consumes. It exits non-zero on any difference, so a hand-edit to
`vendor/` that was never captured as a patch — the edit the next re-vendor would
silently revert — fails the check instead of surviving to surprise someone.

## A third defect: a corrupted patch file with no regeneration to catch it

(2026-09-13, zed-solidmx-followups) A prior change to `patches/0001-feat-
grammar-replace-JSX-with-an-opaque-mx_element-t.patch` intended to add a
`<>` TSX-fragment rule **replaced the entire 92-line base patch with a
33-line patch containing only the new fragment hunk** — silently deleting
the `externals: mx_element` declaration and the `expression` override that
makes `<` in expression position open MX instead of JSX. Every check that
ran against the working tree (`tree-sitter test`, `parse-all.sh`,
`highlight-smoke.sh`) kept passing, because `src/grammar.json`/`src/
parser.c` in `src/` — the *committed*, already-generated output Zed actually
compiles — were never regenerated from the corrupted patch. Running
`tree-sitter generate` from the corrupted `vendor/` (this task's first
verification step) failed immediately with `ReferenceError: Undefined
symbol 'mx_element'`, proving the committed `src/` had silently gone stale
relative to `patches/`.

Two lessons, both now load-bearing for anyone editing `patches/`:

- **A patch file is not additive by convention — writing to it with `>`
  instead of appending a new hunk destroys prior hunks with no error at
  apply time**, since `git apply`/`patch` on a shorter, internally-valid
  file just applies fewer changes; nothing here fails loudly on a corrupted
  *patch*, only on a corrupted *result* once someone regenerates from it.
  Diff a patch edit against its previous committed version (`git diff`)
  before trusting it, especially when the edit was meant to *add* a hunk.
- **"Regenerated the parser" is a claim that must be checked by actually
  running `tree-sitter generate`, not inferred from `tree-sitter test`
  passing.** `test`/`parse-all.sh`/`highlight-smoke.sh` all compile
  whatever `src/parser.c` already exists on disk; none of them detect that
  it no longer matches `vendor/`'s current grammar.js. Only `generate`
  itself, or `vendor.sh --check` plus a `generate`, catches this class of
  drift — see "A real defect this caused" above for the analogous case with
  `scanner.h`.

The TSX-fragment feature that patch was attempting could not be completed
in this task's time budget after the corruption was fixed and the base
patch restored — see the differential-test PR's report for the grammar-level
blocker found (the external `jsx_text` scanner does not recognize a
fragment's own bespoke opening-tag production the way it recognizes
`jsx_opening_element`'s real one).

**Resolved (task `solidmx-grammar-fragments`): the scanner-level route.**
The grammar-level route above was abandoned rather than fixed — reusing
upstream's `jsx_element`/`jsx_text` machinery for `<>` fights the same
external-scanner ordering problem no matter how the grammar rule is shaped,
because `jsx_text` is itself an external token and the two scanners cannot
negotiate a shared "we are inside a fragment" state without one knowing
about the other. Fragments are unrelated to that machinery entirely: `<>`
and `</>` are their own tokens, `mx_fragment_open`/`mx_fragment_close`
(`common/define-grammar.js`'s new `mx_fragment` rule; scanned in
`src/scanner_mx.c`'s `mx_scan_at_lt`), and each child `<tag>...</tag>` is
independently scanned as its own ordinary `mx_element` — matching
`collectMxRegions` (`packages/babel/src/plugins/jsx/index.ts`
`jsxParseElementAt`: `<>` falls through to ordinary Babel JSX-fragment
parsing since the tokenizer is already sitting on `tt.jsxTagEnd`, and only
each child's own `<tag>` recursion re-enters the MX bridge). No `jsx_text`,
no `jsx_element`, no reference to upstream's JSX rules at all.

The one real pitfall, found by instrumenting the scanner: **a `TSLexer`
cannot unconsume.** `mx_element` and both fragment tokens are valid at the
same grammar position (both are alternatives of `expression`/`mx_fragment`'s
own `repeat`), so the first design tried the natural thing — call
`mx_scan_element_token`, and on decline, call a separate
`mx_scan_fragment_token`. That fails: `scan_mx_element` advances past the
leading `<` before checking the next character, and when it declines (on
`<>`) the *next* nested C call in the *same* `external_scanner_scan`
invocation starts with the lexer already sitting past `<`, not back at it —
tree-sitter only resets lexer position between **separate** calls to that
entry point, never between two scan attempts chained inside one. The fix is
`mx_scan_at_lt`: one function that consumes `<` exactly once, decides
open/close-fragment vs. element from the very next character, and either
returns immediately (fragment) or falls straight into
`scan_mx_element_body` (element) without a second consumption of `<`.
Confirmed by parsing `<T,>(x: T) => x` (still rejected, `type_parameters`
wins) and `<div>...</div>` (still one opaque `mx_element`) after the change
— the reordering did not regress the pre-existing element/generic-arrow
disambiguation.

`test/corpus/fragments.txt` now pins two-child, empty, nested, and
`{expr}`-child fragments, a fragment as a function's return expression, and
that `<>` written *inside* an MX region's own text body is still literal MX
text (scanner-rules §9.2), not a fragment delimiter. `scripts/differential.ts`
confirms `fixtures/fragments/input.solid.mx` produces the exact same
`mx_element` region set from tree-sitter and from
`@mxlang/tsx-bridge`'s `collectMxRegions` — one region per fragment child, none
for the fragment shell itself, since the shell is plain Babel `JSXFragment`
with no `node.extra.mx` stamp of its own.
