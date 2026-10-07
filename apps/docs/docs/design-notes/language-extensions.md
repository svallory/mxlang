---
title: "Language extensions"
description: "What MX needs so that DSLs and new languages are built on it rather than beside it: the three extension slots, the static manifest that tooling reads without running code, span-by-construction builders, visible expansion, and atoms re-expressed as the first extension."
---

# Language extensions

Status: proposal (decision 182, pending the operator's ruling)

This note answers one question: what does MX need so that it is the best language to build DSLs and "new" languages in? It inventories what MX can already extend, uses Mesh as the acceptance test, reads the prior art for choices it changes, and then states a design: a small set of extension slots, a manifest tooling can read without executing code, spans by construction, and visible expansion. Atoms are worked end to end as the first extension built on the mechanism, which is also the answer to the Marko question.

The short version. MX extends at three places, and only three: the **reader** (meaning for a sigil-prefixed value that core already lexes), **structure** (tag contracts, which exist today), and **semantics** (lowering and transform hooks, which exist today but synthesize unspanned nodes). An extension is an npm package with a manifest that is plain data; its hooks are code the compiler runs and the editor never needs to. The grammar itself is closed: no extension adds a token, a sigil, or a tag form, because every static tool MX ships (tree-sitter, TextMate, the Marko offer) has to work from the grammar alone. Where this note disagrees with the kickoff sketch, section 8 says so.

## 1. What MX can extend today

Everything below is read from source on this worktree. "Static" means a tool learns it by reading files; "code" means a tool has to `require` the user's module to know it.

| Extension point | Changes | Cannot change | Consumer | Static? |
|---|---|---|---|---|
| `HostDeclarations` (`packages/core/src/declarations.ts:84-321`) | Tag dispositions (`inert`/`error`), element vs component, delegated tags, modifier and attribute-method policy, the unnamed tag (`resolveDefaultTag`), `acceptsForeignAttrNames`, `claimsAttributeHash`, `orderAttrs`, `checkBinding` | Grammar, IR kinds, span rules, name sugar | `lower.ts`, `contract-default-tag.ts`, `custom-tags.ts` | No: every member is a function |
| Stateful-tag hooks: `isDelegatedTag`/`resolveDelegatedTag`, `ctx.hoist`, `ctx.bindings.register` | What a host-owned primitive tag lowers to and what it hoists | Which tags exist in the file | `lowerDelegatedTag` (`lower.ts:2941`) | No |
| `CustomTag` contract (`custom-tags.ts:487-514`): `parseOptions`, `attributes`, `attributeTags`, `children` (with `#text` and `"*"`), `parents` (with `#root`, `@name`), `declares`, `defaultTag` | Call-site validation, attribute types (`string|number|boolean|expression|array|function|atom`), atom `values`/`pattern`/`ref`, child cardinality, pattern-named children (decision 147) | The parser, except `text`/`preserveWhitespace`; `openTagOnly` is deliberately not forwarded | `validateCustomTagCall` (`:1451`), `validateCustomTagParents` (`:1090`), `atom-contracts.ts` | Only `parseOptions`, through `readParseOptions` (`scan.ts:638`), which Babel-reads an object literal and refuses anything else |
| `analyze`/`transform`/`finalize` hooks and `ctx.build.*` | The IR a call expands to; declarations other tags can `ref` | Spans: `ctx.build.delegatedTag(name, children, attributeTags, attrs?)` (`:548-553`) takes no `nameSpan`, and a `finalize` has no node at all | `transformCustomTag` (`:2226-2379`) | No |
| `BUILTIN_CUSTOM_TAGS` (`builtin-tags.ts`) | One entry today, `try`, consulted before the caller's tags | Not open to packages; `rejectShadowedRegistration` rejects a user tag of the same name | `lower.ts` | n/a |
| Discovery: `tags/x.mx`, `x.tag.ts`, `package.json#mx.tags`, `mx.contracts` (`scan.ts:408-575`, precedence `:1404`) | Which names are tags in a package, per host | A template-only tag needs no execution; sidecars and `mx.contracts` modules load through `createRequire` (`:50`, `:559`) | `scanCustomTags` (`:1406`), the TS plugin's `tagsFor`, the language server | Layout and `parseOptions` yes; contracts no |
| `TargetDescriptor` (`core/src/target-descriptor.ts:239-320`, `descriptorVersion: 0`) and `createTargetLookup` (`:760`) | A whole target: declarations, translator, `load()`, file kinds, `builtOn` | A third party cannot join a built-in host and its file-kind segment must equal its host name (decision 136); the registry is private (decisions 129/132) | `lookupFor` (`target-registry/src/index.ts:127`), `regionCompileFor` (`:257`), vite plugin, TS plugin, language server, `mx-tsc` | No: `loadTargetDescriptor` (`target-loader.ts:265`) `require`s the package |
| The IR (`core/src/ir.ts`) | Nothing: it is the contract between core and every emitter | `Expr.node` must be positioned; synthesized nodes carry no span (`ir-spec.md:60-64`); no field records which tag produced a node | `Emitter<Out>` (`emit.ts:37-50`), one required method per kind | n/a |
| Parser port front-end rules (`packages/parser/src/frontend/parse.ts:72-90`, `rules.ts:595-653`) | Adds `MxParseError`s per finished tag | Cannot add tokens, nodes or value forms; `MxShorthand.sigil` is the closed union `"#" | "." | ":"` (`parse.ts:580`) | `FrontEnd.runRules` (`parse.ts:1006-1012`) | Internal until PR 3 |
| `@mxlang/babel` `MxHooks` (`src/mx-hooks.ts`): `parseRegion`, `multipleRootsError`; options `mxRegionCompile`, `mxRegionPositionCheck`, `mxRegionFragment` | Where a region may appear and what text replaces it | Anything inside the template grammar; the returned text is re-parsed as JS | `@mxlang/tsx-bridge`, the region hosts | No |
| Editors: `tree-sitter-mx` `grammar.js` (`atom` and `reserved_atom` externals `:94-95`, `_atom_piece` splitting at `:285-290`), VS Code TextMate (`include: text.marko`), Zed `rev` pin | Highlight captures per node type | The node set is compiled at build time; a new token form is a grammar release | Zed, the docs highlighter, VS Code | Static by nature, and therefore closed |
| TS plugin / `mx-tsc` / language server | Typing of `.mx` through the Volar projection; `atomSplices` already types `x=:foo` as `"foo"` (`core.ts:748`); `TranslateError.errors` fans out (`diagnose.ts:464`) | `TranslateError` carries no `code`, origin, or end position (`core.ts:71-129`); the language server ignores `spans` and reports a one-character range (`diagnose.ts:482`); programmatic `customTags` never reach the language server; `mx.target: "data"` is masked by `resolveStaged` (`target-registry/src/index.ts:714-748`) | Editors, CI | Contracts: no. File kinds: yes, from the built-in table |
| Vite plugin | Build-time diagnostics shaped as Vite errors (`relabelBuildErrors`) | Nothing about the language | Vite | n/a |

Three facts fall out of the table and shape the rest of the note.

1. **No generic sigil-value rule exists.** Each sigil is hard-coded: `:name` as an atom (`lexAtom`, `packages/parser/src/template/states/EXPRESSION.ts:897`, lexed only where `expression.atoms` is on), `::name` reserved, `:` in a tag name and `:name` between attributes as the 146 sugar, `:=`, `#`/`.` tag-adjacent shorthands, `@name`, `${`, `...`, `/var`. Adding a value form today touches six places: the lexer hunk and its patch lockstep with the installed `htmljs-parser`, the `Options` handler, the front-end node and `ast.md`, the `read()` stand-in, the core converter (`atoms.ts`), and the stock-parser probe.
2. **Tooling learns almost nothing without running code.** Only tag layout and `parseOptions` are read statically. Every contract, every sidecar hook, every `mx.contracts` module, and every target descriptor is loaded through a synchronous `require`, which is why Node ESM edits need a tool restart (`sync-esm-reload-node`) and why an `mx.contracts` module may hold an `analyze` function the editor must execute to get a diagnostic.
3. **Synthesized nodes have no provenance and no spans.** The builder API has no place to put a span, so `@mxlang/data` rejects a transform's output as a broken invariant (`build.ts:110-118`, `:431`), and no IR field says which tag produced a node, so a diagnostic cannot name the extension that caused it.

## 2. Mesh as the acceptance test

Mesh is an Ash-style resource language on the data target. Its plan lists four needs, in its own order of importance: expressions as a span-accurate TypeScript AST rather than opaque strings; a static tree with spans; tag contracts (allowed children, required attributes, types); and data-only tags. Its open asks are more specific. Each is answered against today's source, then against this design.

**A contract that accepts any child name, or a name pattern, under a parent.** Answered for plain children: `children["*"]` (decision 147, `custom-tags.ts:121-155`) takes an optional anchored regex `pattern` and either a `contract` reference or an inline contract, tried in declaration order, with explicit names winning and the authored spelling kept in `alias`. `defaultTag` was never the route: it only decides what the unnamed tag stands for (`contract-default-tag.ts`). Not answered for attribute tags: `attributeTags` is a plain `Record<string, CustomTagAttributeTag>` with no `"*"` entry, so `<@on_create>`, `<@on_update>` under a Mesh `hooks` tag cannot be declared by pattern. Section 7 sizes that gap as small.

**Transform output that survives `parseData`.** Not answered today. `data-transform-output-tree` is pinned by `unknown-tags.test.ts:466-494` as an `internal error:` diagnostic, and the docs still say `parseData` throws, which the code no longer does. The cause is structural, not a missing feature flag: `ctx.build.delegatedTag` has nowhere to accept a span, and a `finalize` runs with no node. The design fixes it at the builder (section 4.4).

**Multi-error diagnostics.** Partly answered. `TranslateError.errors` (decision 162) carries several contract errors, `parseData` flattens them and never throws, and the parser port's front end returns partial trees with several rule errors. Still single-error: the template lexer stops at its first error (ruling Q20 (a), decision 163), and `parseData` returns `tree: undefined` whenever any diagnostic is an error, so an editor gets no tree from a file with one bad attribute. This note does not reopen 163; it does ask for a partial tree on contract errors (section 7).

**Editor diagnostics for the data target.** Not answered, and deliberately deferred by the operator (`data-target-tooling-dispatch`). The design adds nothing to it: a data-target file reaches the editor through the same `TargetDescriptor.load()` path every host uses once `resolveStaged` stops masking `data`. What this note does require is that nothing in the extension design makes that harder, which is why the manifest is data and the hooks are the existing descriptor mechanism.

**Expressions as a typed AST.** `DataExpr` already carries `code`, `span` and `node: Expression | null` (`targets/data/src/tree.ts:35-41`), a Babel node positioned against the file, and `Expr.atoms` lists the atoms inside it. What Mesh wants beyond that is TypeScript's view of the expression, which is the TS plugin's projection and not an extension slot. It arrives with data-target tooling dispatch, not with this proposal, and the sketch is wrong to list it among the things an extension could provide.

So Mesh's acceptance test for this note is narrow: pattern-named attribute tags, spanned transform output with provenance, a partial tree under contract errors, and diagnostics an agent can act on. Everything else it needs is either done or belongs to the deferred dispatch work.

## 3. Prior art, and the choice each one changes

Every item here moved a decision in section 4. Items that only confirmed a choice are omitted.

- **Spark (Ash's DSL framework).** Spark exposes forty-four extension points, from sections and entities through transformers, persisters and verifiers. The documented pain is duck-typed callbacks, unchecked cross-extension writes, implicit transformer ordering, compile deadlocks, and verifier errors reported as warnings. Mesh's own synthesis of Spark concludes "one typed manifest per extension declares which points it uses" and extensions contribute to each other only through declared contributions. This sets the manifest-first shape, the explicit `extends` contribution (section 4.6) in place of the "entries replace, they do not merge" rule that `mx.contracts` has today, and the rule that a verifier failure is an error, never a warning.
- **Racket `#lang` and reader extensions.** A Racket module can replace its own reader, which is the most powerful form of language extension and also why no editor follows it without running the reader. MX takes the opposite side: the reader is closed (section 4.1) because tree-sitter, TextMate and the Marko offer all work from the grammar alone. Racket also contributes the one good idea: the file's language is stated in a statically visible place. MX puts that statement in the nearest `package.json`, not in the file, because `.mx` files never declare their dialect (section 4.8).
- **Rust procedural macros.** Crate-scoped through `Cargo.toml`, run as code, opaque to tooling: rust-analyzer has to run a proc-macro server to expand them and still cannot explain them. Two choices come from this. Scope is per package, not per file: Cargo-style scoping works and nobody asks for lexical macro imports. And a tool must never need to execute a hook to learn structure, position, or a type: everything the editor needs is in the manifest. Rust's `Span` discipline, where every synthesized token has a span and `call_site()` is the default, is the model for section 4.4.
- **Terra and Lua staged metaprogramming.** Full compile-time access to the host language. Rejected outright: a `.mx` file never runs code at compile time, and an extension's hooks run with contract-validated calls, never with the file. This is the line that keeps "MX is a language, not a tool" true.
- **Babel and SWC plugins.** Visitor-based transforms over the whole AST, with ordering by plugin list and no manifest, so two plugins that touch the same node interact silently. SWC's answer was to sandbox plugins in wasm, which fixes crashes and not semantics. MX gives an extension no visitor and no tree: a hook receives one validated call and returns IR for it (today's `transform`), and two extensions that claim the same name are a positioned error, not an order (section 4.5).
- **Lisp reader macros.** A global, mutable readtable, order-dependent and invisible. This is the argument against any global registry, including a process-wide `registerExtension()`: the active set is a function of the file's package and nothing else.
- **Sweet.js.** Hygienic macros for JavaScript, technically sound, abandoned because no editor, linter or type checker could see through an expansion. The lesson is visible expansion: a synthesized node names its origin (section 4.4), a diagnostic names the extension that raised it, and `mx-tsc` can print a per-node trace.
- **Language workbenches: MPS, Xtext, Spoofax.** Each generates the editor from the grammar, so a language extension is a grammar extension and the tooling follows. MX cannot regenerate tree-sitter per project, which is why the grammar is closed and extension happens one layer up, at meaning. Spoofax's treatment of errors as a first-class language artifact, with codes and positions as part of the definition, is the model for section 4.7's diagnostic shape.
- **Langium.** A declarative grammar from which the language server is generated, and scoping as a configurable service rather than user code. MX already has the seed: `declares` and `ref` on contracts (decision 156) make name resolution a core service that extensions configure. The design keeps it that way and refuses a `resolve` hook.
- **tree-sitter.** The grammar is compiled at build time and the node set is fixed. Any extension model where a package can add a token form is a model where highlighting lies. This closes the sigil set at the language level, and it is why the one grammar change this note asks for is generic: a `sigil_value` node, not one node per meaning.

## 4. The design

### 4.1 Three slots

An extension can do exactly three kinds of thing.

- **Reader: claim a sigil value.** Core lexes `<sigil><name>` in expression position, for every sigil in a closed set, into one opaque spanned node. An extension gives such a node a meaning on a target: what it lowers to, what TypeScript sees, and which contract checks apply. It cannot add a sigil. Today the set is `:` (claimed by atoms) with `::` reserved; the design keeps `:`, keeps `::` reserved, and reserves the rest of the set by decision rather than by accident.
- **Structural: declare tags.** Contracts as they exist: `attributes`, `attributeTags`, `children` with `#text` and `"*"`, `parents`, `declares`, `parseOptions`, `defaultTag`. This is `CustomTag` without `transform`/`finalize`, which is also what an `mx.contracts` module may hold today.
- **Semantic: lower or transform.** `analyze`, `transform` and `finalize`, with one change: every builder takes a span, and every synthesized node carries its origin.

There is no fourth slot. In particular there is no grammar slot (no new tokens, no new tag forms, no new attribute syntax), no visitor slot (no access to the tree), no resolve slot (name resolution is core's `declares`/`ref` service), and no region slot (the `MxHooks` in `@mxlang/babel` are a host's seam, not an extension's).

### 4.2 The manifest

An extension is an npm package whose `package.json` names a manifest module under `mx.extension`. The manifest's default export is an object literal. Core reads it the way `readParseOptions` reads a sidecar today, generalized: Babel parses the module, follows identifiers bound once to a literal, reads through `satisfies` and `as const`, and reports a positioned diagnostic for anything it cannot read without running code (a spread of an import, a call, a conditional). Function-valued members are allowed in the literal; a static reader records that they exist and skips them, and only the compiler `require`s the module to call them.

```ts
import type { Extension } from "@mxlang/core";

export default {
  extensionVersion: 0,
  name: "@mesh/resource",
  requires: ["@mxlang/data"],
  values: {
    ":": { kind: "atom" },
  },
  tags: {
    resource: { parents: ["#root"], children: { attributes: {}, actions: {} } },
    attributes: { parents: ["resource"], children: { "*": { contract: "attribute" } } },
    attribute: {
      attributes: { type: { type: "atom", values: ["string", "integer", "uuid"] } },
    },
  },
  extends: {
    "@mesh/core": { resource: { children: { policies: {} } } },
  },
} satisfies Extension;
```

The types, in the shape core would export:

```ts
export interface Extension {
  extensionVersion: 0;
  /** The package name; used in diagnostics, origins and conflict reports. */
  name: string;
  /** Extensions and targets this one needs active in the same package. */
  requires?: string[];
  /** Reader slot: meaning for a sigil core already lexes. */
  values?: Partial<Record<Sigil, ValueClaim>>;
  /** Structural and semantic slots: today's CustomTag, hooks included. */
  tags?: Record<string, CustomTag>;
  /** Declared contributions to another extension's tags; merged, conflicts are errors. */
  extends?: Record<string, Record<string, ContractPatch>>;
}

/** Closed by core. Adding a member is a language change with a grammar release. */
export type Sigil = ":";

export interface ValueClaim {
  /** The name the IR, the data tree and diagnostics use for this value kind. */
  kind: string;
  /** What TypeScript sees: the name as a string literal type, or a declared type. */
  type?: "literal" | { from: string; export: string };
  /** What the value lowers to on a host; "reject" makes it a positioned error there. */
  lower?: "string-literal" | "reject";
  /** The attribute-contract fields this kind accepts, by name. */
  contract?: string[];
}

/** The subset of CustomTag a contribution may add: declarative keys only. */
export type ContractPatch = Pick<
  CustomTag,
  "attributes" | "attributeTags" | "children" | "parents" | "declares"
>;
```

`CustomTag` is unchanged except for `attributeTags["*"]` (section 7, gap 5). `ValueClaim.kind: "atom"` with `contract: ["values", "pattern", "ref"]` is exactly what `type: "atom"` means today. The point of the shape is not that it is new but that every field an editor needs is a literal.

### 4.3 Ownership

| Owner | Owns | Never owns |
|---|---|---|
| Core | The grammar, including the sigil set and the sigil-value node; the IR; the manifest reader; contract validation; the `declares`/`ref` scope service; the span and origin invariants; diagnostic shape | Any target's meaning for a sigil; any tag vocabulary beyond `try` |
| Target or host | Its `HostDeclarations`; which value claims apply on it (a descriptor may bundle extensions); the emitter | The grammar; contract semantics |
| Extension | Value claims, tag contracts, contributions, hooks | The grammar; the IR; other extensions' tags, except through `extends` |

The one ownership change from today is that a target descriptor may list `extensions` it bundles, so `@mxlang/data` can ship `:` as an atom without every consumer naming it. Core ships the atom claim itself as a built-in extension, for the reason section 5 gives.

### 4.4 Spans and provenance by construction

Two IR changes, both additive.

Every `ctx.build.*` function takes a `from` argument: a node or a `SourceSpan`. A transform passes the call it is expanding; a `finalize` passes the span of the tag unit's registration (the sidecar's `export default` or the manifest entry), because that is the authored place the synthesis comes from. A builder with no `from` does not type-check. `ctx.build.delegatedTag` gains `nameSpan` and `span` from it, so the data target's `requiredSpan` invariant holds for synthesized nodes and `data-transform-output-tree` closes.

Every node a hook produces carries `origin: { extension: string; tag: string; at: SourceSpan }`. Authored nodes have no `origin`. The field is what makes expansion visible: a diagnostic raised on a synthesized node names the extension and the tag that produced it; `mx-tsc --trace` can print one line per synthesized node; the data tree exposes `origin` next to `alias`. This is the Sweet.js lesson and the Rust `Span::call_site()` discipline together.

### 4.5 Scoping and conflicts

The active extension set for a file is a pure function of its nearest `package.json`: the union of `mx.extensions` entries, the extensions bundled by the resolved target, and the file-layout tags under `tags/`. It is resolved the way `mx.target` is resolved today (`host-policy.ts:10-38`), in the same place, with the same diagnostics positioned in `package.json`. No file-level import, no process-wide registry, no environment variable.

Conflicts are positioned errors, never an order:

- Two active extensions declare the same tag name: an error at the second `mx.extensions` entry, naming both packages and the tag. There is no "first wins" and no "last wins". `mx.contracts`'s present replace-and-warn rule is retired for extensions.
- Two active extensions claim the same sigil on the same target: an error at the entry, naming both.
- An extension's `extends` touches a key its target extension already declares: an error, with both spans.
- A local `tags/x.mx` shadows an extension's tag: an error, not the present warning, because a dialect whose rule can be silently dropped by a stray file is not a dialect.
- A `requires` entry that is not active: an error at the manifest.

Resolution order inside a file does not change: wildcard claim, dispositions, structural tags, built-ins, local bindings, registered tags, delegated tags, then elements and components (`lowerAuthoredTag`).

### 4.6 Composition

Extensions compose through two declared channels only. `requires` orders activation and lets a manifest assume another's tags exist. `extends` adds declarative keys to another extension's contract, merged key by key, with any overlap an error. This replaces the Spark pattern of an extension writing into another's entity at transform time, and the `mx.contracts` pattern of "compose the final contract in your generator". A contribution may add a child, an attribute, a parent or a declaration; it may not remove one, change a type, or add a hook. An extension that needs more than that is not extending another; it is replacing it, and should ship its own tag.

### 4.7 How tooling learns without executing

The editor and `mx-tsc` read, and never `require`:

- `package.json#mx.extensions` and the resolved target's bundled list.
- Each manifest's literal, through the generalized static reader.
- The resolved contract map, which is the merge of `tags` and `extends` across the active set, with conflicts as positioned diagnostics.
- The value claims, which give the TS plugin the type of every sigil value and the language server its completion candidates (`atomCandidates` exists; nothing consumes it yet).

The compiler additionally `require`s each manifest module to obtain its hooks. The split is the one Rust and VS Code `contributes` both arrived at: static declarations for the tools, code for the build.

Diagnostics change shape to match. `TranslateError` gains `code` (a stable string such as `mx/unclaimed-sigil`, `mx/child-not-allowed`, `mx/tag-conflict`), `origin` (the extension name, when one raised or caused it), and `end`, so the language server stops emitting one-character ranges and uses `spans`. Codes are what an agent keys on and what a `// mx-ignore` would someday name; an extension's own codes are namespaced by its package name.

### 4.8 What a `.mx` file may and may not do

A `.mx` file may define vocabulary: a template tag by its location under `tags/`, an `export interface Input`, a `<define>`, a `<const>`, imports and exports. It may use any extension active in its package. It may not declare an extension, name a dialect, import a contract, claim a sigil, or run code at compile time. Everything that changes the language is in `package.json` or in a TypeScript module, and all of it is visible to a tool without running it.

### 4.9 Versioning and publishing

A manifest carries `extensionVersion`, reserved at 0 while `descriptorVersion` is 0 and bumped with it. An extension package declares `peerDependencies["@mxlang/core"]` with a range, the same exception the typescript peer has to the exact-pin policy, because the contract types and the builder API are resolved from the consumer. Core refuses a manifest whose `extensionVersion` it does not know with a positioned error naming the two versions. An extension that bundles hooks must be loadable synchronously from Node (no top-level await, explicit `.ts` in imports), which is the existing sidecar constraint (`core/AGENTS.md` on `sync-esm-reload-node`).

### 4.10 Out of scope

Grammar extension in any form. Per-file extension scoping. A visitor or tree API for hooks. A `resolve` hook. Region hosts (the Babel-fork `MxHooks`). Data-target tooling dispatch. Parser error recovery (decision 163). Runtime libraries: an extension may ship one, but core has no opinion on it.

## 5. Worked example: atoms as the first extension

The operator's question is whether atoms can be a language extension rather than a core construct. The answer is that the lexing cannot be, the meaning can be, and core should ship the meaning through the same mechanism a third party would use. Walked end to end:

**Grammar.** Core's template lexer reads `<sigil><ident>` in expression position for every sigil in the closed set, always, not only when `expression.atoms` is on. The front end produces one node, `MxSigilValue { sigil: ":", name, span }`, in place of today's `MxAtom`. `::name` stays an `INVALID_EXPRESSION` reservation. `Parser.read()` keeps its same-length numeric stand-in, and the stand-in's kind is recovered from the source character at the span start, as `isStandIn` does today for `:`. Nothing else in the grammar moves: `:name` between attributes stays the 146 sugar, `:=` stays a bound value, `:` in a tag name stays a name. This is one lexer rule in the port's `EXPRESSION.ts` instead of an atom-specific one, and it is the only grammar change this note asks for.

**Node.** Core's `convertAtoms` becomes `convertSigilValues`: it finds each stand-in, looks up the active claim for its sigil on the current target, and either rewrites per the claim (`lower: "string-literal"` produces a `StringLiteral` with `extra.mxSigil = { sigil, span }`, which is today's `extra.mxAtom` under a general name) or raises `mx/unclaimed-sigil` at the span. `Expr.atoms` becomes `Expr.values: SigilValue[]` with `kind` from the claim; `Atom` in the IR gains `kind` as the claim's name and stays otherwise as it is.

