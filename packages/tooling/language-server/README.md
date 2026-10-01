# @mxlang/language-server

A small, diagnostics-only LSP server for MX hosts (decision 71/72).

## What it does

Watches `.mx` and `.solid.mx` documents an editor opens or edits
and publishes one LSP `Diagnostic` for a positioned compile error. A
successful compile clears any previous diagnostics for that file.

- **Angular-host documents (`.mx` or `.ng.mx`) get no diagnostics from this
  server.** `mx-tsc` and the TypeScript plugin report them (template
  diagnostics need `@angular/compiler-cli`, which the server never loads). Host-policy warnings
  still appear.
- **A `.ng.mx` file is never compiled as html**, whatever `mx.host` resolves
  to (routed by file kind, as `mx-tsc` does).
- **An unknown `mx.host`** publishes the host-policy warning; an `.mx` page
  compiles under the host the resolver derives (the `@mxlang` dependency's, or
  the html default), the same as `mx-tsc` and vite.
- `.mx` compiles as a whole-file template under the resolved host
  policy. The HTML and Astro hosts use `@mxlang/html`; a file routed to
  `host: "solid"` uses `@mxlang/solid`'s fixed profile, where stateful Marko
  tags such as `<let>` are errors.
- `.solid.mx` parses as a whole TypeScript/TSX module through
  `@mxlang/parser`, the same region-discovery and Solid-lowering path used by
  the Vite plugin. This reports errors inside MX regions at file-absolute
  positions. It also reports TypeScript syntax errors outside regions because
  finding regions requires parsing the whole module; TypeScript's own language
  server may report the same syntax error too.

## What it does not do

**Everything else.** No completion, no hover, no go-to-definition, no
formatting, no semantic tokens — Marko's own language server
(`marko-js/language-server`) already provides all of that for `.marko`
files (and would for `.mx`, since MX 1.0 is a strict Marko subset), and
this server is designed to run *alongside* it, not replace it
(`notes/research/host-diagnostics.md` §2: both VS Code and Zed support
multiple language servers registered against one language).

The reason a second server exists at all: Marko's own server compiles with a
hardcoded config that carries no host policy (`host-diagnostics.md` §1), so
`<let>` — valid Marko syntax — is invisible to it even when a host's
`strictPolicy` forbids it. `tsserver` can't fill the gap either: it never
opens `.mx` files in the first place (`host-diagnostics.md` §4).

## Why decisions 71/72 require this

> "A host is not done without its editor diagnostics" — a host that defines
> its own subset of MX (a `strict` policy, a stateful-tag disposition table)
> owes its authors in-file squiggles for the tags it rejects, not just a
> build-time error.

## Policy resolution

An editor hands the server a file path and text — nothing about which host
compiles it, or whether that host runs a `strict` policy. The server resolves
this by walking upward from the file, looking for the nearest `package.json`:

