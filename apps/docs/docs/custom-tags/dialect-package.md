---
title: "Writing a dialect package"
description: "Ship a whole tag dialect as one mx.contracts module, and hand it to lowerSource with one line."
---

# Writing a dialect package

A dialect — a cohesive vocabulary of tag names with validation rules, like a resource-definition language — ships as a package-level `mx.contracts` module: one file default-exports a `ContractMap` (`Record<string, CustomTag>`, exported by `@mxlang/core`), and each consuming package names the module in its own [MX config](/configuration/).

This page's dialect is a tag vocabulary written in MX's own syntax, in `.mx` files. A dialect that changes the syntax itself and claims file extensions of its own (`.mesh.mx`) is a package that declares `mx.dialect` in its `package.json`; see [the specification, §13.9.2](/specification/). Its `mx.dialect.module` is a file path inside the package (`./dist/dialect.js`), never a package specifier, and once published it must be JavaScript Node can load: build TypeScript to `.js`, `.mjs` or `.cjs` and point `module` at the build. Bun and Vitest load a `.ts` module, Node does not, so MX refuses an installed dialect whose module is TypeScript; a workspace dialect linked into `node_modules` may still point at its source. It cannot claim `.mx` in any spelling, a host's file kind (`.solid.mx`) or a TypeScript, JavaScript or Marko extension; an extension of its own that ends in `.mx`, like `.mesh.mx`, is fine.

