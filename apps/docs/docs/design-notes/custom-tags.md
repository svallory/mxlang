---
title: "Custom tags build spec"
description: "The approved design for MX 1.x custom tags: the CustomTag and TagCall contracts, discovery, template units, analyze/finalize hooks, and return values."
---

# Build spec: Custom Tags (MX 1.x)

Status: **approved to build** (Saulo, 2026-09-15). Base: `main` @ `a87fa1d7`.
Rationale and evidence live in `notes/investigations/custom-tags-check-results.md`
(referenced below as *report §x*). This file is the decided design only — no
history, no rejected options.

---

## 1. Scope

**In (MX 1.x):**

- **L1** — a custom tag authored as a template: `tags/icon.mx`, inlined to IR.
- **L2** — a sidecar `icon.tag.ts` with hooks over MX's IR.

**Out, explicitly:**

| Out | Why | Report |
|---|---|---|
| **L3** raw hooks (`raw.parse`, `raw.transform`, `statement`/`rawOpenTag`/`controlFlow`) | Deferred. **L3 is the trigger for forking the parser**: Marko's runtime node names would leak into user code, so the fork registers `Mx*` node types *before* L3 ships | §II.8 |
| `migrate` | Needs a source-printing output mode MX does not have | §II.7.7 #2 |
| `types` (call-site typing) | Slot reserved in the contract, unbuilt | §II.7.2, Q6 |
| `description` / `autocomplete` / `deprecated` | No consumer: the LS advertises only `textDocumentSync` | §II.7.1 |
| Package-dependency tag discovery (`node_modules` walk) | Later; needs a resolution story | §II.5.8 |
| Per-directory `mx.json` | `package.json#mx.tags` covers the cases; purely additive later | §II.8.8 |
| Per-host `emit` override | Inverts decision 80's arithmetic; `ctx.build.hostTag` covers the real case | §II.7.3 |
| Marko taglib files (`marko.json`, `marko-tag.json`, `tagDiscoveryDirs`) | MX owns everything after parse | §II.5.9 |

**Constraints that bound every decision here:**

- **Decision 79** — hosts stay dumb emitters over the core IR. A custom tag adds
  no IR kind and no emitter branch.
- **Decision 80** — one definition works on every host: `H + M`, never `H × M`.
  A tag can never see which host it is compiling for.
- **Subset rule** — no new syntax in MX 1. A custom tag call is syntactically an
  ordinary tag call; nothing in the parser, grammar, Prettier or tree-sitter
  changes.

---

## 2. The public contract

Final names. `x.tag.ts` default-exports a `CustomTag`.

