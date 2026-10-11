---
title: "Writing a dialect"
description: "A dialect claims file extensions, ships its own tag vocabulary as contracts, and decides where its users define tags."
---

# Writing a dialect

A dialect is a language built on MX: it claims file extensions of its own (`.forma.mx`), may change the syntax, and ships its own tag vocabulary. It is a package that declares `mx.dialect` in its `package.json`; see [the specification, §13.9.2](/specification/). Its `mx.dialect.module` is a file path inside the package (`./dist/dialect.js`), never a package specifier, and once published it must be JavaScript Node can load: build TypeScript to `.js`, `.mjs` or `.cjs` and point `module` at the build. Bun and Vitest load a `.ts` module, Node does not, so MX refuses an installed dialect whose module is TypeScript; a workspace dialect linked into `node_modules` may still point at its source. It cannot claim `.mx` in any spelling, a host's file kind (`.solid.mx`) or a TypeScript, JavaScript or Marko extension; an extension of its own that ends in `.mx`, like `.forma.mx`, is fine.

Building a file calls its dialect's emit. Core is dialect zero: its emit is the compile MX's own files get, so a plain `.mx` file builds the same in every tool. A dialect has no emit, so the tools that build refuse its files (the Vite plugin at the import, the Bun loader at the file: `<dialect name> files cannot be imported: the dialect registers no emit`) and the tools that check run `lowerSource` on them. See [the IR entry point](/architecture/ir-entry/).

A tag vocabulary for `.mx` files that projects opt into is a [contract package](/custom-tags/contract-packages/) instead: a `mx.contracts` module, no dialect.

## The vocabulary

The tags your language defines go in `contracts` on the dialect's module: a `ContractMap`, the same map a [contract package](/custom-tags/contract-packages/) exports. Every file of the dialect is checked against it, in the language server, `mx-tsc` and the TypeScript plugin as in your own compiler, without the project listing anything.

```ts
// dialect.ts
import type { ContractMap, Dialect } from "@mxlang/core";

const contracts = {
  entity: {
    attributes: { name: { type: "string", required: true } },
    children: { field: { repeatable: true } },
  },
  field: {
    attributes: { name: { type: "string", required: true }, type: { type: "string" } },
    parents: ["entity"],
  },
} satisfies ContractMap;

export default {
  table: {},
  tagRules: "none",
  contracts,
} satisfies Partial<Dialect>;
```

`contracts` is `@unstable`. Each entry is a contract a registration would accept: a plain object with any `CustomTag` key but `template` (a tag with a template is a tag file), plus the keys your dialect claims in `contractFields.tag`; hooks that are functions; valid `parseOptions`; declarations core accepts, which runs your `checkContract`. The name must be a usable tag name that core does not reserve. MX checks the map once per revision of your module, when the dialect loads, not on every compile.

An entry that fails stops the whole dialect: every file of it reports `MX_INVALID_DIALECT_CONTRACT`, at the entry's key in your module (`` `contracts.if`: `<if>` cannot name a data tag: it is reserved … ``), or at the module's `1:0` when `contracts` is not written as a literal. A code your `checkContract` gave is kept. In the tools the diagnostic carries `origin`, the place in your module, and sits at the head of the checked file. The failure stays until you edit the module; an edit re-checks every open file of the dialect.

Two limits to that freshness. MX watches the module file only, so a `contracts` map the module imports from a sibling file is not re-read until the module file itself changes: bundle the dialect into one file. And Node keeps an ES-module dialect (`.mjs`, or `.js` under `"type": "module"`) until the process restarts, so a long-running tool needs a restart to see an edit to one.

### Which definition wins

A file of your dialect gets your contracts beside the project's own definitions. For a tag `<x>`, highest first:

1. Core's reserved names and `<try>`. A contract naming one fails the dialect.
2. A PascalCase name the file itself binds (an import, a `<define>`, a `<const>`, a tag parameter).
3. Your contracts whose names your manifest lists in `reservedTags`. A tag file, `mx.tags` entry, `mx.contracts` entry or `customTags` entry of the project that defines the name is `MX_RESERVED_TAG`, and calls are checked against your contract. A template compiler (`compileSource`, `parseFragment`) given such a `customTags` entry for a file routed to your dialect throws `MX_RESERVED_TAG` instead of compiling.
4. The project's definitions: tag files, then `mx.tags`, then `mx.contracts` (or the `customTags` a caller passes).
5. Your other contracts. A project definition of the same name replaces one silently: an unreserved contract is a default the project may override.

