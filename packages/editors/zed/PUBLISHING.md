# Publishing checklist

This extension has no automated release pipeline. Two things must happen
before it can be installed by anyone other than a `file://` dev install:
the grammars' `file://` dev paths must be swapped for real GitHub URLs
(Z36), and the extension itself must be registered with Zed's extensions
registry. Both are manual, one-time-per-release steps.

## 1. Subtree-split this package into its own repo

See README.md "Publishing: subtree-split" for the full procedure
(`scripts/subtree-split.sh`, requires `git-subtree`). Summary:

```sh
./scripts/subtree-split.sh              # -> local branch zed-split
git push <mxlang/zed remote> zed-split:main
```

This rewrites `packages/editors/zed`'s history onto a repo whose root holds
`extension.toml` — the shape the Zed extension registry requires. It only
sees committed history; commit everything in this package first.

## 2. Drop `path`, switch `repository`/`rev` for every grammar

`extension.toml` currently points `[grammars.mx]`, `[grammars.solidmx]` and
`[grammars.amx]`
at this monorepo over `file://`, with a `path` selecting the grammar's
subdirectory — that only works for a dev install (Zed still clones the repo
at a committed `rev` even for `file://`; see each grammar's own comment in
`extension.toml`). At publish time, for **each** grammar:

1. Commit and push `packages/editors/tree-sitter-mx` (or
   `tree-sitter-solidmx`, `tree-sitter-amx`) to its own real repository — either as its own
   subtree-split repo, or wherever it will be vendored from.
2. In `extension.toml`, swap that grammar's `repository` from
   `file:///Users/svallory/work/mx` to the real GitHub URL.
3. Update `rev` to the commit the grammar was published at.
4. Delete the `path = "packages/editors/..."` line — the published repo's
   root is already the grammar root, so no subdirectory selector is needed
   (a registry submodule cannot point at a contributor's local filesystem
   at all, so this step is not optional the way it might look).

Do this for `[grammars.mx]`, `[grammars.solidmx]` and `[grammars.amx]`
independently; they
are unrelated repos and may be split/published on different schedules.

## 3. Bump `version` in `extension.toml`

Standard semver bump for whatever changed since the last publish.

## 4. Register with the Zed extensions registry

Zed's own extensions live in a single registry repo
(`zed-industries/extensions`), not per-extension `zed extension publish`
pushes to arbitrary hosts. The procedure (from that repo's own README):

1. Fork/clone `zed-industries/extensions`.
2. Add this extension's repo as a **git submodule** under `extensions/`:
   ```sh
   git submodule add https://github.com/<mxlang/zed remote> extensions/mxlang
   ```
3. Add an entry to that repo's root `extensions.toml` (alphabetically, by
   extension `id`) pointing at the submodule path and pinning the same
   commit the submodule is checked out at.
4. Open a PR against `zed-industries/extensions`. Their CI builds the
   extension from the pinned commit — this is the first point a genuinely
   clean, network-fetched build of `extension.toml` (not the local
   `file://` dev form) gets exercised, so treat a failure there as a real
   defect, not registry flakiness, until proven otherwise.
5. Once merged, updates ship by bumping the submodule's pinned commit in a
   follow-up PR to the registry repo — there is no separate "publish"
   command for updates, only a new pinned commit.

## 5. Verify `path_suffixes` precedence (Z37) in a running Zed

README.md "Zed suffix precedence: `.mx` vs `.solid.mx`" documents the
expected precedence (`SolidMX`'s `path_suffixes = ["solid.mx"]` should win
over `MX`'s `["mx"]` for a `Counter.solid.mx` file, since Zed picks the
longest matching suffix) but says so **by inspection of the config**, not by
observing it in a running Zed. Before or shortly after publishing, verify it
for real:

1. Install the extension (dev install via `file://`, or the published one).
2. Open a `.solid.mx` file and a plain `.mx` file side by side in Zed.
3. Check the language shown in Zed's status bar / language picker for each:
   the `.solid.mx` file must show `SolidMX`, and `.mx` must show `MX`.
4. If `.solid.mx` incorrectly shows `MX`, the precedence assumption in
   README.md is wrong and both `languages/*/config.toml` files need
   re-checking — do not "fix" it by renaming `path_suffixes` without first
   confirming which grammar Zed actually picked.

## 6. Manual editor checks Saulo still owes

Two things this task's automated checks (`bun run --cwd
packages/editors/tree-sitter-solidmx test`, `zed-compile-check`, `bun run
verify`) cannot exercise, because they need a real Zed window:

- **`.mx` diagnostics**: open an `.mx` file with a known host error (e.g. a
  `<let>` tag under `strict` policy) and confirm `@mxlang/language-server`
  reports it in Zed's Problems panel / inline diagnostics, alongside
  Marko's own language server's output for the same file (see README.md
  "Language server" for the dual-server setup this depends on).
- **`.astro.mx` highlighting**: open an `.astro.mx` file and confirm the `---` fence
  highlights as TypeScript and the body highlights as Marko/MX, per
  README.md "What you get in Zed today". This is injection-based and has no
  automated test today (`highlight-smoke.sh` only covers `.solid.mx`).

Both are one-time manual verifications per publish, not something to
automate as part of this task — record the outcome (pass/fail, Zed version)
wherever this checklist is run from next.

## See also

- README.md "Publishing: subtree-split" — the split procedure in full.
- README.md "Zed suffix precedence" — the Z37 precedence claim this
  checklist's step 5 verifies.
- `extension.toml`'s own `[grammars.solidmx]`/`[grammars.amx]` comments —
  the dev-form/publish-form distinction for each grammar.
- `scripts/subtree-split.sh` — the split script itself, with its own usage
  comment.