```ts
/**
 * A custom tag's sidecar: `tags/icon.tag.ts` beside `tags/icon.mx`.
 *
 * Every field is optional except `transform`, and a tag with only a template
 * (L1) needs no sidecar at all. A sidecar adds declarations, compile-time
 * checks, or output a template cannot express.
 */
export interface CustomTag {
  /**
   * Parse-time behaviour. **Static data, never a function**: the scan must know
   * these before the *calling* file is parsed, so they cannot depend on
   * anything computed later (report §II.5.8).
   */
  parseOptions?: {
    /** Body arrives as one unparsed `Text` node. `<markdown>`, `<graphql>`. */
    text?: boolean;
    /** Keep body whitespace. `<pre>`-like tags. */
    preserveWhitespace?: boolean;
    /** No body; `<icon/>` only. */
    openTagOnly?: boolean;
  };

  /**
   * Declared attribute contract, checked by the core **before** `transform`
   * runs. A missing required attribute or a bad `enum` value is a compile error
   * positioned on the attribute, with no validation code in the sidecar.
   */
  attributes?: Record<string, {
    type?: "string" | "number" | "boolean" | "expression";
    required?: boolean;
    enum?: string[];
    default?: unknown;
    /** Rejects `name=expr` when the tag needs a compile-time literal. */
    literalOnly?: boolean;
  }>;

  /** Declared `<@x>` attribute tags and whether each may repeat. */
  attributeTags?: Record<string, { repeatable?: boolean; required?: boolean }>;

  /**
   * Phase 5. Non-mutating pass over every call of this tag in one file, before
   * any `transform` runs. Returns nothing; writes to `ctx.store`, which
   * `transform` and `finalize` read. Use when a call's output depends on the
   * *set* of calls (a sprite sheet, a table of contents).
   */
  analyze?(calls: readonly TagCall[], ctx: AnalyzeContext): void;

  /** The main hook: one call in, IR out. Required unless the tag is L1-only. */
  transform?(call: TagCall, ctx: TransformContext): IrNode[];

  /**
   * Phase 5. Runs once per file after every expansion. May **prepend** nodes to
   * the program; may not mutate other tags' output.
   */
  finalize?(ctx: FinalizeContext): IrNode[];
}

/** One call site, every part already resolved to IR. Carries no Marko node. */
export interface TagCall {
  /** The tag name as written, for diagnostics. */
  name: string;
  /** The call site; the default position for every synthetic node. */
  loc: Position;
  /** Resolved attributes, in source order. */
  attrs: Attr[];
  /** Ordinary children; `null` when the call has no body. */
  content: Block | null;
  /** `<@name>` children; repeated names stay repeated entries. */
  attributeTags: AttributeTag[];
  /** Tag params (`<table-of|row|>` gives `["row"]`), as source text. */
  params: string[];
  /** The `/var` binding as source text, when the call declares one. */
  var: string | null;
}

`/var` on a custom tag call binds the value the tag's template hands back with
`<return>` (§3). A tag with **no template** — a sidecar that builds IR — has no
`<return>` to bind, so `/var` on one is a positioned compile error; a built-in
that itself consumes `/var` is exempt.

export interface TransformContext {
  /** Builders; every node they make carries the call site's `loc`. */
  build: IrBuilders;
  /** A name no template can see: `$mx_<tag>_<n>`. */
  gensym(hint?: string): string;
  /** **Write `throw ctx.fail(...)`** — see error semantics below. */
  fail(message: string, at?: Position): never;
  /** Lifts a statement to the head of the enclosing function. */
  hoist(code: string): void;
  /** Phase 5: per-file store shared with `analyze` and `finalize`. */
  store: TagStore;
}

export interface AnalyzeContext { store: TagStore; fail(m: string, at?: Position): never }
export interface FinalizeContext { store: TagStore; build: IrBuilders; gensym(hint?: string): string }

interface TagStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}
```

`IrBuilders` is the experiment's set, unchanged: `text`, `interpolation`,
`element`, `attr`, `dynamicAttr`, `booleanAttr`, `expr`, `ifChain`, `forLoop`,
`block`, and **`hostTag(name, children, attributeTags)`** — the only route to a
host primitive. The core calls the host's own `resolveHostTag`, so a host that
does not claim the name fails in its own words (report §II.2.4). Module-level IR
kinds (`Import`, `Static`, `Export`, `InputInterface`) are deliberately absent.

### Ordering and determinism

1. Per file: **all `analyze` hooks** (every tag, every call) → **all
   `transform`** in source order → **all `finalize`**.
2. `finalize` hooks run **sorted by tag name**. Output is prepended to the
   program in that order. A `finalize` may not mutate other tags' output — with
   mutation, ordering becomes semantically load-bearing and reintroduces the
   coupling decision 80 forbids.
3. Expansion is depth-first; nested custom tags expand inside-out.
4. Limits: `MAX_EXPANSION_DEPTH = 64`, `MAX_EXPANSION_NODES = 100_000`.

### Error semantics

- **`throw ctx.fail(msg, at?)`.** The `throw` is required: TypeScript narrows on
  a `never`-returning call only when the callee is a const reference, and `ctx`
  is a parameter. Docs must say this; it is the first thing every author hits.
- A `TranslateError` from a hook passes through untouched (it already carries a
  position). **Anything else is wrapped** as
  `` `<tag>`: custom tag threw: <message> `` at the call site, so a tag's bug is
  distinguishable from a core bug and the LS reports it unchanged.
- A hook returning a non-array fails with a positioned error.

### Positions — three rules

1. **Author-written material keeps its real `loc`**, free: attrs, body and
   attribute tags arrive resolved by the same code a component call uses.
