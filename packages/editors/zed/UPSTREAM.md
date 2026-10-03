# Upstream provenance

`packages/editors/zed` ships three languages for Zed:

- `MX` (`.mx`, decision 72's official and only extension — MX only supports
  the MX 1.0 subset of Marko syntax), backed by the **unmodified**
  `marko-js/tree-sitter` grammar. Restored after decision 68's retirement:
  decision 72 re-establishes `.mx` as MX's own identity (a strict subset of
  Marko syntax, not the retired dialect), which is what lets it reuse
  Marko's grammar and queries with zero changes.
- `SolidMX`, backed by this monorepo's own `packages/editors/tree-sitter-solidmx` — a
  patched `tree-sitter-typescript` (tsx dialect) with an `mx_element`
  external token in expression position. That package's own `UPSTREAM.md`
  owns its `tree-sitter-typescript` pin and patch; this file only records how
  its output is wired into the extension.

## Pins

| Source | Repo | Rev | What's taken |
|---|---|---|---|
| MX grammar | `marko-js/tree-sitter` | `7fb20382b9b0c97c8bdbceee0e0641bea11dd00f` (`@marko/tree-sitter` v0.2.0) — same rev the official `marko-js/zed` extension's own `extension.toml` pins, fetched via `gh api repos/marko-js/zed/contents/extension.toml` on 2026-09-11 | `[grammars.marko]` in `extension.toml`. Zed clones this repo at that rev and compiles the grammar itself; no local vendoring needed. |
| MX queries | `marko-js/zed` (`languages/marko/*.scm`) | snapshot `dd854edec1fab86d23eb24af9691505dfe3856a6` (repo `main` HEAD at fetch time, via `gh api repos/marko-js/zed/contents/languages/marko/<file>`) | `languages/mx/{highlights,injections,brackets,outline}.scm`, copied **verbatim** with a 3-line header comment naming source + rev — no overlay, no edits (decision 72: MX 1.0 is a strict subset, so Marko's own queries apply as-is). `languages/mx/config.toml` is hand-written (not copied): `name = "MX"`, `path_suffixes = ["mx"]`, same `brackets`/comment conventions as the official file. |
| AstroMX queries | `languages/mx/*.scm` (in this package, themselves verbatim from `marko-js/zed`) | same snapshot as the MX row, `dd854edec1fab86d23eb24af9691505dfe3856a6` | `languages/astromx/{highlights,injections,brackets,outline}.scm`, copied from `languages/mx/` with a header naming both hops. AstroMX (`.astro.mx`, decisions 76c/78) is an Astro component whose *template* is MX, so it rides the same `marko` grammar and the same queries — **no new `[grammars.*]` entry**, and nothing new for `zed-compile-check` to cover. `languages/astromx/config.toml` is hand-written: `name = "AstroMX"`, `path_suffixes = ["astro.mx"]`. Known limitation recorded there: Marko's grammar has no `---` frontmatter notion, so the fence highlights as Marko markup rather than TypeScript; the official `zeds/astro` grammar (`virchau13/tree-sitter-astro`) is the wrong trade, since it parses a fence plus an **HTML/JSX** body and would mis-parse the entire MX template. |
| SolidMX grammar | `packages/editors/tree-sitter-solidmx` (in this monorepo) | working-tree HEAD, referenced by `extension.toml`'s `[grammars.solidmx]` `rev` as a **committed sha** (dev form: `file://` + `path`) | Zed clones this monorepo at that sha and compiles `packages/editors/tree-sitter-solidmx/src/{parser.c,scanner_mx.c,scanner.c}`. Also the source of `queries/highlights.scm`, copied (not fetched over the network — it's a local sibling package) by `scripts/vendor.sh` into `languages/solidmx/highlights.scm`. |

`extension.toml`'s `name` and `description` are hand-written; `id = "mxlang"`
is unchanged, since the extension id is a publishing identity, not a
language name.