A dialect whose users define tags in the dialect's own files, in a directory of the dialect's choosing, declares `tagDirs` and reads them with a hook: see [Tag files](#writing-a-dialect-package-tag-files-a-directory-of-definitions).

Building a file calls its dialect's emit. Core is dialect zero: its emit is the compile MX's own files get, so a plain `.mx` file builds the same in every tool. A dialect has no emit, so the tools that build refuse its files (the Vite plugin at the import, the Bun loader at the file: `<dialect name> files cannot be imported: the dialect registers no emit`) and the tools that check run `lowerSource` on them. See [the IR entry point](/architecture/ir-entry/).

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

A bare specifier resolves through the consuming package's own `node_modules`, using `require`/`default` export conditions; installed dialect packages must export JavaScript. A relative path resolves against the package directory. The language server, `mx-tsc`, the TypeScript and Vite plugins, and the Bun loaders discover the module without per-tool configuration. Contract-only calls require a target that delegates their names; `lowerSource` delegates every non-reserved name. The tools check a dialect file against this map: `lowerSource` reports a call that breaks a contract as an ordinary diagnostic of the file.

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
| Needs `mx.contracts` in MX's config | no | yes, to include the dialect's contracts |
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

## Explaining an unknown tag

A tag with no contract is not always a mistake in your language. A dialect that reads `entity:Todo` as a member of a family it does not declare can say so, in its own words and code, with `explainUnknownTag`. The hook only explains: it cannot claim the tag or give it IR.

```ts
// dialect.ts
import type { Dialect } from "@mxlang/core";

export default {
  table: {},
  tagRules: "none",
  explainUnknownTag(tag) {
    const colon = tag.name.indexOf(":");
    if (colon < 0) return undefined; // core's rule applies
    const kind = tag.name.slice(0, colon);
    const inside = tag.ancestors.at(-1)?.tag ?? "the top level";
    return {
      code: "WIDGETS_NO_SUCH_KIND",
      message: `\`${kind}\` is not a kind of widget (found in ${inside}); write \`<widget kind="${kind}">\``,
      at: tag.nameSpan,
    };
  },
} satisfies Partial<Dialect>;
```

- It is called for each tag that has no contract, in `"allow"` and `"reject"` mode alike, with the tag's name and spans, the authored tags around it (each with the contract in force inside it, `defaultTag` included), the mode, the file and its text. It is not called for a declared tag, a child a parent's `children["*"]` claims, an `<@attribute-tag>`, a dynamic tag or an `if`/`for`/`const`.
- Returning `undefined` hands the tag back to core. Returning an explanation makes it the only diagnostic for that tag: no `MX_UNKNOWN_TAG`, and no "not allowed" from a closed parent. The result then has no IR, in `"allow"` mode too.
- You give `message`, and optionally `code` (your own namespace, not `MX_`) and `at`, a span inside the document. Core computes the position. An empty message, a bad `at`, or a hook that throws is one `MX_DIALECT_HOOK_ERROR` at the tag.
- The hook gets the same view when the file lowered and when lowering failed elsewhere, so the explanation does not change with an unrelated error.

## Composing a dialect from parts

If your dialect is assembled from a core vocabulary plus optional extensions — an extension that adds a child tag to `resource`, say — **generate one self-contained contracts module** from the enabled parts, and name that file under `mx.contracts`.

- **Entries replace, they do not merge.** When two `mx.contracts` modules export the same tag name, the first module's whole entry wins and the scan warns that the name is defined twice; `children`, `parents`, `attributes` and `parseOptions` are not combined. Compose the final `resource` contract in your generator, where you know which extensions are on.
- **Imports are not tracked.** The scan stamps the module file itself, so regenerating it gives every caller a fresh scan map. Under Node, an ESM/TS module's exports are only re-read after a restart; a `.cjs` module is re-read in process (see Limits). An edit to a file the module imports, or to config it reads at load time, goes unseen until a restart. A generated file with no relative imports (beyond `import type`) avoids that.
- **Shadowing stays visible.** A local `tags/<name>.mx` or `mx.tags` entry replaces a module's contract for that name, and the scan reports it: `` `<attribute>` from `mx.contracts` (…) is shadowed by …; the module's contract does not apply ``. The language server and the TypeScript plugin surface that warning, so a user's stray template cannot silently drop a rule of your dialect in the editor (for dialect files too, since the tools check them with `lowerSource`). `getCustomTags` returns only the map; a build that discovers the map and must see these warnings reads `scanCached(file, options).diagnostics`.

## Tag files: a directory of definitions

> **Not released yet.** Everything in this section is `@unstable` and ships after the dialect basics above.

A dialect can let its users define tags the way MX users do with `tags/`, but in the dialect's own language: one file per tag, in a directory the dialect names, in a file kind the dialect owns. The running example is a dialect `forma` that claims `.forma.mx` and keeps its tag definitions in `concepts/`, so `concepts/money.forma.mx` defines `<money>` for every `.forma.mx` file of the package.

### The manifest fields

```json
{
  "name": "@my/forma",
  "mx": {
    "dialect": {
      "id": "forma",
      "name": "Forma",
      "extensions": [".forma.mx"],
      "module": "./dist/dialect.js",
      "tagDirs": ["concepts", "kinds"],
      "tagExtensions": [".kind.forma.mx"],
      "sidecars": false,
      "reservedTags": ["entity"]
    }
  }
}
```

All four are optional. Without them a dialect's files discover tags exactly as before: from `tags/`, as `.mx` templates and `.tag.ts` sidecars.

| Field | Meaning |
|---|---|
| `tagDirs` | Directory names (not paths) the dialect's files discover tags in. Replaces `tags/` for them. |
| `tagExtensions` | Extra extensions its tag files may use, written like `extensions` and routed like them: `concepts/money.kind.forma.mx` belongs to Forma, and the longest claimed suffix names the tag, so this file defines `<money>`, not `<money.kind>`. |
| `sidecars` | Whether `.tag.ts` sidecars in those directories are read. On by default; `false` ignores them with a warning. |
| `reservedTags` | Tag names only this dialect may define. See [Reserved names](#writing-a-dialect-package-tag-files-a-directory-of-definitions-reserved-names). |

A field with a wrong value is an error in your `package.json`, at its key. [The specification, §13.9.2](/specification/) lists each message.

### Which tags a file sees

Discovery depends on the dialect of the file that makes the call, and the nearest definition wins:

- A `.forma.mx` file looks in `concepts/` and `kinds/`, at its own directory first and then upward to the package root. A tag file nearer the caller beats one further away, and the winner replaces the whole entry, as for `tags/`. It also gets the project's `mx.tags` and `mx.contracts`, as every file does. It does not get `.mx` templates, because a dialect file cannot call a template tag.
- A plain `.mx` file never sees `concepts/`. It looks in `tags/`, and a Forma file in `tags/` is not one of its tags: the scan skips it and says so (`MX_MISPLACED_TAG_FILE`).
- Core is the dialect every other dialect is measured against: its own entry is `tagDirs: ["tags"]`, extensions `[".mx"]`, sidecars on, and the structural names reserved. Nothing in the rules above is special to it.

The name of a tag is the file name minus the longest extension the calling dialect claims, and must be a usable tag name. A file named `money.component.forma.mx` with no matching `tagExtensions` entry would be `<money.component>`, which no call can write, so the scan warns and names the entry that fixes it.

### Reading a tag file: the `tagFile` hook

The scan only finds names. The contract of a tag comes from the dialect module's `tagFile` hook, which runs the first time a file calls the tag, never during the scan. A file that never calls `<money>` never pays for `money.forma.mx`, and a dialect with `tagDirs` and no hook makes every call an error.

```ts
import type { DialectModule, TagFileContext, TagFileInput, TagFileResult } from "@mxlang/core";

