---
title: "Writing a dialect package"
description: "Ship a whole tag dialect as one mx.contracts module, and hand it to lowerSource with one line."
---

# Writing a dialect package

A dialect — a cohesive vocabulary of tag names with validation rules, like a resource-definition language — ships as a package-level `mx.contracts` module: one file default-exports a `ContractMap` (`Record<string, CustomTag>`, exported by `@mxlang/core`), and each consuming package names the module in its own `package.json`.

This page's dialect is a tag vocabulary written in MX's own syntax, in `.mx` files. A dialect that changes the syntax itself and claims file extensions of its own (`.mesh`) is a package that declares `mxDialect` in its `package.json`; see [the specification, §13.9.2](/specification/).

## The module

Declarations only: `parseOptions`, `attributes`, `attributeTags`, `children`, `parents`, and `analyze`. Hooks that produce IR (`transform`, `finalize`) and templates stay in `tags/` sidecars — a contracts module cannot carry them.

```ts
// contracts.ts
import type { ContractMap } from "@mxlang/core";

export default {
  resource: {
    parents: ["#root"],
    children: { attributes: { required: true } },
  },
  attributes: {
    parents: ["resource"],
    children: { attribute: { repeatable: true } },
  },
  attribute: {
    parents: ["attributes"],
    attributes: {
      value: { type: "string", required: true },
      values: { type: "array", items: "string" },
    },
  },
} satisfies ContractMap;
```

## The consumer

```json
{
  "name": "my-app",
  "mx": {
    "contracts": "@my/dialect/contracts"
  }
}
```

A bare specifier resolves through the consuming package's own `node_modules`, using `require`/`default` export conditions; installed dialect packages must export JavaScript. A relative path resolves against the package directory. The language server, `mx-tsc`, the TypeScript and Vite plugins, and the Bun loaders discover the module without per-tool configuration. Contract-only calls require a target that delegates their names; `lowerSource` delegates every non-reserved name. No tool checks a dialect file against this map yet: the dialect check (`TODO dialect-check (PR 1)`) is the future home of that.

## The `lowerSource` one-liners

`lowerSource` (see [the core IR entry point](/architecture/ir-entry/)) does not scan; it validates against the `customTags` you hand it. There are two ways to get that map, and they differ in what they include.

**Import the dialect's map directly** — for the dialect's own build or CLI, where the vocabulary is fixed:

```ts
import contracts from "@my/dialect/contracts";
import { lowerSource } from "@mxlang/core";

const { ir, diagnostics } = lowerSource(source, file, {
  customTags: contracts,
  structural: "reject",
});
```

**Discover the map for the file** — for a tool that should see what the editor sees:

```ts
import { getCustomTags, lowerSource } from "@mxlang/core";
import { builtinLookup } from "@mxlang/targets";

// file is an absolute filesystem path; source is the file's text.
const customTags = getCustomTags(file, { targets: builtinLookup(), host: null });
const { ir, diagnostics } = lowerSource(source, file, { customTags });
```

How they differ:

| | Direct import | `getCustomTags` |
|---|---|---|
| Source of the map | exactly the module's default export | the scan of the file's package: `tags/`, `mx.tags`, then `mx.contracts` |
| A local `tags/attribute.mx` | ignored | wins over the module's `<attribute>` (with a shadow warning in the scan) |
| Entries with templates or `transform` | never (a contracts module cannot carry them) | included when `tags/` or `mx.tags` provides them |
| Needs `package.json#mx.contracts` | no | yes, to include the dialect's contracts |
| Shadow and defined-twice warnings | not applicable | not returned: read `scanCached(file, options).diagnostics` |
| `analyze` | runs | runs |

Both run every declaration rule and the module's `analyze` hooks, including under `structural: "reject"`. Use the direct import when a user's local `tags/` must not change what your build accepts.

`targets` in the second form is the target lookup in hand — for a CLI, the registry lookup from `@mxlang/targets`. `host: null` scans as a hostless consumer (a `hosts`-restricted entry is excluded, so a dialect declares no `hosts`). `lowerSource` delegates every non-reserved name, so the module is the entire dialect: no `tags/` directory, no sidecars.

## Closing the vocabulary

By default `lowerSource` accepts a tag that has no contract (the open set). A dialect that declares every tag can refuse the rest with `unknownTags: "reject"`: any tag at any depth whose name is not in `customTags` is a positioned error naming the tag, with a `did you mean` hint when one declared name is clearly nearest. `#root` placement stays the job of `parents`; the reserved names (`if`, `for`, `const`, ...) are never "unknown", and `<@name>` attribute tags are governed by the parent's `attributeTags`, not by this option.

The check runs on a tag before anything inside it, in document order, so the first error is the root cause: a typo'd parent (`resourse="post"`) is reported with its `did you mean` hint, not the `<attributes> must be inside <resource>` error of the child under it. An error that comes earlier in the file, or a known parent's `children` error positioned at the unknown tag itself, is reported instead; under `structural: "reject"` the construct or unknown tag that comes first wins.

```ts
lowerSource(source, file, {
  customTags: contracts,
  structural: "reject",
  unknownTags: "reject",
});
// widget="post"  ->  1:0 `<widget>` is not a known tag: it has no contract in `customTags`
```

A `transform` that emits tags is not supported by `lowerSource` yet: it reports an `internal error` diagnostic on the emitted tag in either mode (TODO `data-transform-output-tree`). The check itself only ever looks at names the file's author wrote.

## Composing a dialect from parts

If your dialect is assembled from a core vocabulary plus optional extensions — an extension that adds a child tag to `resource`, say — **generate one self-contained contracts module** from the enabled parts, and name that file under `mx.contracts`.

- **Entries replace, they do not merge.** When two `mx.contracts` modules export the same tag name, the first module's whole entry wins and the scan warns that the name is defined twice; `children`, `parents`, `attributes` and `parseOptions` are not combined. Compose the final `resource` contract in your generator, where you know which extensions are on.
- **Imports are not tracked.** The scan stamps the module file itself, so regenerating it gives every caller a fresh scan map. Under Node, an ESM/TS module's exports are only re-read after a restart; a `.cjs` module is re-read in process (see Limits). An edit to a file the module imports, or to config it reads at load time, goes unseen until a restart. A generated file with no relative imports (beyond `import type`) avoids that.
- **Shadowing stays visible.** A local `tags/<name>.mx` or `mx.tags` entry replaces a module's contract for that name, and the scan reports it: `` `<attribute>` from `mx.contracts` (…) is shadowed by …; the module's contract does not apply ``. The language server and the TypeScript plugin surface that warning, so a user's stray template cannot silently drop a rule of your dialect in the editor (for dialect files, once the dialect check lands: `TODO dialect-check (PR 1)`). `getCustomTags` returns only the map; a build that discovers the map and must see these warnings reads `scanCached(file, options).diagnostics`.

## Limits

- The module is evaluated synchronously on a scan cache miss: no top-level `await`, and relative imports need explicit extensions (`./helper.ts`, not `./helper`). Keep it self-contained: helper-only edits require a restart.
- The scan tracks the module's mtime and content hash. Under Node, long-lived tools need a restart to reload ESM/TS contracts; Bun reloads them, and CommonJS `.cjs` modules reload on Node too. See [Discovery in the specification](../specification.md#the-mx-language-9-custom-tags-92-discovery).
- Contracts buy precise positioned diagnostics. Completions and hover for contract-only tags are a later, separate piece.
