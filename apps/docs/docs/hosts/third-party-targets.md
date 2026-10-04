---
title: "Third-party targets"
description: "Load a target package from package.json#mx.target or mx.host: the contract, the errors, and how to write one."
---

# Third-party targets

A **target** is an output format a `.mx` file compiles to; a **host** is the framework the file lives inside ([Core and hosts](/architecture/core-and-hosts/)). The built-in targets are `html`, `astro-html`, `solid-jsx`, `preact-jsx`, `react-jsx`, `hono-jsx` and `angular-template`. A project can name another one by package:

```json
{
  "mx": { "target": "@acme/mx-vue" }
}
```

`mx.host: "@acme/mx-vue"` works too, when the package describes a host. The specifier is resolved **from the project** (the directory of the `package.json` that holds the key), so a target the project installed is found by the editor, `mx-tsc` and the build alike, even when the language server is the one bundled in the VS Code extension.

A third-party target is never picked by dependency inference: the single-dependency rule applies to built-in targets only, so the key is always explicit.

## What the package exports

A target package exports a **target descriptor**: its default export, its `mxTarget` export, or `module.exports = descriptor`. The descriptor is plain data plus a lazy `load()`:

```js
// index.cjs
module.exports = {
  descriptorVersion: 0,
  name: "vue-sfc", // the mx.target value; distinct from every host and target name
  packageName: "@acme/mx-vue",
  host: { name: "vue" }, // optional: the framework; required under mx.host
  load(core) {
    // `core` is the TOOL's @mxlang/core: use it, do not import your own.
    return {
      compileModule(source, filename, options) {
        // return { code, dependencies } or throw `new core.TranslateError(message, line, column)`
      },
    };
  },
};
```

The loader is synchronous: no top-level `await`, and relative imports need explicit extensions (`./compile.js`, not `./compile`). Bun loads TypeScript directly; under Node the package must be loadable by `require`.

### Use the injected core

The tool passes its own `@mxlang/core` to `load(core)`. Use it. That gives you the tool's scan cache and its unsaved-buffer overrides (so a callee edited in the editor is seen before it is saved), and one `TranslateError` class. A target that imports its own copy still works, and a positioned error it throws stays positioned (the class is recognised by a `Symbol.for` brand, not `instanceof`); declare `@mxlang/core` as a **peer** dependency in that case, so the project installs one copy.

### Contract stability

The descriptor contract is **unstable** until `@mxlang/core` is published under a stable version. `descriptorVersion` is `0`; a package declaring another version is rejected with a clear error rather than half-working.

## Errors

A specifier that resolves and then fails is an error with no fallback: the build must not compile under a target you did not name and look green. Each message is one line then the action, positioned at the key's value:

| Code | Cause |
|---|---|
| `target-not-found` | the specifier does not resolve from the project |
| `target-load-failed` | the module threw while it was evaluated |
| `target-invalid-descriptor` | the export is not a descriptor (the first failing field is named), its `descriptorVersion` is unsupported, or its name, package, host or file-kind segment is already owned by a built-in target |
| `host-invalid-descriptor` | the package is under `mx.host` but its descriptor has no `host` part: use `mx.target`, or add the part |

The language server shows them on the document, linked to the key in `package.json`. `mx-tsc` and the TypeScript plugin report `TS80003` at the key and `TS80001` on each page, and exit non-zero. See [Host and target selection](/specification/#135-host-and-target-selection) for the whole resolution order.