Each winner replaces the whole entry. A plain `.mx` file never sees your contracts. Your own front end, which passes the dialect as the `dialect` option, owns the vocabulary: its `customTags` override every contract, reserved ones included.

### Keeping the project's config out: `mxConfigTags`

By default your files also take the project's `mx.tags` and `mx.contracts`, as every file does. A language whose files must mean the same in every project turns that off in the manifest:

```json
{
  "mx": {
    "dialect": {
      "id": "forma",
      "name": "Forma",
      "extensions": [".forma.mx"],
      "module": "./dist/dialect.js",
      "mxConfigTags": false
    }
  }
}
```

With `false`, your files take no definition from `mx.tags` or `mx.contracts`, silently: the same config still serves the project's `.mx` files, and a call your vocabulary does not define is an unknown tag. Tag files still apply (`tags/`, or the directories your `tagDirs` names). A value other than a boolean is an error at the key.

## How strict your files are: `structural`, `imports`, `unknownTags`

Your own compiler lowers its files with `lowerSource` and tells it how strict to be: no `<if>` or text in a file that is only data, imports allowed, a closed vocabulary. The editor, `mx-tsc` and the TypeScript plugin call `lowerSource` with none of those options, so they would check the same file more loosely. Put the three values on the dialect's module and every caller that leaves them out gets yours:

```ts
// dialect.ts
import type { Dialect } from "@mxlang/core";

export default {
  table: {},
  tagRules: "none",
  contracts: { entity: {}, field: { parents: ["entity"] } },
  structural: "reject", // text, `${}`, `<if>`, `<for>`, `<const>`, `export` and `static` are errors
  imports: "pass", // but a top-level `import` is fine
  unknownTags: "reject", // a tag with no contract is `MX_UNKNOWN_TAG`
} satisfies Partial<Dialect>;
```

Each field is the dialect's default for the [`lowerSource` option](/architecture/ir-entry/) of the same name, with the same values. All three are `@unstable`.