2. **Synthetic material takes the call site.** Every `ctx.build.*` node is
   stamped, which is why builders exist instead of object literals.
3. **L1 material keeps its own file's positions** (§3 below) — a diagnostic in
   `tags/icon.mx` points there, not at the call site.

---

## 3. L1 semantics — a template is a compilation unit

`tags/icon.mx` is a complete custom tag. No sidecar, no config.

*Rewritten for the tag-unit model (decision 95, note
`notes/investigations/tag-unit-design.md`). The previous revision described
lowering a template by **inlining** it into the caller and substituting
`input`. That engine is deleted: a template is now a module, and the caller
emits an import plus a call.*

- **A module, not an inlining.** A tag's template compiles through the *same
  per-file pipeline a page uses*, into a module whose default export is the tag
  in MX's calling convention. There is no second compiler mode. The caller
  emits an ordinary component call against an injected import, which is exactly
  what an explicit `import Icon from "./tags/icon.mx"` already produced — so no
  host emitter learns anything new.
- **`input` is a real parameter, bound by the call.** Attributes become the
  `input` object the tag's own module receives. The substitution strategy and
  every limit it carried are gone with it:
  - **N reads are N reads.** A template may read an attribute as often as it
    likes; the caller's expression is evaluated once, at the call.
  - **A spread attribute is ordinary.** Its keys need not be known at compile
    time, because nothing resolves reads at compile time any more.
  - **`input` may be used as a value** — bare `input`, `typeof input`,
    destructuring — since it is a parameter rather than a name to be erased.
  - **`content` remains reserved** as an attribute name: it names the body slot,
    passed as a closure built at the call site.
- **Body content** is passed as `content`, a closure built **at the call site**
  (so a body inside a `<for>` captures that row, not the last one), and the tag
  places it by writing `<${input.content}/>`. **Attribute tags** arrive as props
  of the same shape, repeats preserved. How often the body renders is the tag's
  choice: zero times if it never writes the placeholder, N times if it writes it
  N times.
- **A body passed to a tag that never reads `input.content` warns** at the call
  site, naming the template. The caller can no longer observe this directly — it
  does not expand the template — so it comes from the tag's own compilation, as
  cached metadata (below). Marko is silent here; MX is not.
- **A tag that forbids content** declares `parseOptions.openTagOnly`. A call
  that passes a body is a positioned MX error at the call site: ``​`<x>` does not
  accept content``.
- **`<@content>` as an attribute tag is rejected**, since it would collide
  silently with the body slot.
- **Hygiene is the module boundary.** A template's declarations are its own
  because it is a different module — there is no renaming pass, no caller-side
  import merge, and no way for a template binding to reach the caller's scope.
  Its `export interface Input` is now the tag's **public type**, consumed by the
  caller through the import, rather than something discarded to avoid a
  collision.
- **`import` and `static` stay in the tag's module** and run **once per
  process**, at import time, as the module system defines — Marko's own model.
  This is an observable change from the inlined model, where a `static` block
  ran once per *calling module*.
- **A tag file may export anything.** Once it is a module, its exports are a
  public surface (ruling 6).
- **A compiled unit's default export is a named declaration**, named after the
  file: `icon.mx` emits `export default function Icon(…)`, `table-of.mx`
  emits `TableOf`. The name is derived, never authored, and is re-minted if it
  would collide with a binding the file already has. Every host that emits a
  module does this (html, the shared preact/react/hono emitter,
  `compileSolidUnit`, and astro `.mx` through the html emitter).
- **A tag file may call other custom tags**, including itself: a tag calling
  its own name resolves to that named declaration in its own module scope, so
  **self-recursion needs no import** (design invariant §7.5-7) and terminates
  on the tag's own data rather than on a compiler depth cap. A module
  importing itself would also be legal ESM, but it is a module importing a
  binding it already has. The expansion depth cap, the node
  cap and the cycle detector are deleted along with the engine that needed them.
  **A mutual or self cycle between templates is therefore legal**, not an error
  naming the path: it is an ordinary module cycle, and a unit whose compile is
  in flight is cached as `pending` so the metadata lookup terminates.
