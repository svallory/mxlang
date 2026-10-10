---
title: "Third-party targets"
description: "Load a target package from mx.target or mx.host in MX's config: the contract, the errors, and how to write one."
---

# Third-party targets

A **target** is an output format a `.mx` file compiles to; a **host** is the framework the file lives inside ([Core and hosts](/architecture/core-and-hosts/)). The built-in targets are `html`, `astro-html`, `solid-jsx`, `preact-jsx`, `react-jsx`, `hono-jsx` and `angular-template`. A project can name another one by package in [MX's config](/configuration/):

```json
{
  "mx": { "target": "@acme/mx-vue" }
}
```

`mx.host: "@acme/mx-vue"` works too, when the package describes a host. The specifier is resolved **from the project** (the directory of the config that holds the key), so a target the project installed is found by the editor, `mx-tsc` and the build alike, even when the language server is the one bundled in the VS Code extension.

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
  // builtOn: "html", // optional: the registered target this one is built on (see below)
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

The name has to be a tag of your target: the registry checks a loaded descriptor's `defaultTag` (and `host.defaultTag`) against core's tag table for your `translator` (its taglibs over your `declarations.default.nativeTags`, the table your compiles read), plus the names your `declarations.default.builtinTags` lists, and a name neither knows is an error at the `mx.target` value naming the owner. No `marko.json` is read for it (decision 197). The optional `parseTranslator` is the translator whose taglibs answer how a tag parses (void, text, whitespace-preserving) in your compiles; absent means `translator`, or the default target's, answers. It is used for this check only, never for the mapping pass.

**`TargetHost.defaultTag?`.** Optional, on the descriptor's `host` part: a host that emits the shorthand as something other than its target's built-in. It outranks the target's `defaultTag` and is outranked by the package's `mx.<target>.defaultTag` and by a parent contract.

**`TargetHost.ambientTypes?`.** Optional function, on the descriptor's `host` part: the declaration files a type-check of your host's files needs beyond what the project's `tsconfig.json` lists, the ones your framework's own tooling adds to every program it checks (the built-in Astro host returns astro's `env.d.ts` and `astro-jsx.d.ts`, which declare `Fragment` and the JSX runtime). Its signature is `ambientTypes({ rootNames, resolve }) => readonly string[]`:

- `mx-tsc` and the TypeScript plugin call it for every program they type-check, with that program's root files. Your host decides whether the program holds files of its own (its `fileKinds`, or the framework files its tooling checks) and returns `[]` when it does not.
- `resolve("<package>/<file>")` is the absolute path of a file of an installed package. It looks in the `node_modules` above the first root file whose policy selects your host first (else above the `tsconfig.json`), then above the `tsconfig.json`, then in the tool's own install, and returns `undefined` when none has the package or the package lacks the file. It reads the package's own files, not its `exports`.
- What you return is added to the program as root files: absolute paths, deduplicated, never a file already in it.
- The hosts asked are those of each root file's own lookup, from the nearest `package.json` above it, then of the `tsconfig.json` directory's: the built-ins plus the host your `mx.target`/`mx.host` loads, as for every other host operation. So a package below a monorepo's root tsconfig gets its host's types too.
- A throw (also one raised while the returned iterable is read), or a return value that is not an iterable of file paths, never stops the check: your host adds nothing and the tools report one file-less `error TS80004` naming your package (`ambientTypes threw: <message>`, `ambientTypes returned <type>, expected an iterable of files`, or, for an entry that is not a non-empty string, `ambientTypes returned a non-path entry (<entry>), expected an iterable of files`). Returning `[resolve(...)]` unchecked is the common way to hit the last one: `resolve` returns `undefined` for a file the package lacks.
- It is validated at load: `host.ambientTypes` must be a function.

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
- `context.configured` is `mx.<target>.defaultTag` already validated, **with the registry's host override folded in** (config, then `host.defaultTag`), or `undefined`. The fall-back to your descriptor's own `defaultTag` is yours.
- `context.customTags` are the compile's custom tags: a parent's contract lives there.
- `context.contractRung` is `false` when your declarations set `allowContractDefaultTag: false`; `contractDefaultTag` honours it.
- `context.scope` carries what the compile can say about reachable names (custom tags, Marko's lookup, the host's `isElement`); `contractDefaultTag` uses it to check the contract's value, and returns `undefined` for a rejected one so the next rung answers. `context.onContractRejected` is how the use-site error learns the declaration was the problem.

**`HostDeclarations.nativeTags?`.** Optional map, on `declarations.default`: your target's native elements by tag name, each `{ namespace: "html" | "svg" | "mathml", body }`, where `body` is how its content parses (`"html"`, `"void"`, `"preserve"`, `"parsed-text"`, `"parsed-text-preserve"`). Core's tag table puts them under your translator's taglibs: they decide which tags parse and lower as void (`<br>`, an IR `Element` with `void: true` and no children), keep their whitespace (`<pre>`) or read their body as text (`<textarea>`, `<script>`), and which lowercase names are elements rather than tags, in a whole file and in a `.<host>.mx` region alike. Every built-in target passes `WEB_ELEMENTS` from `@mxlang/web-elements` (HTML, SVG and MathML, Marko's element rules). Absent means core's own HTML elements: the 14 void elements, `pre`, and the raw-text `script`, `style`, `textarea` and `title`, with no SVG or MathML names. A target that renders SVG or MathML passes `WEB_ELEMENTS` (or its own map). It is `@unstable` (decision 197).

**`HostDeclarations.builtinTags?`.** Optional list, on `declarations.default`: the tag names your target provides without a taglib entry (an anonymous `object`, say). The registry counts them as reachable when it checks `defaultTag` and `host.defaultTag`, and a `children["*"]` wildcard never claims them (they are built-ins of the target), so a descriptor that reuses a target's declarations keeps the target's built-in with no literal of its own. A name no taglib, custom tag or `builtinTags` entry covers is still an error. The field is validated at load: an array of non-empty strings.

**`TargetDescriptor.builtOn?`.** Optional string: the name of the registered target this one is built on (a host that reuses another target's declarations and compile, like a host on `html`). `createTargetLookup` resolves it when your descriptor joins the project's lookup: a name no registered target has, a target built on itself and a loop are positioned load errors naming both targets (`target "mesh-data" is built on "dta", which is not a registered target (registered: ...)`; a host name such as `"solid"` gets a hint naming its target, `"solid-jsx"`). The end of the chain is the target's **base target** (`TargetLookup.baseTargetOf`), and a tool keys a check that belongs to a target on it, never on the project's `mx.target` string. It is generic: any target can be built on any other. **Declare `builtOn` to inherit the base target's config checks.** Reusing a target's `declarations` without it gets none, as before. It is `@unstable`, like the rest of the descriptor.

**`TargetDescriptor.configKey?`.** Optional string: the config key this target's per-target config lives under, `mx[configKey]` (`defaultTag` today), when it is not the target's own `name`. It exists so a renamed target keeps its historical config key and user config survives the rename (decision 187 renamed the since-removed tree target this way, and its `mx.data.*` stayed). Every `mx[<name>]` config read goes through it, in core and in the registry, so a host built on such a target reads the base's config under the same key. A bare word, like a target name; anything else is rejected at load. Default: the target's `name`. It is `@unstable`, like the rest of the descriptor.

**`contractDefaultTag(parents, context, builtins?)`** is the exported helper for rung 1: the nearest authored parent's declared `defaultTag` (reading attribute-tag declarations at any depth, skipping control flow by the tag's own definition, never climbing past a parent that declares none), or `undefined`. `builtins` lists names your target provides without a taglib entry. The same module exports `validateDefaultTag(name, scope)` (the reason a value is invalid, or `undefined`), used by the registry for every rung.
### A host with its own file kind

A descriptor can name its own host and file kind. This is how Mesh ships `.mesh.mx` (decision 148): a package `@acme/mx-mesh` whose `load()` compile reads the file's IR with `lowerSource` (see [the core IR entry point](/architecture/ir-entry/)) and does whatever the dialect does with it. The IR entry point is a function of `@mxlang/core`, not a registered target, so the descriptor is not built on one.

```js
// @acme/mx-mesh/index.cjs
module.exports = {
  descriptorVersion: 0,
  name: "mesh-data",
  packageName: "@acme/mx-mesh",
  defaultTag: "object", // what <#id> and <.class> stand for; lowerSource's own built-in
  declarations: {
    default: {
      builtinTags: ["object"], // reachable without a taglib entry
      // ...the rest of your HostDeclarations
    },
  },
  host: {
    name: "mesh",
    // optional: outranks the target's built-in, outranked by package config and a parent contract
    // defaultTag: "node",
    fileKinds: [{ segment: "mesh", diagnosticSource: "mesh" }], // `.mesh.mx`
  },
  load(core) {
    return {
      compileModule(source, filename, options) {
        const { ir, diagnostics } = core.lowerSource(source, filename, { /* customTags, tagRules, ... */ });
        // walk `ir`; return { code, dependencies } or throw `new core.TranslateError(message, line, column)`
      },
    };
  },
};
```

The project selects it with `mx.host`:

```json
{ "name": "my-app", "mx": { "host": "@acme/mx-mesh" } }
```

- **`defaultTag`** keeps `object` because `builtinTags` travels with the declarations; a host override (`host.defaultTag`) or `mx.mesh-data.defaultTag` follows the [ladder](#third-party-targets-what-the-package-exports-the-unnamed-tag), and an override the target cannot reach is the same positioned error as on any target. Set `allowContractDefaultTag: false` on a copy of the declarations to forbid the parent-contract rung.
- **`fileKinds`** is checked like a built-in's: a segment is one lowercase word with no dot and never `mx`, needs a `diagnosticSource`, and is refused when another host already owns it (`file-kind segment "x" is declared more than once (host "a" and host "b")`). A kind without `compileRegion` is a **whole-file** kind: `post.mesh.mx` compiles whole-file on the host's target, never through the region bridge. A segment must be the host's own `name` (`mesh` declares `mesh`, never `react`): the segment before `.mx` is a host name (decisions 136, 148). A kind's `readCalleeInput` is read from the project's own lookup, so two projects that load different hosts never share readers.
- **Tools.** The registry, language server, Vite plugin, `mx-tsc` and the TypeScript plugin all resolve `post.mesh.mx` through `mx.host` and compile it through the descriptor's `load`.

### Use the injected core

The tool passes its own `@mxlang/core` to `load(core)`. Use it. That gives you the tool's scan cache and its unsaved-buffer overrides (so a callee edited in the editor is seen before it is saved), and one `TranslateError` class. A target that imports its own copy still works, and a positioned error it throws stays positioned (the class is recognised by a `Symbol.for` brand, not `instanceof`); declare `@mxlang/core` as a **peer** dependency in that case, so the project installs one copy.

### Contract stability

The descriptor contract is **unstable** until `@mxlang/core` is published under a stable version. `descriptorVersion` is `0`; a package declaring another version is rejected with a clear error rather than half-working.

## Errors

A specifier that resolves and then fails is an error with no fallback: the build must not compile under a target you did not name and look green. Each message is one line then the action, positioned at the key's value:

| Code | Cause |
|---|---|
| `target-not-found` | the specifier does not resolve from the project |
| `target-load-failed` | the module threw while it was evaluated, or the runtime rejected the package's `package.json` (an invalid `exports` target or config, or on Node a `package.json` that is not a JSON object) |
| `target-invalid-descriptor` | the export is not a descriptor (the first failing field is named), its `descriptorVersion` is unsupported, or it cannot be registered next to the built-in targets (see below) |
| `host-invalid-descriptor` | the package is under `mx.host` but its descriptor has no `host` part: use `mx.target`, or add the part |

A failed load is retried on every resolution, so fixing any file it loaded is picked up at once. A target installed after a `target-not-found` loads on the next resolution, with no restart of the language server, TS server or dev server, and it is the same file a fresh process would load: after a miss, the specifier is resolved again by the same runtime in a child process each time the installed packages or their entry files change, and otherwise every 5 to 60 seconds while it stays missing.

The language server shows them on the document, linked to the key in `package.json`. `mx-tsc` and the TypeScript plugin report `TS80003` at the key and `TS80001` on each page, and exit non-zero. See [Host and target selection](/specification/#the-mx-language-13-host-semantics-table-135-host-and-target-selection) for the whole resolution order.

### What a third-party target cannot do yet

- **No region file kinds in the editor.** A loaded host may declare `host.fileKinds` (see [A host with its own file kind](#third-party-targets-what-the-package-exports-a-host-with-its-own-file-kind)): the segment is validated like a built-in's, joins the project's lookup and routes whole-file on the host's target. A kind that carries a `compileRegion` (TypeScript with MX regions) is routed by the registry, the language server and Vite from the project's lookup, but the TypeScript plugin builds its region plugins once from the built-ins, so a third-party region kind gets no editor type-checking yet.
- **No joining a built-in host.** A descriptor naming `solid`, `react`, or any other built-in host is rejected: `host "solid" belongs to the built-in targets; a third-party target cannot join it (for now)`. Pick your own host name (TODO `third-party-join-builtin-host`).

Two loaded packages that name the same host agree under `mx.host` / `mx.target`, and a bare `mx.host: "vue"` beside `mx.target: "@acme/mx-vue"` (whose host is `vue`) selects it without an unknown-host warning.

A target with no `declarations` has no lowering policy of its own, so the TypeScript plugin does not re-lower its pages under html's rules: it maps from the mappings and source map the target's `compileModule` returns, or none.

## Trust

The editor and the build `require` the module you name when a `.mx` file is opened or compiled, so name only packages you trust. Sidecars and `mx.contracts` modules are the same class. The VS Code extension declares that it does not support untrusted workspaces; other editors and language-server clients have no such gate.
