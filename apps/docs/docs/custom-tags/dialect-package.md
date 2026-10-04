---
title: "Writing a dialect package"
description: "Ship a whole tag dialect as one mx.contracts module, and hand it to parseData with one line."
---

# Writing a dialect package

A dialect — a cohesive vocabulary of tag names with validation rules, like a resource-definition language — ships as a package-level `mx.contracts` module: one file default-exports a `ContractMap` (`Record<string, CustomTag>`, exported by `@mxlang/core`), and each consuming package names the module in its own `package.json`.

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

A bare specifier resolves through the consuming package's own `node_modules`, using `require`/`default` export conditions; installed dialect packages must export JavaScript. A relative path resolves against the package directory. The language server, `mx-tsc`, the TypeScript and Vite plugins, and the Bun loaders discover the module without per-tool configuration. Contract-only calls require a target that delegates their names; the data target delegates every non-reserved name. Editor dispatch for data files is tracked separately (`data-target-tooling-dispatch`).

## The data one-liners

`parseData` does not scan; it validates against the `customTags` you hand it. There are two ways to get that map, and they differ in what they include.

**Import the dialect's map directly** — for the dialect's own build or CLI, where the vocabulary is fixed:

```ts
import contracts from "@my/dialect/contracts";
import { parseData } from "@mxlang/data";

const { tree, diagnostics } = parseData(source, file, {
  customTags: contracts,
  structural: "reject",
});
```

**Discover the map for the file** — for a tool that should see what the editor sees:

```ts
import { getCustomTags } from "@mxlang/core";
import { parseData } from "@mxlang/data";
import { builtinLookup } from "@mxlang/target-registry";

// file is an absolute filesystem path; source is the file's text.
const customTags = getCustomTags(file, { targets: builtinLookup(), host: null });
const { tree, diagnostics } = parseData(source, file, { customTags });
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

`targets` in the second form is the target lookup in hand — for a CLI, the registry lookup from `@mxlang/target-registry`. `host: null` is what the hostless data target scans under (a `hosts`-restricted entry is excluded for data, so a data dialect declares no `hosts`). The data target delegates every non-reserved name, so the module is the entire dialect: no `tags/` directory, no sidecars.

## Composing a dialect from parts

If your dialect is assembled from a core vocabulary plus optional extensions — an extension that adds a child tag to `resource`, say — **generate one self-contained contracts module** from the enabled parts, and name that file under `mx.contracts`.

- **Entries replace, they do not merge.** When two `mx.contracts` modules export the same tag name, the first module's whole entry wins and the scan warns that the name is defined twice; `children`, `parents`, `attributes` and `parseOptions` are not combined. Compose the final `resource` contract in your generator, where you know which extensions are on.
- **Imports are not tracked.** The scan stamps the module file itself, so regenerating it gives every caller a fresh scan map. Under Node, an ESM/TS module's exports are only re-read after a restart; a `.cjs` module is re-read in process (see Limits). An edit to a file the module imports, or to config it reads at load time, goes unseen until a restart. A generated file with no relative imports (beyond `import type`) avoids that.
- **Shadowing stays visible.** A local `tags/<name>.mx` or `mx.tags` entry replaces a module's contract for that name, and the scan reports it: `` `<attribute>` from `mx.contracts` (…) is shadowed by …; the module's contract does not apply ``. The language server and the TypeScript plugin surface that warning, so a user's stray template cannot silently drop a rule of your dialect in the editor (for data files, once editor dispatch for the data target lands: `data-target-tooling-dispatch`). `getCustomTags` returns only the map; a build that discovers the map and must see these warnings reads `scanCached(file, options).diagnostics`.

## Limits

- The module is evaluated synchronously on a scan cache miss: no top-level `await`, and relative imports need explicit extensions (`./helper.ts`, not `./helper`). Keep it self-contained: helper-only edits require a restart.
- The scan tracks the module's mtime and content hash. Under Node, long-lived tools need a restart to reload ESM/TS contracts; Bun reloads them, and CommonJS `.cjs` modules reload on Node too. See [Discovery in the specification](../specification.md#92-discovery).
- Contracts buy precise positioned diagnostics. Completions and hover for contract-only tags are a later, separate piece.
