---
title: "Discovery"
description: "How MX finds tag templates and sidecars consistently across builds and editors."
---

# Custom-tag discovery

Custom tags are discovered per calling file. That file's location determines which project vocabulary it can use; no global registry or import boilerplate is involved.

## The upward walk

Starting in the caller's directory, MX checks each `tags/` directory while walking upward. The walk stops at the nearest `package.json`, the package root. A file above that boundary cannot contribute a tag.

Within the collected directories, the nearest definition of a name wins. A tag name is the basename of either supported file:

- `tags/x.mx` defines the L1 template `<x>`.
- `tags/x.tag.ts` defines the L2 sidecar `<x>`.

Both files may exist in the same directory and compose into one definition. Other files in `tags/` are ignored.

## Package tag directories

`package.json#mx.tags` extends discovery with shared directories. A string is shorthand for one directory. The object-array form accepts `dir`, `prefix`, `hosts`, and directory-level `parseOptions`.

This passing scan fixture prefixes two tags and supplies text mode by default:

```json
{
  "name": "scan-mx-tags",
  "private": true,
  "mx": {
    "tags": [
      {
        "dir": "shared",
        "prefix": "ui-",
        "parseOptions": {
          "text": true
        }
      }
    ]
  }
}
```

Paths are relative to the package containing the manifest. `prefix` is prepended to each file basename. Directory `parseOptions` are defaults; a sidecar's own statically declared values override them.

`hosts` is an array of strings that restricts an `mx.tags` entry to the named hosts (`"html"`, `"astro"`, `"solid"`, `"preact"`, `"react"`, `"hono"`, `"angular"`). Each integration passes its own host name when it scans, so a tag whose `hosts` excludes that host is left out of discovery for it entirely — not merely hidden from the compiled map. An entry with no `hosts` is visible to every host, and a local `tags/` directory (no `mx.tags` entry backing it) is always visible everywhere, since only an explicit `hosts` list narrows availability.

## Project-wide enumeration

`scanCustomTags` (and `getCustomTags`/`scanCached`) answer "what can this file call," walking upward from one path. `discoverProjectTags(projectDir, options?)` answers the complementary question — "what tags exist in this project" — walking every `tags/` directory reachable under a project root, plus the root `package.json`'s `mx.tags` entries, without descending into `node_modules`, a dotdirectory, or a nested package's own directory tree. It accepts the same `host` filter. Used by tooling that needs the whole tag surface up front (an Angular build's dependency graph, a project index), rather than per compiled file.

The walk follows symlinked directories — a symlinked `tags/` directory is discovered like any other — guarded against symlink cycles so a self-referential link terminates rather than recursing forever.

## Precedence

From highest to lowest:

1. A definition passed explicitly in the compiler's `customTags` map.
2. Local `tags/` directories, nearest directory first.
3. `mx.tags` entries, in array order.

An ordinary in-scope component binding is resolved before the discovered custom-tag map. Within discovery, an earlier winner is not merged with a same-named file from a lower-precedence directory.

## One scanner in every integration

Discovery is synchronous and shared by every integration that compiles or diagnoses MX:

| Integration | What it does with the scan |
| --- | --- |
| Bun loaders (`@mxlang/html/bun`, `@mxlang/hono/bun`) | Scan before compiling an imported `.mx` module. |
| `@mxlang/vite-plugin` | Scan the real file before transforming `.mx` or `.solid.mx`. |
| `@mxlang/astro` | Uses the Vite path for `.mx` and scans while lowering `.amx`. |
| `@mxlang/typescript-plugin` | Passes the same map to virtual-code compilation and its mapping lower. |
| `@mxlang/language-server` | Scans each diagnosed document and publishes tag/template diagnostics. |
| `mx-tsc` | Uses the same Volar language plugin and therefore the same scan as the editor. |

The scan must be synchronous because several of those call sites cannot await. Sidecar hooks are therefore loaded lazily, only when a called tag needs them.

## Invalidation

A cached result is rechecked against evidence rather than a timer:

- the entry list of every scanned tag directory;
- every discovered tag file's modification time;
- the `package.json` that supplied `mx.tags`.

Adding or removing a tag, editing a template or sidecar, or changing `mx.tags` invalidates affected callers. Parser-facing changes and loaded-hook changes use separate signatures so changing only a transform body cannot leave an old sidecar module live. Filesystems supported by MX provide sub-second mtimes, though two writes within one filesystem tick can still look identical.

## Sidecar loading constraints

Sidecars are synchronously loaded through Node's type-stripping `require`, so integrations that load them require **Node 22.18 or newer**.

- Do not use top-level `await`; a synchronous `require` cannot load that ESM graph.
- Add explicit extensions to relative imports: write `./helper.ts`, not `./helper`.
- Keep `parseOptions` statically readable: the default export must be an object literal, or one module-scope identifier bound to an object literal (optionally through `as` or `satisfies`). The options object may contain only literal booleans for `text`, `preserveWhitespace`, and `openTagOnly`; spreads, computed keys, calls, and imported indirection are rejected.

These constraints keep Bun builds, Node-based editors, and `mx-tsc` from loading different definitions.

## Diagnostics and warnings

A sidecar that cannot be parsed, throws while loading, or does not default-export an object becomes a positioned `TranslateError` naming the sidecar. The language server reports it instead of crashing.

An `mx.tags` entry whose directory does not exist is non-fatal: discovery continues and records a diagnostic against its `package.json`. The language server publishes it as a warning on the open document while naming the manifest; Vite and the TypeScript plugin warn once per distinct problem.

A file that tries to redefine a core-owned name such as `try` is also omitted with a diagnostic so one misnamed file does not break every caller in the package.

## Filename rules

Case is significant and preserved: `tags/Icon.tag.ts` defines `<Icon>`, not `<icon>`. A name must match `^[A-Za-z0-9_][A-Za-z0-9_.-]*$`. Dotfiles are skipped; other invalid tag filenames produce a positioned diagnostic.

Only `.mx` is a tag-template extension. A `.solid.mx` file is a TypeScript module containing MX regions, not a template definition, and placing one under a scanned tag directory is an error rather than a silent ignore.