export default {
  table: {},
  tagFile(file: TagFileInput, ctx: TagFileContext): TagFileResult {
    // `file.path` is absolute, `file.source` is its text, `file.name` is the tag name.
    const lowered = ctx.lower(); // the tag file, under Forma's rules, with its own tags
    return {
      contract: { attributes: attributesDeclaredIn(file.source) }, // Forma's own reading of the file
      diagnostics: lowered.diagnostics, // core adds `file` for the tag file's own
    };
  },
} satisfies DialectModule;
```

The types (`TagFileInput`, `TagFileContext`, `TagFileResult`, `TagFileDiagnostic`) are exported from `@mxlang/core`. What the hook may use:

- **`ctx.lower(options?)`** lowers the tag file with `lowerSource`, under its own dialect and the tags its own directory sees (not the caller's). The result is memoized per options. The tags it sees stay lazy, so lowering a tag file that calls another one reads that one's contract only at the call.
- **`ctx.dependsOn(path)`** names a file your answer reads, relative to the tag file, so an edit to it re-derives this contract. Every tag file this one calls while lowering is a dependency automatically, transitively.
- **The contract** holds `attributes`, `attributeTags`, `children`, `parents`, `defaultTag`, and the keys your dialect claims (`contractFields.tag`). Any other key is an error. `parseOptions` and `template` are refused: a call is parsed before any contract is read, so static `parseOptions` and hooks come from a `.tag.ts` sidecar beside the tag file (`concepts/money.tag.ts`), when `sidecars` is on.
- **Diagnostics** are in the tag file's coordinates (1-based line, 0-based column). The hook is sync, and a hook that throws is an error at the thrown error's own position, else at the file's 1:0; it never takes the compile down.

A call to the tag then gets exactly what a call to a `tags/money.tag.ts` contract gets: the same checks, errors and codes (including the `defaultTag` check), raised at the call. Its `DelegatedTag` carries `definedIn`, the tag file's path.

The derived contract is cached per tag file, and it is current as long as the tag file's stamp, your dialect module, the tag file's own scan and every dependency are unchanged. Failures are cached the same way. Tag files whose lowering calls each other are a cycle: the call that re-enters fails, nothing on the cycle is cached, and fixing one file clears it. `clearTagFileCache()` drops every derived contract, for a tool that wants a clean start.

### Reserved names

Core reserves the structural names (`if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static`, `try`), so no tag file, `mx.tags` entry, contracts module or `customTags` map can define them. A dialect's `reservedTags` adds names only the dialect may define, through its own contracts or the `customTags` its front end passes to `lowerSource`. A definition that breaks this is refused with `MX_RESERVED_TAG`, and calls of the name resolve as if it had never been defined. A name core already reserves in `reservedTags` is an error in your manifest.

### Diagnostics

A tool that shows a dialect file shows these, each with its severity, code and the file it is in; [the specification, §9.2](/specification/) has the exact wording.

| Code | Severity | When |
|---|---|---|
| `MX_TAG_FILE_ERROR` | error, at the call | The tag file cannot be read (no `tagFile` hook) or its definition has errors. The tag file's own diagnostics come with it, each in its own file. |
| `MX_TAG_FILE_CYCLE` | error, at the re-entering call | Tag files call each other: `a → b → a`. |
| `MX_MISPLACED_TAG_FILE` | warning, at the file | A dialect's tag file sits in a directory the dialect does not scan (`tags/`). |
| `MX_RESERVED_TAG` | error, at the definition | A reserved name was defined. |

The scan has more codes (`MX_SIDECAR_IGNORED`, `MX_DOTTED_TAG_FILE_NAME`, `MX_INVALID_TAG_FILE_NAME`, `MX_BUILTIN_TAG_FILE`); the specification lists them all.

A diagnostic that is in a tag file shows at the head of the file that made the call, naming the tag file, and on the tag file itself in an editor.

### A dialect's check in your own tool

`checkDialectFile` (`@mxlang/targets/dialect-check`) is the one function the language server, `mx-tsc` and the TypeScript plugin call to check a dialect file. A diagnostic whose problem is in another file carries `origin: { file, line, column }`; its own `line`, `column` and `offset` are the head of the checked file.

## Limits

- The module is evaluated synchronously on a scan cache miss: no top-level `await`, and relative imports need explicit extensions (`./helper.ts`, not `./helper`). Keep it self-contained: helper-only edits require a restart.
- The scan tracks the module's mtime and content hash. Under Node, long-lived tools need a restart to reload ESM/TS contracts; Bun reloads them, and CommonJS `.cjs` modules reload on Node too. See [Discovery in the specification](../specification.md#the-mx-language-9-custom-tags-92-discovery).
- Contracts buy precise positioned diagnostics. Completions and hover for contract-only tags are a later, separate piece.