| Source | Repo | Rev | What's taken |
|---|---|---|---|
| Rust extension shape | `marko-js/zed` (`Cargo.toml`, `src/lib.rs`, `extension.toml`) | `dd854edec1fab86d23eb24af9691505dfe3856a6` (repo `main` HEAD at fetch time, via `gh api repos/marko-js/zed/contents/{Cargo.toml,src/lib.rs,extension.toml}` on 2026-09-11 — the same rev already pinned above for the MX queries) | `crate-type = ["cdylib"]`, `zed_extension_api = "0.7.0"` (exact version, matching that `Cargo.toml`'s own unpinned-minor spelling), the `zed::Extension::language_server_command` shape (a `Command` built from a resolved binary path + `--stdio`), and `[language_servers.<key>]`'s `name`/`languages` table shape in `extension.toml`. **Not** taken: marko-js/zed's npm-download machinery (`npm_package_latest_version`/`npm_install_package`, the `did_find_server` cache, the two TS-plugin initialization-options hooks) — decision 77's brief is explicit ("keep it minimal: no settings, no downloads"), so `src/lib.rs` here only resolves a command path (a local worktree install via `Worktree::read_text_file`, then a global install via `Worktree::which`, then `bunx`, then `npx` — no `node_modules/.bin` walk-up, since `Worktree` exposes no such operation and a plain `std::fs`/`Path` walk cannot see worktree paths under Zed's wasm sandbox) and does no installation of its own. |

There is no `scripts/vendor.sh` step for `languages/mx/*.scm` — unlike
`languages/solidmx/*.scm` (generated from a local sibling package plus a
base+overlay split), MX's queries are a straight verbatim copy from a
network source with no local base or overlay to merge, so a copy-once
fetch (recorded above) plus a manual re-fetch on drift is the whole
procedure. `.github/workflows/upstream-check.yml`'s `vendored-files-match`
job does not cover `languages/mx/*.scm` for the same reason decision 55
gives for skipping a "check" mode with nothing to regenerate against
in-repo — see "No `vendor.sh --check`" below, which is about
`languages/solidmx/*.scm` specifically; MX's files are checked by manual
diff against the upstream repo on a deliberate bump, not by CI.

SolidMX has no equivalent of `marko-js/zed` to source `injections.scm`,
`brackets.scm` and `outline.scm` from — no reference Zed extension for this
grammar exists. Those three query names' base content is hand-authored in
`base/solidmx/*.scm` (see "Local modifications" below).

## Local modifications

`languages/solidmx/highlights.scm` is
`packages/editors/tree-sitter-solidmx/queries/highlights.scm` (that package's own,
already-final query — see its `UPSTREAM.md`) plus
`overlay/solidmx/highlights.scm` concatenated on. `injections.scm`,
`brackets.scm` and `outline.scm` have no upstream source at all, so their
base content lives in this package's own `base/solidmx/*.scm` (hand-authored,
reviewed like any other source file) with `overlay/solidmx/*.scm`
concatenated the same way. All four SolidMX overlay files are currently
empty: the base content already covers every node the grammar emits.

`base/solidmx/injections.scm` injects the `marko` language into `mx_element`
(MX and SolidMX share syntax) so the otherwise-opaque region highlights
instead of remaining plain text.

### SolidMX injection prerequisite

`base/solidmx/injections.scm` sets `injection.language "marko"`. Zed resolves
an injected language by matching that string against an **installed
language's own `name`** (case-insensitively) — it is not a reference to a
grammar this extension declares, and not a reference to this package's own
`MX` language either: `languages/mx/config.toml` declares `name = "MX"`, not
`"Marko"`, so it cannot satisfy this injection despite compiling the same
grammar. The only language that can satisfy it is Zed's official
`marko-js/zed` extension, whose `languages/marko/config.toml` declares
`name = "Marko"` (confirmed by reading that file at its published rev).
"Marko" lowercases to "marko", so the match holds — **but only when that
extension is installed**. Without it, `mx_element` regions in a `.solid.mx`
file fall back to unhighlighted plain text; this is a missing prerequisite,
not a bug in this package. See `README.md` for the user-facing prerequisite
note.

This package's own `[grammars.marko]` (added for `MX`, see the Pins table
above) is unrelated to this injection — it exists so Zed can compile the
grammar for files matching `MX`'s `path_suffixes`, not to provide an
injectable language named `marko`/`Marko` (the injection matches on
language *name*, and `MX` ≠ `Marko`).

`extension.toml` deliberately omits `[language_servers.marko]`, `src/lib.rs`
and `Cargo.toml` — a grammar-only extension needs no Rust build (Zed's
`extension_builder.rs` only runs the Rust build when `Cargo.toml` exists).

## Bump procedure — SolidMX

SolidMX has two independent "bumps": the grammar itself (owned by
`packages/editors/tree-sitter-solidmx`) and this extension's wiring to it.

**Grammar change** (new scanner fix, new upstream `tree-sitter-typescript`
pin, etc.) — see `packages/editors/tree-sitter-solidmx/UPSTREAM.md`'s own bump
procedure. That package's changes must land as **committed** commits before
they can reach Zed at all (see "A note on the `file://` dev loop" below).

**Extension wiring change** (this package):

1. If `packages/editors/tree-sitter-solidmx/queries/highlights.scm` changed, or
   `base/solidmx/*.scm` needs updating for a new node the grammar now emits:
   edit the source (the grammar package's file, or this package's
   `base/solidmx/*.scm` — never `languages/solidmx/*.scm` directly).
2. Regenerate: `./scripts/vendor.sh` (no args). This rewrites
   `languages/solidmx/*.scm` from `packages/editors/tree-sitter-solidmx`'s highlights
   query, `base/solidmx/*.scm`, and `overlay/solidmx/*.scm`.
3. If the grammar itself changed (new commit under
   `packages/editors/tree-sitter-solidmx`): `git rev-parse HEAD` and update
   `extension.toml`'s `[grammars.solidmx]` `rev` to the new sha — see
   `README.md`'s "Dev install (Zed) — SolidMX" for the full commit-then-bump
   loop.
4. Reinstall the dev extension in Zed and spot-check highlighting, bracket
   matching, outline, and the `marko` injection on a `.solid.mx` file (needs
   the official `marko-js/zed` Marko extension also installed — see
   "SolidMX injection prerequisite" above).
5. Commit `languages/solidmx/*.scm`, any changed `base/solidmx/*.scm`,
   `extension.toml` (if `rev` moved), and this file together.

### A note on the `file://` dev loop

Because `[grammars.solidmx]`'s `rev` must be a real commit sha, **there is no
way to iterate on the grammar and see the result in Zed without committing
first.** Expect to commit more often than feels natural while iterating on
`packages/editors/tree-sitter-solidmx` under active Zed testing — that is the cost of
a `file://` dev dependency, not a workflow mistake.

## No `vendor.sh --check`

This script has no `--check` mode (the retired MX language's version did —
it compared `marko-js/tree-sitter`/`marko-js/zed` pins against upstream
HEAD). SolidMX's `highlights.scm` source is `packages/editors/tree-sitter-solidmx`, a
local sibling package with no networked upstream HEAD to drift against, so a
"check" mode here could only ever report success — decision 55: a gate that
cannot fail is not a gate. `moon.yml`'s `vendor-check` task and
`package.json`'s `vendor:check` script were removed along with it.
`.github/workflows/upstream-check.yml`'s `vendored-files-match` job is the
real check: it regenerates and diffs against committed output.
