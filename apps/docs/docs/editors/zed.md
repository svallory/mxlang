---
title: "Zed"
description: "The mxlang Zed extension: MX, SolidMX, AngularMX, and AstroMX languages, plus diagnostics."
---

# Zed

The `mxlang` extension ships four languages:

- **MX** (`.mx`, and its `.marko` alias) — rides Marko's own tree-sitter grammar and queries unmodified. No overlay: MX 1.0 is a strict subset of Marko syntax, so Marko's own highlighting, brackets, and outline already apply.
- **SolidMX** (`.solid.mx`) — its own grammar, a patched TypeScript/TSX grammar with MX recognized in expression position.
- **AngularMX** (`.ng.mx`) — an ordinary TypeScript module whose `@Component` template is MX. Reuses SolidMX's grammar unchanged: the grammar's only MX-specific addition is an opaque `mx_element` token in expression position, which is neither Solid- nor Angular-specific.
- **AstroMX** (`.amx`) — its own small grammar to separate the TypeScript fence from the MX body, with injected highlighting for both.

## Install the official Marko extension too

`.mx`/`.amx` files render correctly on their own, but the region of a `.solid.mx` or `.ng.mx` file that contains embedded MX is highlighted through an *injection* — Zed asks for a language named `marko` to highlight that region, and only Zed's official Marko extension provides a language by that name. Install it from Zed's extension registry (Command Palette → "zed: extensions" → search "Marko") before or alongside `mxlang`. Without it, those regions still parse and match brackets correctly — they just render as plain, unhighlighted text.

## `.mx` vs `.solid.mx` vs `.ng.mx`

Every one of these can match the same file's `.mx` suffix at once: `Counter.solid.mx` matches `MX`'s `.mx` suffix and `SolidMX`'s `.solid.mx` suffix, and `Counter.ng.mx` matches `MX`'s `.mx` suffix and `AngularMX`'s `.ng.mx` suffix. Zed resolves this by picking the *longest* matching suffix, so `.solid.mx`/`.ng.mx` always win over plain `.mx`, regardless of which extension you installed first. `.amx` never contends with any of them, since `amx` and `mx` are different suffixes.

## What each language gets today

| Language | Highlighting | Language server |
| --- | --- | --- |
| MX (`.mx`) | Yes, from Marko's grammar | Yes — see below |
| AstroMX (`.amx`) | Yes, from Marko's grammar (the frontmatter fence itself highlights as Marko markup, a known limitation) | No |
| SolidMX (`.solid.mx`) | Yes, plus injected highlighting inside embedded MX regions (needs the Marko extension) | Yes — see below |
| AngularMX (`.ng.mx`) | Yes, plus injected highlighting inside embedded MX regions (needs the Marko extension) | No — not registered for this language yet |

## Diagnostics language server

The extension registers `@mxlang/language-server` for the `MX` and `SolidMX`
languages. It resolves the server to launch, in order: a local install under
the project (`node_modules/.bin/mxlang-language-server`), a global install,
`bunx @mxlang/language-server --stdio`, then `npx`. Nothing needs to be
configured for a project that already has the package installed one of those
ways.

### Trying it locally

1. Make sure `@mxlang/language-server` is built and reachable — in this monorepo, `bun run build` at the repo root is enough; bun's workspace linking makes `node_modules/.bin/mxlang-language-server` available automatically.
2. Command Palette → "zed: install dev extension" → select the extension's directory.
3. In a test project, add to `package.json`:

   ```json
   { "mx": { "host": "html", "strict": true } }
   ```

4. Open an `.mx` file containing a `<let>` tag. Under a `strict` host policy this is rejected — you should see one diagnostic naming the construct.
5. Open a `.solid.mx` file with a `<let>` tag inside an MX region. The Solid
   host rejects the tag and the diagnostic should point to its position in the
   complete TypeScript file. See [Language server](/editors/language-server/)
   for routing and policy details.

## Building the extension from source

Only needed if you're building `mxlang` itself, not for using it once installed. The Rust half that registers the language server compiles to the `wasm32-wasip1` target Zed itself builds extensions to:

```bash
rustup target add wasm32-wasip1
```

## TypeScript

The language server above checks MX constructs against a host policy.
TypeScript errors *inside* a `.solid.mx` file are a separate job, handled by
`@mxlang/typescript-plugin` inside Zed's TypeScript server (`vtsls`).

```json
{
  "lsp": {
    "vtsls": {
      "settings": {
        "vtsls": {
          "typescript": {
            "globalPlugins": [
              {
                "name": "@mxlang/typescript-plugin",
                "location": "/absolute/path/to/node_modules/@mxlang/typescript-plugin",
                "languages": ["solidmx"],
                "enableForWorkspaceTypeScriptVersions": true
              }
            ]
          }
        }
      }
    }
  }
}
```

`languages` must be `solidmx`, lowercase. `vtsls` matches that entry against
the **LSP language id**, not against the name in the language's
`config.toml`. Zed derives the id by lowercasing the language name
(`LanguageName::lsp_id()` in `crates/language_core/src/language_name.rs`
returns `name.to_lowercase()`, special-casing only `Plain Text`), so this
extension's `SolidMX` language is sent over LSP as `solidmx`.

With `typescript-language-server` in place of `vtsls`, the same plugin goes in
its `plugins` array:

```json
{
  "lsp": {
    "typescript-language-server": {
      "initialization_options": {
        "plugins": [
          {
            "name": "@mxlang/typescript-plugin",
            "location": "/absolute/path/to/node_modules/@mxlang/typescript-plugin",
            "languages": ["solidmx"]
          }
        ]
      }
    }
  }
}
```

For a command-line typecheck, `tsc` ignores `compilerOptions.plugins` — use
`mx-tsc` from `@mxlang/tsc` instead.

## Working on the grammar

The SolidMX grammar package also backs AngularMX (`languages/ngmx/config.toml` declares `grammar = "solidmx"` directly rather than a second, identical grammar package) — a change here affects both languages' highlighting. It is a `file://` dependency during development, and this has one consequence worth knowing before you lose an afternoon to it: **Zed only ever sees committed code.** Its checkout runs `git init`, `git fetch --depth 1 origin <rev>` and `git checkout <rev>` regardless of the URL scheme, so uncommitted changes in your working tree are invisible. There is no way to point Zed at a dirty tree, and Zed never runs `tree-sitter generate` itself — it compiles whatever `src/parser.c` is committed at that revision.

The loop is therefore **commit, bump, reinstall**:

1. Make the change under the grammar package and commit it.
2. `git rev-parse HEAD` — copy the sha.
3. Update the grammar's `rev` in `extension.toml` to that sha.
4. Command Palette → **"zed: install dev extension"** → select the extension directory.

Zed does not watch `extension.toml` or `languages/` for changes either, so re-run step 4 after editing anything in the extension itself.

The first compile after a fresh dev install is slow: the generated parser is several megabytes of C, and clang can take tens of seconds over it. That is expected, not a hang.

## Publishing

The Zed extension registry expects a repository whose **root** holds `extension.toml`. This monorepo's extension lives in a subdirectory, so publishing goes through a subtree split — `git subtree split` rewrites every commit touching that directory into a commit at the repository root — pushed to a dedicated extension repo, with the grammar's `file://` dev dependency swapped for a real URL at the same time.

The split only sees committed history, and the script refuses to run against a dirty tree. It touches no remote itself, so a bad split costs nothing but a deleted local branch. The extension package's own `PUBLISHING.md` carries the full checklist, including the registry submission itself.