1. **`package.json#mx`**, if present: `{ "host": "html" | "astro" |
   "solid", "strict"?: boolean }` (with `"translator"` accepted as a deprecated alias). This is the authoritative source, and
   doubles as the routing config `@mxlang/vite-plugin`/the Bun loader already
   need for a mixed project (decision 71's "mixed projects" case).
2. Otherwise, if that `package.json` depends on **exactly one** `@mxlang/*`
   host package (`@mxlang/html`, `@mxlang/astro`, `@mxlang/solid`), use that
   host at its default (non-strict) policy.
3. Otherwise, fall back to the translator's default (non-strict) policy.

`@mxlang/astro` always compiles under its strict policy (it ships no stateful
tags), whatever `strict` says. The Solid host also has a fixed profile:
`host: "solid"` routes a whole-file `.mx` template through
`compileSolidUnit` (decision 115; the *region* compiler, `compileSolidMx`,
is reserved for `.solid.mx`'s embedded MX regions — a whole file has its own
module scope to place an authored `import` in, which a region spliced into
someone else's module does not), so stateful Marko tags are rejected the
same way. A `.solid.mx` suffix or `solidmx`/`SolidMX` language id takes
precedence over package policy because that suffix identifies a different
file format: TypeScript/TSX with MX regions.

A whole-file Solid `.mx` component's ordinary props are type-checked like
every other host's: `compileSolidUnit` emits `export interface Input` and
annotates `function Card(input: Input)`, so a wrong prop (`<Card title=1/>`
against `title: string`) is TS2322 wherever diagnostics come from a
virtual-code type-check (the TypeScript plugin — this server's own
`TranslateError`-based diagnostics are compile-time only and report a
compile-time error like an unresolved tag as before). AttrTag props are also
checked via `satisfies` at the call site.

The resolver lives in `@mxlang/core` (`src/host-policy.ts`), shared with
`@mxlang/typescript-plugin`; see `src/host-policy.test.ts` there for every
branch.

## Debounce

150ms per document from the last `didOpen`/`didChange`/`didSave`; a
superseded run is cancelled (its timer cleared) rather than raced.

## Editors

### Zed

No zero-Rust path exists for registering a second language server against a
language another extension owns (or one's own): Zed's `extension.toml`
`[language_servers.<key>]` table binds a server only to a `languages` array
implemented by that extension's own `zed::Extension::language_server_command`
— a Rust `Cargo.toml`-backed extension. `packages/editors/zed` implements that
command and registers this server for both its `MX` and `SolidMX` languages.
See `packages/editors/zed/UPSTREAM.md` and `extension.toml` for the command's
provenance and registration.

Both VS Code and Zed do support **multiple** servers on one language id —
this is not a workaround, it's how ESLint+TS or Tailwind+CSS coexist today
(`host-diagnostics.md` §2) — so adding this server does not replace Marko's.

### VS Code

The `@mxlang/vscode` extension bundles this server and runs it with VS Code's
own Node, so VS Code users need to install nothing. To run a different build,
set `mxlang.languageServer.path`. In another VS Code setup, a
generic LSP client extension (e.g.
[`vscode-generic-lsp`](https://marketplace.visualstudio.com/items?itemName=Gerrnperl.custom-lsp-client),
or a minimal `LanguageClient` of your own) can launch it directly:

```json
{
  "command": "bunx",
  "args": ["@mxlang/language-server", "--stdio"],
  "filetypes": ["marko", "mx", "solidmx"]
}
```

or, from a small extension's own `activate()`:

```ts
import { LanguageClient } from "vscode-languageclient/node";

const client = new LanguageClient(
  "mxlang",
  "MX diagnostics",
  { command: "bunx", args: ["@mxlang/language-server", "--stdio"] },
  {
    documentSelector: [
      { scheme: "file", language: "marko" },
      { scheme: "file", language: "solidmx" },
    ],
  },
);
client.start();
```

### Any editor

The server works with both `bun` and `node`:

```
bunx @mxlang/language-server --stdio
# or
node node_modules/@mxlang/language-server/dist/bin.js --stdio
```

`--stdio` is accepted for symmetry with Marko's own server but not otherwise
inspected: `vscode-languageserver`'s `createConnection` auto-detects the
stdio transport when no other transport flag is given.

## Typechecking against this package's declarations

`dist/index.d.ts` re-exposes types from `vscode-languageserver/node`, whose own
declarations use `NodeJS` and `child_process`. A consumer that typechecks with
`skipLibCheck: false` needs `@types/node` installed **and** loaded (`types:
["node"]`, or no `types` option). The language server is a Node-only binary, so
this is not declared as a dependency.

## Tests

```
bunx vitest run --root ../.. --project @mxlang/language-server
```

`src/diagnose.test.ts` covers HTML policy diagnostics, SolidMX host and parse
errors with exact positions, clean documents, Solid-host `.mx`, and the
locationless-error callback. `@mxlang/core`'s `src/host-policy.test.ts` covers explicit,
dependency-derived (including `@mxlang/solid`), and fallback policies.
`src/server.test.ts` exercises stdio routing for `.mx`, `.solid.mx`, and the
`solidmx` language id. Requires `bun run build` first (see the root
`AGENTS.md` "Running tests in a fresh worktree").