- **Metadata cache.** Compiling a tag unit produces
  `{ readsContent, attributeTags }`, plus `returnsValue` and the `<return>`
  value's source text when the unit declares one, cached by
  **path + mtime + source text**, bounded at 256 entries.
  This is what the caller consumes for the warnings above — Marko's own
  `loadFileForTag` shape.
- **Typing.** The tag's `export interface Input` types the call site through the
  ordinary import. Where a tag reads `input.content`, the host augments its own
  render signature (HTML: `input: Input & { content?: () => string }`) so a
  caller passing a body typechecks; where it does not, `Input` is untouched.
- **`<return>` and `/var`.** A template may hand one value back to its caller.
  `<return value=EXPR/>` is **value only** (no `valueChange`, no two-way
  channel), at most one per template, and at the template's **top level** only —
  never inside a native tag, `<if>`/`<else>`, `<for>`, an attribute tag or a
  `<define>`. It takes a required `value=` and nothing else: no args, params,
  body, spread, `/var`, or other attribute. Every violation is a positioned
  error, and all of them are decided in the **tag's own compilation**, which is
  what makes the unit's signature one shape rather than `T | undefined` per
  path — a unit cannot see its callers, so no call site can widen it.
  `<return>` in a page is legal and means the same thing.

  A returning unit's export shape is the host's business: `{ value, output }` on
  html and the JSX hosts; on Solid a generated callback prop the unit
  calls during setup, because a Solid component's return value is its view. The
  Solid binding is **one-shot, not reactive** — it holds the value from that one
  invocation, which matches `/var` everywhere else; a tag wanting reactivity
  returns an accessor. Astro renders an MX component through its own renderer,
  which unwraps the pair there.

  **`/var` is top-level-only on the JSX hosts and Solid.** Those targets lower
  `<if>` and `<for>` to expressions (a ternary, a `.map` callback, a `<For>`
  render prop), so a callback scope has no statement position for the binding —
  hoisting the call out of it reads bindings that do not exist there and runs
  once for a body rendered N times. Invariant §7.5-8 applies: the escape is a
  positioned error, never emitted. The call itself, without `/var`, works
  everywhere. html and Astro `.mx` support the nested case; `/var` in a `.amx`
  template is refused outright, since it has no statement position at all.
  Lifting the restriction means a declaration per callback scope — MX 2.

  **A returning unit on a JSX host may not import hooks**, because it is
  invoked as a plain function rather than mounted: the hook dispatcher would
  bind its hooks to the calling component's list. A `use*` import from
  `preact/hooks`, `preact/compat`, `react` or `hono/jsx` in a unit declaring
  `<return>` is a compile error. Solid is unaffected.

  At the call site, `/var` lowers to the statement sequence of design invariant
  §7.5-4 — attribute-tag statements, the call, then the binding — and a call
  *without* `/var` on a returning tag still emits the output only. Three
  positioned diagnostics: `/var` on a tag whose template has no `<return>`; a
  read outside the declaring block (MX rejects the escape rather than emitting
  Marko's hoisted getter, which would change the binding's type); and a read
  before the declaring call in the same block.
- **Positions.** A diagnostic inside a template is reported against the
  template's own file, at its own position — now simply because the pipeline is
  compiling that file. The `Position.file` / `Expr.file` / `TranslateError.file`
  channel stays, because a sidecar `transform` may still return IR built
  elsewhere.

---

## 4. Discovery

**MX owns the scan.** No Marko taglib files, no `tagDiscoveryDirs`.

- **Walk.** From the calling file's directory upward to the package root,
  collecting `tags/` directories. Nearest wins.
- **Index without execution.** A tag's *existence*, its name (the filename), and
  its `parseOptions` must be known before the caller parses. The scan therefore
  indexes by filename and reads `parseOptions` from the sidecar **without
  executing** the rest of it. The sidecar's hooks load lazily, on first use.
- **`package.json#mx.tags`** — a string, or an array of
  `{ dir, prefix?, hosts?, parseOptions? }`. Entries extend the walk and supply
  directory-level defaults a sidecar may override.
