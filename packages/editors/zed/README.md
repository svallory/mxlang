# `mxlang` — Zed extension

Ships four languages:

- `MX` (`.mx`, the only extension this language registers — MX only supports
  the MX 1.0 subset of Marko syntax) on Marko's own unmodified tree-sitter
  grammar, `[grammars.marko]` pinned to the same rev the official
  `marko-js/zed` extension pins (`7fb20382b9b0c97c8bdbceee0e0641bea11dd00f`,
  `@marko/tree-sitter` v0.2.0). `languages/mx/*.scm` are the official
  extension's `languages/marko/*.scm` copied **verbatim** (no overlay, no
  edits) — MX 1.0 is a strict subset of Marko syntax (decision 72), so
  Marko's own queries apply unmodified. Real `.marko` files are covered by
  installing the official [`marko-js/zed`](https://github.com/marko-js/zed)
  extension directly, a separate `Marko` language unrelated to this one.
- `SolidMX` (`.solid.mx`), backed by `packages/editors/tree-sitter-solidmx` (a
  patched `tree-sitter-typescript` tsx dialect with an `mx_element` external
  token in expression position).
- `AngularMX` (`.ng.mx`), backed by the same `tree-sitter-solidmx` grammar
  package — the grammar's only MX-specific addition (`mx_element`) is
  neither Solid- nor Angular-specific, so `languages/ngmx/config.toml`
  declares `grammar = "solidmx"` directly rather than this extension
  compiling a second, identical grammar.
- `AstroMX` (`.amx`) backed by `packages/editors/tree-sitter-amx` (a small grammar that splits the file into an optional `---` TypeScript fence and an MX template body) and Marko's queries for the body region.

Also registers a language server: `src/lib.rs` (a minimal Rust extension,
`Cargo.toml`) implements `zed::Extension::language_server_command` for
`@mxlang/language-server` on `MX` and `SolidMX` — see "Language server"
below.

## Toolchain prerequisite: Rust + wasm32-wasip1

Building the extension's Rust to the wasm target Zed itself builds to needs
the `wasm32-wasip1` target installed:

```
rustup target add wasm32-wasip1
```

This is a toolchain install, not a repo dependency (nothing in `bun install`
provides it). `rustup target list --installed` shows what's already there.
CI runs this step itself (see `.github/workflows/ci.yml`'s
`zed-compile-check` job) so a missing target fails loud rather than
silently skipping the build.

## Language server

`@mxlang/language-server` (decision 71/72/77) is a diagnostics-only LSP
server; see `packages/tooling/language-server/README.md` for what it does and does
not do. This package's `src/lib.rs` resolves the command to launch it, in
order:

1. A local install under the worktree: `node_modules/@mxlang/language-server/package.json`
   readable via `Worktree::read_text_file` (the sandbox-safe check — see the
   doc comment on `find_local_bin`/`language_server_command` in `src/lib.rs`
   for why a plain `std::fs`/`Path` check on a worktree path cannot work
   here: Zed's wasm sandbox preopens only the extension's own working
   directory, never the worktree root). If found, the command is
   `<worktree root>/node_modules/.bin/mxlang-language-server` — an absolute
   host path, spawned on the host, so it doesn't matter that the *check* ran
   inside the sandbox.
2. A global install: `Worktree::which("mxlang-language-server")`.
3. `bunx @mxlang/language-server --stdio`, via `Worktree::which("bunx")`.
4. `npx @mxlang/language-server --stdio`, via `Worktree::which("npx")`.

No installation, no settings — unlike `marko-js/zed`'s `MarkoExtension` (which
downloads `@marko/language-server` from npm into the extension's own working
directory), this extension expects the server to already be reachable one of
the four ways above. There is no walk-up past the worktree root: `Worktree`'s
API has no such operation, and no path outside the worktree is readable from
the sandbox at all — an earlier revision of this extension assumed a
`node_modules/.bin` walk-up like a Node script would do, which is dead code
under the sandbox (always "not found," silently falling through to `bunx`).

### Dev install (Zed) — language server

1. Make `@mxlang/language-server`'s built `bin.js` reachable one of the four
   ways `src/lib.rs` looks for it. Simplest in this monorepo: from the repo
   root, `bun run build` (builds every package, `language-server` included),
   then confirm `node_modules/@mxlang/language-server/package.json` and
   `node_modules/.bin/mxlang-language-server` both exist at the worktree
   root — bun workspaces symlink a workspace package's `bin` entries into the
   root `node_modules/.bin` automatically, so no extra linking step is needed
   once the package is built. If you're testing against a project outside
   this monorepo instead, install the package there (`bun add
   @mxlang/language-server` once published, or `bun link` against a built
   copy) so its own `node_modules` picks it up, or rely on the `bunx`/`npx`
   fallback.
2. Command Palette → **"zed: install dev extension"** → select
   `packages/editors/zed` (same directory as the grammar dev-install
   above).