- **Resolution.** For each option, the call's value wins, then the dialect's, then the option's own default. `imports` defaults to the effective `structural`, so a dialect that states only `structural: "reject"` rejects `import` too.
- **Which dialect.** The one in the call's `dialect` option, else the one the file routes to. Your CLI that passes `dialect: YOUR_DIALECT` and the editor that routes by extension read the same object, so they cannot drift apart.
- **A call can override.** Pass the option and it wins in both directions, for a test that wants the open set or a special file that needs a looser rule. The tools never pass them.
- **One value per dialect.** It covers every file the dialect claims, tag files included. A `tagFile` hook that wants other values for its tag files passes them to `ctx.lower`.
- **`.mx` files are unaffected.** They route to no dialect.
- **A wrong value** is an error in your module, like a wrong `tagRules`: `` `structural` must be "pass" or "reject" ``.

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
| `tagDirs` | Directory names (not paths) the dialect's files discover tags in. Replaces `tags/` for them. Absent means `["tags"]`, so the dialect's files discover `tags/` as MX's do; `[]` means none, which closes `tags/` to the dialect's files so a call to a tag defined there is an unknown tag. `mx.tags` and `mx.contracts` are a separate setting (`mxConfigTags`). |
| `tagExtensions` | Extra extensions its tag files may use, written like `extensions` and routed like them: `concepts/money.kind.forma.mx` belongs to Forma, and the longest claimed suffix names the tag, so this file defines `<money>`, not `<money.kind>`. |
| `sidecars` | Whether `.tag.ts` sidecars in those directories are read. On by default; `false` ignores them with a warning. |
| `reservedTags` | Tag names only this dialect may define. See [Reserved names](#writing-a-dialect-tag-files-a-directory-of-definitions-reserved-names). |

A field with a wrong value is an error in your `package.json`, at its key. [The specification, §13.9.2](/specification/) lists each message.

### Which tags a file sees

Discovery depends on the dialect of the file that makes the call, and the nearest definition wins:

- A `.forma.mx` file looks in `concepts/` and `kinds/`, at its own directory first and then upward to the package root. A tag file nearer the caller beats one further away, and the winner replaces the whole entry, as for `tags/`. It also gets the project's `mx.tags` and `mx.contracts`, unless the manifest sets `mxConfigTags: false`, and the dialect's own `contracts`. It does not get `.mx` templates, because a dialect file cannot call a template tag.
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

- **`ctx.lower(options?)`** lowers the tag file with `lowerSource`, under its own dialect and the tags its own directory sees (not the caller's). An option you leave out takes the dialect's value ([`structural`, `imports`, `unknownTags`](#writing-a-dialect-how-strict-your-files-are-structural-imports-unknowntags)). The result is memoized per options. The tags it sees stay lazy, so lowering a tag file that calls another one reads that one's contract only at the call.
- **`ctx.dependsOn(path)`** names a file your answer reads, relative to the tag file, so an edit to it re-derives this contract. Every tag file this one calls while lowering is a dependency automatically, transitively. The hook reads `path` from the disk, so the editor re-checks a file that calls the tag when `path` is saved or changes on disk. The tag file's own `source` is the editor's text, saved or not.
- **The contract** holds `attributes`, `attributeTags`, `children`, `parents`, `defaultTag`, and the keys your dialect claims (`contractFields.tag`). Any other key is an error. `parseOptions` and `template` are refused: a call is parsed before any contract is read, so static `parseOptions` and hooks come from a `.tag.ts` sidecar beside the tag file (`concepts/money.tag.ts`), when `sidecars` is on.
- **Diagnostics** are in the tag file's coordinates (1-based line, 0-based column). The hook is sync, and a hook that throws is an error at the thrown error's own position, else at the file's 1:0; it never takes the compile down.

A call to the tag then gets exactly what a call to a `tags/money.tag.ts` contract gets: the same checks, errors and codes (including the `defaultTag` check), raised at the call. Its `DelegatedTag` carries `definedIn`, the tag file's path.

The derived contract is cached per tag file, and it is current as long as the tag file's stamp, your dialect module, the tag file's own scan and every dependency are unchanged. Failures are cached the same way. Tag files whose lowering calls each other are a cycle: the call that re-enters fails, nothing on the cycle is cached, and fixing one file clears it. `clearTagFileCache()` drops every derived contract, for a tool that wants a clean start.

### Reserved names

Core reserves the structural names (`if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static`, `try`), so no tag file, `mx.tags` entry, contracts module or `customTags` map can define them. A dialect's `reservedTags` adds names only the dialect may define: its own `contracts` define them, or the `customTags` its front end passes to `lowerSource` with the dialect as its `dialect` option. A reserved name needs no contract (it then only refuses the project's definitions), and a contract need not be reserved; MX checks neither direction. A definition that breaks this is refused with `MX_RESERVED_TAG`, and calls of the name resolve as if it had never been defined. A name core already reserves in `reservedTags` is an error in your manifest.

### Diagnostics

A tool that shows a dialect file shows these, each with its severity, code and the file it is in; [the specification, §9.2](/specification/) has the exact wording.

| Code | Severity | When |
|---|---|---|
| `MX_TAG_FILE_ERROR` | error, at the call | The tag file cannot be read (no `tagFile` hook) or its definition has errors. The tag file's own diagnostics come with it, each in its own file. |
| `MX_TAG_FILE_CYCLE` | error, at the re-entering call | Tag files call each other: `a → b → a`. |
| `MX_MISPLACED_TAG_FILE` | warning, at the file | A dialect's tag file sits in a directory the dialect does not scan (`tags/`). |
| `MX_RESERVED_TAG` | error, at the definition | A reserved name was defined. |
| `MX_INVALID_DIALECT_CONTRACT` | error, at the entry in your module | An entry of your `contracts` cannot register. Every file of the dialect reports it. |

The scan has more codes (`MX_SIDECAR_IGNORED`, `MX_DOTTED_TAG_FILE_NAME`, `MX_INVALID_TAG_FILE_NAME`, `MX_BUILTIN_TAG_FILE`); the specification lists them all.

A diagnostic that is in a tag file shows at the head of the file that made the call, naming the tag file, and on the tag file itself in an editor.

### A dialect's check in your own tool

`checkDialectFile` (`@mxlang/targets/dialect-check`) is the one function the language server, `mx-tsc` and the TypeScript plugin call to check a dialect file. A diagnostic whose problem is in another file carries `origin: { file, line, column }`; its own `line`, `column` and `offset` are the head of the checked file.