- **Precedence:** explicit import > local `tags/` (nearest dir wins) >
  `mx.tags` entries, in array order.
- **One injected import per module per tag**, keyed by the template's resolved
  path and named with a gensym'd PascalCase local (`$mx_Icon1`) minted against
  the caller's own bindings — a discovered tag may be named `icon`, which is not
  a legal component binding. If the caller already imports that same resolved
  path under its own binding, that binding is reused and nothing is injected.
- **Composition (L1 + L2 on the same tag).** If both `x.mx` and `x.tag.ts`
  exist, **the sidecar wins and the template is its raw material**: `transform`
  receives the `TagCall` and may return IR of its own (a macro the author
  wrote — the only expansion left in the language), or return a `TagCall`
  (rewritten or not) to route the call to the adjacent template unit;
  `ctx.build.template(call)` does the same. A sidecar with no `transform` but
  with `attributes`/`parseOptions` is a *declaration-only* sidecar: the call
  routes to the template, now validated.
- **`parseOptions` reach the parser** through MX's injected taglib entry, the
  mechanism already used for `mx-translator-core` (`taglibs: [[id, def]]`);
  verified in report §II.5.9 A that injected `parseOptions` are honored.

**Integrations that must run the scan and pass its result to every lower:**
Bun loaders, Vite plugin, Astro, TS plugin, language server, `mx-tsc`.

- **Caching / invalidation:** keyed on the scanned directory set; invalidate on
  any add/remove in a `tags/` dir, on a tag-file mtime change, and on
  `package.json#mx.tags` changes. The LS needs an mtime cache and must report a
  sidecar that fails to load as a diagnostic rather than crashing.
- **TS-plugin double resolve:** `createHtmlMappings` lowers the source a *second*
  time and **must be given the same tag map**. Without it the file gets *no*
  mappings at all (report §II.2.9).

---

## 5. Phase plan

One PR per phase. Days are one engineer.

| # | Ref | Days | Touches | Parallel? |
|---|---|---|---|---|
| **P1** | `custom-tags-core` | 6 | `packages/core/src/{custom-tags,lower,compile,core,index}.ts`, `packages/hosts/*/src/index.ts`, `packages/tooling/typescript-plugin/src/mx-language.ts` | first, blocks all |
| **P2** | `custom-tags-scan` | 6 | `packages/tooling/{vite-plugin,tsc,typescript-plugin,language-server}`, `packages/hosts/astro`, bun loaders | after P1 |
| **P3** | `custom-tags-templates` | 7 | `packages/core/src/lower.ts`, new `template-tag.ts`, TS plugin mappings | after P1; ‖ P2 |
| **P4** | `try-as-custom-tag` | 2 | `packages/hosts/*/src/*` (deletions), `packages/oracle` | after P1; ‖ P2, P3 |
| **P5** | `custom-tags-analyze-finalize` | 5 | `packages/core/src/custom-tags.ts`, oracle fixtures | after P1 |
| **P6** | `custom-tags-docs` | 2.5 | `site/` | after P3, P5 |

**P1 — `custom-tags-core`.** Port the experiment hook renamed (`expand` →
`transform`, `CustomTagCall` → `TagCall`, `CustomTagContext` →
`TransformContext`, `CustomTagDefinition` → `CustomTag`); add `attributes` and
`attributeTags` checking with positioned diagnostics; thread `parseOptions`;
**rename `resolve.ts` → `lower.ts`** (and `resolve()` → `lower()`), keeping the
`resolve` name free for MX 2; host passthroughs; TS-plugin double-resolve fix;
expose `customTags` as the programmatic option the scan will later feed.
*Acceptance:* all six oracles unchanged at their current numbers; no behaviour
change with no tag registered; `<icon>` fixture byte-identical on six hosts.

**P2 — `custom-tags-scan`.** The upward walk, `package.json#mx.tags`, lazy
sidecar loading, `parseOptions` injection via `taglibs`, and the scan wired into
every integration with caching/invalidation.
*Acceptance:* a `tags/icon.mx` + `icon.tag.ts` resolves with no import in every
integration; editing a tag file invalidates callers; a broken sidecar is a
diagnostic, not a crash.