3. Create a small test project with a `package.json` declaring:
   ```json
   { "mx": { "host": "html", "strict": true } }
   ```
   and an `.mx` file containing a `<let>` tag (rejected under `strict`, per
   `@mxlang/html`'s `strictPolicy` — see its own README).
4. Open that `.mx` file in Zed. Expect one diagnostic (source `mxlang`)
   naming the `<let>` construct as unsupported under the resolved policy —
   see `packages/tooling/language-server/README.md` "Policy resolution" for exactly
   how the `#mx` field is read.
5. Open a `.solid.mx` file with a `<let>` inside an MX region. Expect the
   Solid host diagnostic to point at the tag's position in the complete
   TypeScript file.
6. Check Zed's LSP logs regardless (command palette → **"zed: open language
   server logs"** → pick the `mxlang` server): expect a line naming the
   command that was launched, e.g. `mxlang server started with
   <path-or-bunx-command> --stdio` (exact wording is Zed's own, not this
   extension's) — confirming which of the four resolution steps fired.
   **A live Zed check is a manual step** — this task's own verification
   stopped at `cargo build`/the clean-clone compile-check; nobody has run the
   extension inside Zed yet, so treat the above as the procedure to follow,
   not a result already confirmed.
7. If no diagnostic appears: check the logs first for a spawn failure (none
   of the four resolution paths found the server) before assuming the
   diagnostic logic itself is wrong.

Grammar-only extension no longer describes this package (it now also ships a
language server) — see `UPSTREAM.md` for the Rust provenance and "What you
get in Zed today" below for what each language gets in practice.

## Zed suffix precedence: `.mx` vs `.solid.mx` vs `.ng.mx`

Zed's suffix matcher takes the text after a file's **last** dot as the
extension, then picks the language whose `path_suffixes` entry is the
**longest match**. `MX` declares `path_suffixes = ["mx"]`; `SolidMX` declares
`path_suffixes = ["solid.mx"]`; `AngularMX` declares `path_suffixes =
["ng.mx"]`. `Counter.solid.mx` matches both `MX` (its last-dot suffix is
`mx`) and `SolidMX` (`solid.mx` matches too via Zed's own multi-segment
suffix check), so `SolidMX`'s longer, more specific entry wins; the same
holds for `Counter.ng.mx` against `MX` and `AngularMX`. Verified by
inspection of the existing `languages/solidmx/config.toml` (already
`path_suffixes = ["solid.mx"]` from when it was the only language shipped
here) — no change was needed to keep this precedence correct when `MX` was
added back, and `languages/ngmx/config.toml` follows the identical shape.

## What you get in Zed today

- `MX` (`.mx`): syntax highlighting, brackets, outline — all from
  Marko's own grammar and queries — plus MX host diagnostics from
  `@mxlang/language-server`. Marko's own server still supplies its broader
  language features for files associated with its `Marko` language.
- `AstroMX` (`.amx`): syntax highlighting, brackets, outline, via injections mapping the `---` fence to TypeScript and the body to Marko. The fence properly highlights as TypeScript. No language server yet.
- `SolidMX` (`.solid.mx`): syntax highlighting, brackets, outline, syntax
  highlighting inside `mx_element` regions via the official Marko extension's
  injection (see "Prerequisite" below), and Solid host diagnostics from
  `@mxlang/language-server`. TSX fragments (`<>...</>`) are supported: each
  `<tag>` child highlights as its own `mx_element` region, the same as a
  fragment-free file (task `solidmx-grammar-fragments`; see
  `packages/editors/tree-sitter-solidmx/UPSTREAM.md` "Local modifications").
- `AngularMX` (`.ng.mx`): syntax highlighting, brackets, outline, and
  injected `mx_element` highlighting, all identical to `SolidMX` above since
  it reuses the same grammar and queries. No language server registration
  yet — `@mxlang/language-server` does not compile `.ng.mx` (see
  `AGENTS.md`'s Zed extension section).

`.amx` needs no precedence rule of its own: Zed's matcher reads the text after
the last dot, and `amx` is not `mx`, so `AstroMX` and `MX` never contend the
way `MX` and `SolidMX`/`AngularMX` do above.

## Prerequisite: install the official Marko extension too

A `.solid.mx` or `.ng.mx` file's `mx_element` regions are highlighted by
injecting a language named `"marko"` (`base/solidmx/injections.scm`,
`base/ngmx/injections.scm`) — Zed resolves that
by name against installed languages, and the only extension that provides a
language named `Marko` is the official `marko-js/zed` extension. **Install
it from Zed's extension registry (Command Palette → "zed: extensions" →
search "Marko") before installing this dev extension.** Without it,
`mx_element` regions render as unhighlighted plain text — everything else
(the `SolidMX` TypeScript host, brackets, outline) still works.

## Dev install (Zed) — `SolidMX` and `AngularMX`

`SolidMX`'s grammar lives in this monorepo at `packages/editors/tree-sitter-solidmx`,
so `extension.toml`'s `[grammars.solidmx]` uses the **`file://` dev form**
with `path = "packages/editors/tree-sitter-solidmx"` (Zed clones the whole repo at
`rev`, then looks for `src/` under that `path` — `GrammarManifestEntry.path`
in Zed's own `extension_manifest.rs`). `AngularMX` reuses this exact grammar
(`languages/ngmx/config.toml` declares `grammar = "solidmx"`, no
`[grammars.ngmx]` entry exists), so every step below that bumps
`[grammars.solidmx]`'s `rev` affects both languages at once.

Even in dev form, Zed still requires a **committed** `rev` — it runs `git
init` + `git remote add origin <url>` + `git fetch --depth 1 origin <rev>` +
`git checkout <rev>` regardless of scheme, so **uncommitted changes under
`packages/editors/tree-sitter-solidmx` are invisible to Zed**. There is no way to
point Zed at a dirty working tree. Zed also never runs `tree-sitter
generate` itself — it compiles whatever `src/parser.c` (and
`src/scanner_mx.c`/`src/scanner.c`) is committed at that rev with clang.

The dev loop is therefore **commit, then bump `rev`, then reinstall**:

1. Make your change under `packages/editors/tree-sitter-solidmx` and commit it (in
   this worktree, on this branch).
2. `git rev-parse HEAD` — copy the sha.
3. Update `extension.toml`'s `[grammars.solidmx]` `rev` to that sha.
4. Command Palette → **"zed: install dev extension"** → select this
   directory (`worktrees/main/packages/editors/zed` from the operator's
   space root, i.e. `packages/editors/zed` inside whichever worktree you're
   in — Zed does not watch for live changes; see "Reinstalling after a
   change" below). **Before this step**, also install Zed's official Marko
   extension from the registry (Command Palette → "zed: extensions" → search
   "Marko") — see "Prerequisite" above; without it `mx_element` regions
   render as unhighlighted plain text.
5. Open or create a `.solid.mx` file — it should be recognized as `SolidMX`,
   with the TypeScript host language highlighted, brackets matched, an
   outline of its declarations, and each `mx_element` region highlighted via
   its `marko` injection (requires the official Marko extension — see
   "Prerequisite" above). A `.ng.mx` file gets the identical treatment under
   `AngularMX`.

**First compile is slow.** `tree-sitter-solidmx`'s generated `src/parser.c`
is ~8.2 MB; clang's first compile of it after a fresh dev-install can take
tens of seconds. This is expected — not a hang.

### Reinstalling after a change

Zed does not watch `extension.toml` or `languages/` for live changes.
After editing anything under `packages/editors/zed` (or bumping
`[grammars.solidmx]`'s `rev`), re-run "zed: install dev extension" and pick
this directory again to reload it.

## Upstream bump procedure

See `UPSTREAM.md` "Bump procedure — SolidMX" for the full steps.
`languages/solidmx/*.scm` are regenerated by `bun run vendor` — from
`packages/editors/tree-sitter-solidmx/queries/highlights.scm` plus this package's own
`base/solidmx/{injections,brackets,outline}.scm` and `overlay/solidmx/*.scm`.
`packages/editors/tree-sitter-solidmx`'s own grammar/scanner bump procedure (a
*different* upstream, `tree-sitter-typescript`) is in that package's own
`UPSTREAM.md`, not here.

There is no `vendor:check` script — SolidMX's highlights source is a local
sibling package, not a networked upstream, so a "check for drift" mode could
only ever report success (decision 55: a gate that cannot fail is not a
gate). `.github/workflows/upstream-check.yml`'s `vendored-files-match` job
does the check that matters instead: regenerate and diff against committed
output.

## Publishing: subtree-split

The Zed extension registry needs a repo whose **root** holds
`extension.toml` (a submodule pinned to a commit, plus an `extensions.toml`
entry — see `notes/zed-plan.md` decision 6). This monorepo's
`packages/editors/zed` is not that shape, so at publish time:

```sh
./scripts/subtree-split.sh              # -> local branch zed-split
git push <mxlang/zed remote> zed-split:main
```

`git subtree split --prefix=packages/editors/zed HEAD` rewrites every
commit touching that directory into a commit at the repo root, dropping
everything else. It only sees **committed** history, so commit first — the
script refuses to run against a dirty tree. It touches no remote itself, so a
bad split costs only a local branch delete.

Requires the `git-subtree` contrib command (ships with full Git installs, may
need `brew install git` / your distro's `git-extras` or `git`-with-contrib
package if `git subtree --help` reports "not a git command").

See `PUBLISHING.md` for the full publish checklist: this split, the
`repository`/`rev` swap for both grammars, the Zed extensions registry
submission procedure, verifying the `.mx`/`.solid.mx` suffix precedence in a
running Zed, and the manual `.mx`/`.amx` editor checks still owed.

**Publish-time URL swap.** Both the dev-install steps above and
`extension.toml`'s `[grammars.solidmx]` comment describe the `file://` form
as temporary: once `packages/editors/zed` is subtree-split into its own
repo and `packages/editors/tree-sitter-solidmx` is published on its own (or the split
repo vendors it), swap `repository` to that repo's real GitHub URL, drop
`path` (its root will already be the grammar root), and commit. Registering
with `zed-industries/extensions` needs the remote form — a registry
submodule cannot point at a contributor's local filesystem.
