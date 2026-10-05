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
  defaultTag: "div", // required: what <#id> and <.class> stand for on this target
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

### The unnamed tag

`<#id>` and `<.class>` with no tag name are an **unnamed tag** ([specification](/specification/#the-mx-language-4-elements-and-attributes-the-unnamed-tag), [ADR 145](/design-notes/adr-default-tag/)). Core recognises one and asks the target which tag it stands for; a target supplies the answer in four places.

**`TargetDescriptor.defaultTag` (required).** A non-empty string: the built-in tag the shorthand stands for in your output (`div` for an HTML-emitting target). It is the last rung of the ladder. The registry refuses a descriptor without it, positioned at the `mx.target` (or `mx.host`) value:

```text
`defaultTag` is missing: the tag `<#id>`/`<.class>` stands for on this target, expected a string
```

The name has to be a tag of your target: the registry checks a loaded descriptor's `defaultTag` (and `host.defaultTag`) against the Marko lookup built from your `translator`, and a name that lookup does not know is an error at the `mx.target` value naming the owner. The optional `parseTranslator` is the Marko translator whose taglib answers how a tag parses (void, text, whitespace-preserving) in your compiles; absent means `translator`, or the default target's, answers. It is used for this check only, never for the mapping pass.

**`TargetHost.defaultTag?`.** Optional, on the descriptor's `host` part: a host that emits the shorthand as something other than its target's built-in. It outranks the target's `defaultTag` and is outranked by the package's `mx.<target>.defaultTag` and by a parent contract.

**`HostDeclarations.allowContractDefaultTag?`.** Optional boolean, on `declarations.default`. Absent means `true`. Set it to `false` when your target cannot honour a per-tag default: a contract that declares `defaultTag` is then a registration error naming the host (or the target, if it has no host part), and the contract rung is never consulted. This is the only place the flag lives.

**`HostDeclarations.resolveDefaultTag?(node, parents, context)`.** The hook core calls once per unnamed tag, top-down, after the parse and before lowering; it returns the tag name, which then lowers exactly like an authored tag of that name (`#x` stays `id="x"`, `.a.b` stays `class="a b"`). Without it, using the shorthand is a positioned error ("no default tag is declared…"); the built-in targets all implement it, so a third-party target that wants the ladder implements it too.

```ts
import { contractDefaultTag, type DefaultTagContext, type DefaultTagParent } from "@mxlang/core";

const BUILT_IN = "div"; // the same value as the descriptor's defaultTag

// in your HostDeclarations
resolveDefaultTag(node, parents: readonly DefaultTagParent[], context: DefaultTagContext) {
  return contractDefaultTag(parents, context, [BUILT_IN]) ?? context.configured ?? BUILT_IN;
}
```

- `parents` is the authored ancestor chain, **nearest first**. Each entry has `name` (an attribute tag keeps its `@`), `attributeTag`, the Marko `node`, and `tagDef` (Marko's tag def for that name in this compile's lookup, when it has one). Control-flow tags (`if`, `for`, …) are in the chain as ordinary entries; an unnamed ancestor appears under the name it was already resolved to.
- `context.configured` is `package.json#mx.<target>.defaultTag` already validated, **with the registry's host override folded in** (config, then `host.defaultTag`), or `undefined`. The fall-back to your descriptor's own `defaultTag` is yours.
- `context.customTags` are the compile's custom tags: a parent's contract lives there.
- `context.contractRung` is `false` when your declarations set `allowContractDefaultTag: false`; `contractDefaultTag` honours it.
- `context.scope` carries what the compile can say about reachable names (custom tags, Marko's lookup, the host's `isElement`); `contractDefaultTag` uses it to check the contract's value, and returns `undefined` for a rejected one so the next rung answers. `context.onContractRejected` is how the use-site error learns the declaration was the problem.

**`contractDefaultTag(parents, context, builtins?)`** is the exported helper for rung 1: the nearest authored parent's declared `defaultTag` (reading attribute-tag declarations at any depth, skipping control flow by the tag's own definition, never climbing past a parent that declares none), or `undefined`. `builtins` lists names your target provides without a taglib entry. The same module exports `validateDefaultTag(name, scope)` (the reason a value is invalid, or `undefined`), used by the registry for every rung.
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
| `target-invalid-descriptor` | the export is not a descriptor (the first failing field is named), its `descriptorVersion` is unsupported, or it cannot be registered next to the built-in targets (see below) |
| `host-invalid-descriptor` | the package is under `mx.host` but its descriptor has no `host` part: use `mx.target`, or add the part |

A failed load is retried on every resolution, so fixing any file it loaded is picked up at once. After installing a *missing* target, restart the language server, TS server or dev server: both Bun and Node keep a resolution miss once the project has a `node_modules`.

The language server shows them on the document, linked to the key in `package.json`. `mx-tsc` and the TypeScript plugin report `TS80003` at the key and `TS80001` on each page, and exit non-zero. See [Host and target selection](/specification/#135-host-and-target-selection) for the whole resolution order.

### What a third-party target cannot do yet

- **No file kinds.** A descriptor with `host.fileKinds` is rejected: `mx.target "@acme/mx-vue" cannot be registered next to the built-in targets: file kinds are supported for built-in targets only (for now).` Reader registration, `hostModuleSegment` and editor wiring exist only for built-ins (TODO `third-party-file-kinds`). Page `.mx` files are fully supported.
- **No joining a built-in host.** A descriptor naming `solid`, `react`, or any other built-in host is rejected: `host "solid" belongs to the built-in targets; a third-party target cannot join it (for now)`. Pick your own host name (TODO `third-party-join-builtin-host`).

Two loaded packages that name the same host agree under `mx.host` / `mx.target`, and a bare `mx.host: "vue"` beside `mx.target: "@acme/mx-vue"` (whose host is `vue`) selects it without an unknown-host warning.

A target with no `declarations` has no lowering policy of its own, so the TypeScript plugin does not re-lower its pages under html's rules: it maps from the mappings and source map the target's `compileModule` returns, or none.

## Trust

The editor and the build `require` the module you name when a `.mx` file is opened or compiled, so name only packages you trust. Sidecars and `mx.contracts` modules are the same class. The VS Code extension declares that it does not support untrusted workspaces; other editors and language-server clients have no such gate.