**P3 — `custom-tags-templates`.** L1 inlining, the third position rule,
cross-file TS-plugin mappings, the path+mtime cache, cycle detection.
*Acceptance:* `tags/icon.mx` renders identically on six hosts; a diagnostic
inside a tag template points into that file; a cycle errors naming the cycle.

**P4 — `try-as-custom-tag`.** Replace five host `<try>` implementations with one
custom tag using `ctx.build.hostTag`.
*Acceptance:* byte-identical output on all six hosts, oracles unchanged, five
implementations deleted.

**P5 — `custom-tags-analyze-finalize`.** `analyze`, `finalize`, `ctx.store`,
name-ordered determinism, program prepend; dogfood the sprite-sheet `<icon>` and
`<table-of>`.
*Acceptance:* the sprite sheet emits one `<symbol>` per distinct icon regardless
of call count; `finalize` order is stable across runs and machines.

**P6 — docs.** Authoring a tag; L1 vs L2 and when to reach for each; contract
reference; the `throw ctx.fail` rule.

**Total ≈ 28.5 days ≈ 5.5 weeks**, with P2/P3/P4 parallelizable after P1.

---

## 6. Test plan

- **Per-host fixture harness**, from the experiment's
  `fixtures-custom-tags/run.ts`: compile each fixture through all six hosts,
  render where a renderer exists, compare parse5-normalized with
  `attributeOrder: "ignore"`. Promote to `packages/core/src/fixtures/` with a
  per-host `expected.<host>.html`.
- **Count gates** (decision 55): assert the number of fixtures run, so a fixture
  silently not running is a failure.
- **Oracle invariance:** all six oracles at their current numbers in every phase.
  P4 additionally asserts byte-identical `<try>` output before and after.
- **Negative tests:** unknown attribute; missing required attribute; `enum`
  violation; `literalOnly` violation on a dynamic value; a `transform` that
  throws (wrapped, positioned, tag named); a `hostTag` name the host does not
  claim; recursion past the depth cap; a tag-file cycle; **a warning when an
  expansion never reads `attributeTags` it was handed** (the silent-drop class).
- **Position tests:** author material keeps real `loc`; synthetic takes the call
  site; L1 material points into the tag file.
- **TS plugin:** a file calling a custom tag still produces mappings (the
  double-resolve regression), one test per integration that lowers twice.

---

## 7. Glossary and port list

**Final names.** `CustomTag` (the module's default export) · `TagCall` (one call
site) · `TransformContext` / `AnalyzeContext` / `FinalizeContext` · `transform`
(the L2 hook) · `analyze` · `finalize` · sidecar `x.tag.ts` · template
`x.mx` in `tags/` · config `package.json#mx.tags` · `lower.ts` / `lower()`
(internal, renamed from `resolve.ts`). **`resolve` is reserved** for the MX 2
tag-resolution hook (TODO `custom-tags-resolve-hook`).

**Port from `experiment/custom-tags-check`:**

| Experiment file | Becomes | Note |
|---|---|---|
| `packages/core/src/custom-tags.ts` | same path | rename the five types/hooks |
| `packages/core/src/custom-tags.test.ts` | same path | plus `attributes` tests |
| `packages/core/src/resolve.ts` (branch + splice) | `packages/core/src/lower.ts` | file rename in P1 |
| `packages/core/src/{compile,core,index}.ts` | same | `customTags` threading |
| `packages/hosts/*/src/index.ts` (51 lines) | same | pure passthrough |
| `packages/tooling/typescript-plugin/src/mx-language.ts` | same | double-resolve fix |
| `fixtures-custom-tags/icon/*` | `packages/core/src/fixtures/custom-tags/icon/*` | promote to a gate |
| `fixtures-custom-tags/run.ts` | oracle harness | productionize |
| `fixtures-custom-tags/try/try.tag.ts` | `<try>` tag (P4) | keep `asBuiltHostTag` only |
| `fixtures-custom-tags/{try,positions}/probe.ts` | — | experiment-only, do not port |

Packages remain `@mxlang/*` on npm; `mx` is the `package.json` **config key**
(PR #70).
