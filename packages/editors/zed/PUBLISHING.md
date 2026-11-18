# Publishing checklist

This extension has no automated release pipeline. Two things must happen
before it can be installed by anyone other than a dev install: the
grammars' monorepo URL and `path` must be swapped for their own repositories'
GitHub URLs (see each `[grammars.*]` AT PUBLISH TIME comment in `extension.toml`), and the extension itself must be registered with Zed's extensions
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

`extension.toml` currently points `[grammars.mx]`, `[grammars.solid]` and
`[grammars.astromx]`
at this monorepo's GitHub URL (`https://github.com/svallory/mxlang`), with a
`path` selecting the grammar's subdirectory — that only works for a dev
install (Zed clones the repo at a committed, pushed `rev`; see each grammar's
own comment in `extension.toml`). At publish time, for **each** grammar:

1. Commit and push `packages/editors/tree-sitter-mx` (or
   `tree-sitter-solid`, `tree-sitter-astromx`) to its own real repository — either as its own
   subtree-split repo, or wherever it will be vendored from.
2. In `extension.toml`, swap that grammar's `repository` from
   the monorepo URL to the grammar's own GitHub URL.
3. Update `rev` to the commit the grammar was published at.
4. Delete the `path = "packages/editors/..."` line — the published repo's
   root is already the grammar root, so no subdirectory selector is needed
   (a registry submodule cannot point at a contributor's local filesystem
   at all, so this step is not optional the way it might look).

Do this for `[grammars.mx]`, `[grammars.solid]` and `[grammars.astromx]`
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
   clean build of the published `extension.toml` (not the monorepo
   `path` dev form) gets exercised, so treat a failure there as a real
   defect, not registry flakiness, until proven otherwise.
5. Once merged, updates ship by bumping the submodule's pinned commit in a
   follow-up PR to the registry repo — there is no separate "publish"
   command for updates, only a new pinned commit.

## 5. Verify `path_suffixes` precedence in a running Zed

README.md "Zed suffix precedence: `.mx` vs `.solid.mx` vs `.ng.mx`"
documents the expected precedence: Zed picks the longest matching
`path_suffixes` entry, so a multi-segment suffix wins over `MX`'s `["mx"]`.
The README states this **by inspection of the config**, not by observing it
in a running Zed. The extension declares these multi-segment suffixes
(`languages/*/config.toml`), each of which also matches `MX`'s `mx`:

| Suffix | Expected language |
|---|---|
| `.solid.mx` | `Solid` |
| `.ng.mx` | `AngularMX` |
| `.astro.mx` | `AstroMX` |
| `.react.mx` | `ReactMX` |
| `.preact.mx` | `PreactMX` |
| `.hono.mx` | `HonoMX` |

Before or shortly after publishing, verify it for real:

1. Install the extension (dev install from your checkout, or the published one).
2. Open a plain `.mx` file and one file for each suffix in the table.
3. Check the language shown in Zed's status bar / language picker for each:
   the `.mx` file must show `MX`, and every other file must show the
   language in the table, not `MX`.
4. If a file shows `MX` instead, the precedence assumption in README.md is
   wrong and the `languages/*/config.toml` files need re-checking. Do not
   "fix" it by renaming `path_suffixes` without first confirming which
   grammar Zed actually picked.

## 6. Manual editor checks (every publish)

These need a real Zed window, so the automated checks (`bun run --cwd
packages/editors/tree-sitter-solid test`, the `zed-compile-check` scripts
and `bun run verify`) cannot exercise them. Run both on every publish:

1. **Host diagnostics**: open an `.mx` file and a `.solid.mx` file, each
   with a known host error (in the `.mx` file, e.g. a `<let>` tag under
   `strict` policy), and confirm `@mxlang/language-server` reports it in Zed's diagnostics,
   alongside Marko's own language server's output for the `.mx` file (see
   README.md "Language server" for the dual-server setup).
2. **`.astro.mx` highlighting**: open an `.astro.mx` file and confirm the
   `---` fence highlights as TypeScript and the body as Marko/MX (README.md
   "What you get in Zed today"). This is injection-based; no automated
   highlight test covers it.

Record pass/fail for each check, with the Zed version, in the PR that bumps
`version` in `extension.toml` (step 3).

## See also

- README.md "Publishing: subtree-split" — the split procedure in full.
- README.md "Zed suffix precedence" — the precedence claim this
  checklist's step 5 verifies.
- `extension.toml`'s own `[grammars.solid]`/`[grammars.astromx]` comments —
  the dev-form/publish-form distinction for each grammar.
- `scripts/subtree-split.sh` — the split script itself, with its own usage
  comment.
