---
title: "Language server"
description: "@mxlang/language-server: diagnostics-only, for what a host's policy rejects."
---

# Language server

`@mxlang/language-server` is a small, diagnostics-only LSP server for MX hosts.

## Scope: diagnostics only

It does exactly one thing: watch `.mx`, `.marko`, and region documents (`.solid.mx`, `.react.mx`, `.preact.mx`, `.hono.mx`), compile or parse each one through its host, and publish one diagnostic per positioned error. No completion, no hover, no go-to-definition, no formatting, no semantic tokens — Marko's own language server already provides those features for `.mx`/`.marko`, and this server is meant to run *alongside* it, not replace it. Running two language servers against one file type is an ordinary pattern in both VS Code and Zed (the same way ESLint and TypeScript's own server coexist).

## Name sugar

The [name sugar](/language/attributes/) (`:email`, `#id`, `.class`) needs nothing from
this server beyond what it already does: an error on it (a second `:` in a tag
head, a value on the sugar, sugar right after a default value, a dynamic shorthand
in attribute position, a stock parser that cannot read it) is one diagnostic at the
exact token. The server offers no completion or hover of its own, so there is no
sugar hover here; typing a bare `:`, `#` or `.` after whitespace in a tag never
crashes it.

## Why it exists

Marko's own language server compiles with a fixed configuration that carries no host policy. A construct like `<let>` is valid Marko syntax, so Marko's server reports nothing for it — even in a project whose host forbids `<let>` under a `strict` policy. This server closes that gap: it knows which host and which policy apply to a given file, and flags what that policy rejects.

## Policy resolution

An editor only hands the server a file path and its text — nothing about which host compiles it. The server resolves that by walking upward from the file to the nearest `package.json`:

1. **An explicit `mx` field**, if present — the authoritative source:

   ```json
   { "mx": { "host": "html", "strict": true } }
   ```

2. Otherwise, if that `package.json` depends on exactly one `@mxlang/*` host package, that host's default (non-strict) policy applies.
3. Otherwise, it falls back to the html target's default policy.

The Astro host always compiles under its strict policy — it has no non-strict mode — so `"host": "astro"` behaves as strict regardless of the field's own `strict` value.

`"host"` accepts `html`, `astro`, `solid`, `preact` and `react`, and the
matching dependency packages are `@mxlang/html`, `@mxlang/astro`,
`@mxlang/solid`, `@mxlang/preact` and `@mxlang/react`. (`"translator"` is
accepted as a deprecated alias for `"html"` and warns.) A whole-file
`.mx`/`.marko` document resolved to a host whose stateful tags are errors —
`solid`, `preact` and `react` among them — reports `<let>` and the rest as
errors, each naming that framework's own primitive.

## Solid documents

`.solid.mx` is a different file format rather than another policy for a
whole-file template: it is TypeScript/TSX with MX regions. The server parses
the complete module through `@mxlang/tsx-bridge`, which lowers each region through
`@mxlang/solid`. Host errors and malformed expressions inside a region are
reported at their file-absolute positions.

Because the region finder must parse the whole module, the server also reports
TypeScript syntax errors outside MX regions. TypeScript's own language server
reports those too, so an editor may show both diagnostics for the same syntax
error.

## Running it directly

```bash
bunx @mxlang/language-server --stdio
# or
node node_modules/@mxlang/language-server/dist/bin.js --stdio
```

`--stdio` is accepted for symmetry with other language servers, but stdio is the only transport this server speaks.

## `package.json#mx` and Host Resolution

The language server determines the correct host policy to use by reading the `mx` field in the project's `package.json`. For example:

```json
{
  "mx": {
    "host": "react",
    "strict": true
  }
}
```

This tells the language server to apply the React host policy. If the `strict` flag is true, stateful tags like `<let>` or `<effect>` will be reported as diagnostics.

### Region files (`.solid.mx`, `.react.mx`, `.preact.mx`, `.hono.mx`)

For region files (`.solid.mx`, `.react.mx`, `.preact.mx`, `.hono.mx`), the language server cannot use the whole-file HTML compilation. Instead, it uses a diagnose path that finds MX regions via the `@mxlang/tsx-bridge` bridge and runs each through the file kind's host (`@mxlang/solid`, `@mxlang/react`, `@mxlang/preact`, `@mxlang/hono`), mapping the resulting errors back to the correct source positions within the complete TypeScript file.