**Contract.** The `:` claim: `{ kind: "atom", type: "literal", lower: "string-literal", contract: ["values", "pattern", "ref"] }`. An attribute `type: "atom"` resolves against that claim, so `values`, `pattern` and `ref` keep their present semantics and `atom-contracts.ts` is unchanged except for reading the kind name from the claim.

**TypeScript type.** `type: "literal"` is what `atomSplices` already does: `x=:foo` types as `"foo"`. A claim with `type: { from, export }` would splice a declared type instead; atoms do not need it.

**Lowering on the data target.** `DataAttr` already has `kind: "atom"` with `name`, `value`, `nameSpan` and `span`; it becomes the general `kind: "value", valueKind: "atom"` or keeps its name with `valueKind` added. Either is a one-line decision for the lead.

**Tree-sitter.** `grammar.js` replaces the `atom` external with `sigil_value` carrying a `sigil` field; `highlights.scm` captures `(sigil_value sigil: ":") @string.special.symbol`, so highlighting is unchanged for atoms and a future sigil highlights the day the grammar ships it, with no per-project knowledge.

**Diagnostics.** `mx/unclaimed-sigil` ("`:draft` has no meaning on html; `@mxlang/data` claims `:` as an atom"), `mx/atom-not-allowed` (today's atom-vs-string check), `mx/atom-value`, `mx/atom-pattern`, `mx/atom-unresolved-ref`, each with `origin` set to the claiming extension and `end` set from the span.

**Where it lives.** ADR 156 makes an atom a string literal on every target. That stays. Core ships the `:` claim as a built-in extension, next to `try` in `BUILTIN_CUSTOM_TAGS`, so every target has atoms and the claim exists as a manifest a third party can read as the reference. The data target's contract fields are what it adds, not the claim. This is one of the places the sketch is wrong (section 8): assigning the `:` claim to the data target would make `:name` an error on html, contradicting 156, and would make Mesh's contracts the owner of a grammar fact.

**The Marko answer.** Offer Marko two things and no more: the `:name` sugar (146), which they are likely to take, and the generic rule "in expression position, `<sigil><ident>` for a reserved sigil set is one token with no meaning; the compiler reports it as reserved unless a translator claims it". The rule has no semantics, no runtime, and one lexer hunk, which is the smallest thing that keeps MX's atoms a strict layer on top of a shared parser. If Marko declines the rule, MX keeps its own lexer hunk, which is what it has today, and the offer cost nothing. What MX does not offer is atoms, `::`, or the claim mechanism: those are MX's language, not the shared parser's.

## 6. Worked example: a `validate` tag with a typed expression and a spanned transform

Mesh's `post.mx` fixture has `<validate>` children under `<create>` and `<update>`, each carrying an expression and lowering to a validation record. The extension declares the contract, a transform, and gets the data tree, the editor and the diagnostics without any of them running the transform.

```ts
export default {
  extensionVersion: 0,
  name: "@mesh/actions",
  requires: ["@mxlang/data"],
  tags: {
    validate: {
      parents: ["create", "update"],
      attributes: {
        attribute: { type: "atom", ref: "attribute", required: true },
        message: { type: "string" },
      },
      children: { "#text": {} },
      transform(call, ctx) {
        return [
          ctx.build.delegatedTag("validation", [], {}, call.attrs, { from: call }),
        ];
      },
    },
    hooks: {
      parents: ["create", "update"],
      attributeTags: {
        "*": { pattern: "^on_(?<event>[a-z]+)$", attributes: { run: { type: "function", required: true } } },
      },
    },
  },
} satisfies Extension;
```

```mx
<create name=:create>
  <validate attribute=:title message="title is required"/>
  <hooks>
    <@on_commit run=(post) => audit(post)/>
  </hooks>
</create>
```

What each layer sees:

- **Static read.** The editor reads the literal, skips `transform`, and has the full contract: parents, the `attribute` atom with `ref: "attribute"`, the pattern-named attribute tags. It never loads the module.
- **Contract check.** `:title` must name an `attribute` declaration in the file (decision 156 `ref`); a typo is `mx/atom-unresolved-ref` at the atom's span with the candidates listed. `<@on_delete>` matches the pattern and `run` is required; `<@after>` is `mx/attribute-tag-not-allowed` listing the pattern. Today the second check is impossible because `attributeTags` has no `"*"`.
- **TypeScript.** `attribute=:title` types as `"title"`; `run`'s arrow is checked by the TS plugin through the projection, which is the expression need Mesh ranked first and which this design does not touch.
- **Transform.** `delegatedTag` gets `from: call`, so the `validation` node carries `nameSpan` and `span` from `<validate>` and `origin: { extension: "@mesh/actions", tag: "validate", at }`. `parseData` builds it instead of reporting a broken invariant, the data tree shows `tag: "validation"` with `origin`, and a Mesh verifier that rejects the record can point at `<validate>` because the span is there.
- **Diagnostics.** Every error above has a `code`, an `origin` and a range. An agent fixing the file gets `post.mx:12:13-12:19 mx/atom-unresolved-ref [@mesh/actions] :titel does not name an attribute in this file; did you mean :title`, and nothing else.

## 7. Gaps and costs

Ordered by what Mesh needs first. Size is S (a day), M (a week), L (more). "Port" says whether it must land inside the parser port, and "reversible" whether the change can be undone without a language change.

| # | Gap | Size | Port | Reversible | Unblocks |
|---|---|---|---|---|---|
| 1 | Span-required builders: `from` on every `ctx.build.*`; `delegatedTag` gains `nameSpan`/`span`; `finalize` takes the registration span | M | No | Yes (additive signature; old callers fail to type-check, which is the point) | `data-transform-output-tree`; Mesh transforms |
| 2 | `origin` on synthesized IR nodes; exposed in the data tree; diagnostics carry it | S | No | Yes | Visible expansion; diagnostics that name the extension |
| 3 | `TranslateError.code`, `origin`, `end`; language server emits codes and full ranges from `spans` | M | No | Yes | Agent-grade diagnostics; everything Mesh reports |
| 4 | Partial tree from `parseData` on contract errors (not parse errors) | M | No | Yes | Editor and verifier see the tree with one bad attribute |
| 5 | `attributeTags["*"]` with `pattern`, mirroring `children["*"]` (147) | S | No | Yes | Mesh hooks and pattern-named `@` tags |
| 6 | Generalized static manifest reader (extend `readParseOptions` to a whole literal with function members skipped) | M | No | Yes | Tooling reads contracts without `require`; `mx.contracts` modules become readable |
| 7 | `mx.extensions` resolution in `host-policy.ts`, conflict rules, `requires`, `extends` merge | M | No | Yes, while `extensionVersion` is 0 | The scoping and composition model; retiring replace-and-warn |
| 8 | Generic sigil-value lexing and `MxSigilValue` in the port's front end; `MxShorthand.sigil` opened to the reserved set; `convertSigilValues` in core | S in the port, L after the freeze | **Yes**: it is a lexer rule and a front-end node, and the port is where the lexer is being rewritten | No: it is grammar | Atoms as an extension; the Marko offer; any future sigil |
| 9 | `ValueClaim` on descriptors and manifests; core's built-in `:` claim; `Atom.kind` | M | No | Yes | Section 5 |
| 10 | tree-sitter `sigil_value` node and capture | S | No, but should land with 8 | Grammar release | Highlighting that never depends on the project |
| 11 | `mx.target: "data"` editor dispatch | deferred | No | n/a | Mesh in the editor; operator-deferred and not asked for here |

Placement. Gap 8 is the only item the parser port's timing governs: the front-end rule seam is the right place and the language freeze is the wrong time, so it belongs in PR 2b or PR 3 of the port, whichever is still open when the operator rules. Gaps 1 through 5 are independent of the port and are Mesh's critical path; they can start now. Gaps 6, 7 and 9 are the extension mechanism proper and depend on nothing in the port. Gap 10 ships with 8.

Cost of not doing it. Without 8, atoms stay a bespoke lexer hunk and every future sigil repeats the six-place change; the Marko offer is then "take our atom lexer" rather than "take one reserved-token rule". Without 1 and 2, every DSL on the data target is contract-only, which is what Mesh has today and what its plan lists fallbacks for. Without 6, editors keep executing user modules to learn a child list.

## 8. Where the sketch is wrong

The kickoff sketch is right about the shape: Spark-shaped, manifest first, three narrow slots, spans by construction, visible expansion, conflicts as errors, no `.mx` extensions. These are the places it is wrong or too loose.

1. **"Values: sigil-prefixed attribute values."** Atoms are lexed in every expression position (`expression.atoms` is enabled for attribute values, tag arguments, placeholders and method bodies alike), not only attribute values. The reader slot is "sigil values in expression position"; narrowing it to attributes would break `${:draft}` and `<tag(:a)>`.
2. **"The `:` sigil is registered by whoever owns its meaning, the data target."** ADR 156 makes atoms a value on every target. If the data target owns the claim, `:draft` is an error on html, which reverses 156, and Mesh's contracts end up owning a grammar fact. Core ships the `:` claim as a built-in extension; the data target adds contract fields. Section 5.
3. **"Lexically scoped: a host config or `mx.contracts` import visible in the file."** An import visible in the file is new syntax in `.mx`, which the same sketch forbids, and it is the Rust proc-macro mistake in reverse: nobody needs per-file macro imports, and per-file scope makes "which extensions are active" depend on reading the file. Scope is the nearest `package.json`, the way the target already is.
4. **"Reader slot: a closed set of sigils an extension registers."** An extension does not register a sigil; core reserves the set and an extension claims a meaning for one member on one target. The difference is who can make tree-sitter wrong, and the answer has to be nobody.
5. **"The TS plugin types `x=:foo` as `"foo"`" listed as a requirement.** It is shipped (`atomSplices`, `packages/core/src/core.ts:748`). What is missing is the general rule that a claim decides the type, not the atom special case.
6. **Expression typing listed among what an extension provides.** Mesh's first-ranked need is TypeScript's view of expressions inside data files. That is the data-target tooling dispatch the operator deferred, not an extension slot, and no manifest field delivers it.
7. **"`.mx` files never define extensions."** Correct, and too coarse: a `tags/x.mx` file does define a tag today, and should keep doing so. The precise rule is that a `.mx` file defines vocabulary and never grammar, meaning, or scope (section 4.8).
8. **Conflicts "positioned errors, never last-import-wins" stated for extensions only.** Today a local template silently wins over an `mx.contracts` entry with a warning. The rule has to reach that case too, or a dialect is only as strong as the user's `tags/` directory.

## 9. Open questions

### Needs the operator

1. **Is the sigil set closed by decision, and what is in it?** Recommended: close it now at `:` claimed and `::` reserved, and record in the spec that adding a sigil is a language change with a grammar release. Every other sigil-shaped character (`#`, `.`, `@`, `$`, `/`, `...`) already has a fixed grammatical meaning and is not a value sigil.
2. **Does the Marko offer include the generic reserved-sigil rule, or only `:name`?** Recommended: offer both, as section 5 states them, with the rule framed as a reservation and not a feature. The cost to MX if Marko takes only the sugar is zero.
3. **Does core ship the `:` claim, or does the data target?** Recommended: core, as a built-in extension, keeping 156. The alternative reopens 156.
4. **Is gap 8 in scope for the parser port, or does it wait for the freeze to lift?** Recommended: in scope for PR 2b or 3; it is S there and L afterwards, and the front-end rule seam already exists.
5. **Should a local `tags/x.mx` shadowing an extension's tag become an error?** Recommended: yes, for tags that come from an active extension; the warning stays for `mx.contracts` until that key is folded into `mx.extensions`.

### The lead can rule

6. The manifest key name (`mx.extension` in the extension's package, `mx.extensions` in the consumer's) and whether `mx.contracts` is deprecated in favour of an extension with only `tags`.
7. Whether `origin` goes on every IR node (absent on authored ones) or only on the kinds hooks can build.
8. The `DataAttr` shape for sigil values (`kind: "atom"` kept with a `valueKind`, or a general `kind: "value"`).
9. The order of gaps 1 through 5, and whether 1 and 2 are one PR.
10. Whether `extends` is in the first cut or follows once two real extensions exist.

## Rejected alternatives

- **A grammar slot: extensions contribute lexer rules or tree-sitter grammar fragments.** Rejected: tooling cannot follow it, the Marko offer becomes impossible, and the parser port's byte-comparable template layer would have to admit per-project rules.
- **A visitor API over the Marko or IR tree.** Rejected: it is the Babel plugin model, and two visitors on one node are an order, not an error.
- **`defmacro`-shaped macros in `.mx`.** Rejected by the operator's principle before this note; recorded so it stays rejected.
- **Per-file `#lang`-style declaration.** Rejected: `.mx` never names its dialect; the package does.
- **A process-wide `registerExtension()`.** Rejected: the Lisp readtable problem; the active set must be a function of the package.
- **Manifest as a separate JSON file.** Considered: strictly easier to read statically, but it splits contracts from the hooks that use them and loses `satisfies Extension`. The static-literal discipline already proven by `readParseOptions` gets the same property in one file.

## Consequences

- Core gains one grammar rule (sigil values), two IR fields (`Atom.kind`, `origin`), three error fields (`code`, `origin`, `end`), a static manifest reader, a built-in `:` claim, and `attributeTags["*"]`. It still names no target and no host.
- `@mxlang/data` accepts transform output and exposes `origin`.
- The language server emits codes and ranges; `atomCandidates` gains a consumer.
- `mx.contracts` becomes the degenerate case of an extension, with replace-and-warn retired.
- The specification gains a "Language extensions" section stating the three slots, the closed sigil set, the scope rule and the conflict rule, citing decision 182.
- Nothing in this note changes what a `.mx` file looks like.

## Follow-ups

- A decision entry for 182 naming the spec section it updates once the operator rules.
- Gaps 1 through 5 as separate PRs on `main`, independent of the port.
- Gap 8 as a change inside the open parser-port PR, with `ast.md` updated for `MxSigilValue`.
- Correct the two docs lines that say `parseData` throws on transform output (`specification.md`, `dialect-package.md`), which the code no longer does.
- A Mesh extension manifest written against the `Extension` type as the first external consumer, before gap 7 ships, to test the shape on real contracts.
