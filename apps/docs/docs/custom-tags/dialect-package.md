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

## The data one-liner

`parseData` does not scan. Hand it the discovered map:

```ts
import { getCustomTags } from "@mxlang/core";
import { parseData } from "@mxlang/data";
import { builtinLookup } from "@mxlang/target-registry";

// file is an absolute filesystem path; source is the file's text.
const targets = builtinLookup();
const customTags = getCustomTags(file, { targets, host: null });
const { tree, diagnostics } = parseData(source, file, { customTags });
```

`targets` is the target lookup in hand — for a CLI, the registry lookup from `@mxlang/target-registry`. `host: null` is what the hostless data target scans under (a `hosts`-restricted entry is excluded for data, so a data dialect declares no `hosts`). The data target delegates every non-reserved name, so the module is the entire dialect: no `tags/` directory, no sidecars.

## Limits

- The module is evaluated synchronously on a scan cache miss: no top-level `await`, and relative imports need explicit extensions (`./helper.ts`, not `./helper`). Keep it self-contained: helper-only edits require a restart.
- The scan tracks the module's mtime and content hash. Under Node, long-lived tools need a restart to reload ESM/TS contracts; Bun reloads them, and CommonJS `.cjs` modules reload on Node too. See [Discovery in the specification](../specification.md#92-discovery).
- Contracts buy precise positioned diagnostics. Completions and hover for contract-only tags are a later, separate piece.
