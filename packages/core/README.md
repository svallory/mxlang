# `@mxlang/core`

The Marko-node consumer every MX host is built on.

MX is a template language born from Marko: Marko's syntax, brought to wherever
JSX lives today (see `notes/mx-vision.md`). MX itself defines the markup and the
**structural** tags — `<if>` / `<else if>` / `<else>`, `<for>` in all its forms,
attribute tags, tag params, `<define>`, `<const>`, `static`, `import` — and each
**host** decides what state, reactivity and output mean. This package is the
half that is the same for every host: it consumes Marko's AST through
`@marko/compiler`, lowers the structural forms into an IR, and asks
`HostDeclarations` for everything host-specific.

It depends on `@marko/compiler` and nothing else.

## Core versus host

| Belongs to the core | Belongs to a host |
| --- | --- |
| The structural tag lowerings (`<if>`, `<for>`, `<define>`, `<const>`, statement tags) | The disposition table: which tags are inert, which are errors, why |
| The field guard (`rejectUnsupportedFields`) and the inert-shape guard | Component-versus-element resolution, and what a component call emits |
| The IR and its `drive`/`emit` traversal | An `Emitter` for the target's output shape, attributes and component calls |
| The two front doors (`compileSource`, `parseFragment`) | Stateful tags (`<let>`, `<effect>`, `:=`), through the three hooks |
| Custom-tag declarations, validation, and IR transforms | Discovery and sidecar loading in the calling integration |
| `escape` | Its own integration: a Vite plugin, a Bun loader, a TypeScript plugin |

`@mxlang/html` is the first host (vanilla HTML strings); `@mxlang/astro`
(`.amx`, expression-shaped Astro syntax) and `@mxlang/solid` (SolidMX's
`.solid.mx` bridge, Solid JSX text) are the other two.

## The HostDeclarations contract

A host passes one `HostDeclarations` object. `Policy` remains a compatibility
alias of that type only. Every member is a lower-time question:

| Member | What it decides |
| --- | --- |
| `tags` | Per-tag-name dispositions: `inert` (accepted, no output, in a declared shape) or `error` (this target cannot express it). Decision 65: never "my code cannot". |
| `isElement(name, ctx)` | Whether an unbound lowercase tag name is a real element. |
| `isComponent(name, ctx)` | Whether a tag name resolves to a component in this host. |
| `claimsTag?(name, ctx)` | Whether the host owns a tag the structural core does not. |
| `resolveHostTag?(name, node, ctx)` | Records the host's decision in `HostTag.data` while the Marko node is available. |
| `rejectModifier?`, `rejectAttributeMethod?` | Replace generic attribute diagnostics with the host's own wording. |
| `rejectElementAttributeTags?`, `rejectComponentTag?`, `rejectUnknownTag?` | Replace generic tag-routing diagnostics with the host's own wording. |
| `checkBinding?(target, what)` | Inspects a name a construct is about to bind at *render* scope; not called for tag params, which open a nested scope. |
| `keepComments?` | Whether an HTML comment reaches the output. |

`DYNAMIC_TAG` is the sentinel name `claimsTag` receives for `<${expr}/>`;
match against the exported constant rather than retyping it.

## The three stateful-tag hooks (decision 70)

MX does not define `<let>`, `<effect>`, `<lifecycle>`, `<script>` or `:=` —
those are framework territory, and mean whatever the host says (decision 71).
The core gives a host exactly three capabilities, exercised through the
resolver tests:

**1. Tag handler — `claimsTag` + `resolveHostTag`.** The core offers every tag
it does not own to the declarations before component/element routing. A host's
`<signal/count=1/>` records its resolved form in `HostTag.data`; the emitter
consumes that data and never sees the Marko node.

**2. Hoist — `ctx.hoist(code)`.** Lifts a statement to the head of the
enclosing function: the render function, or the nearest `Define`. A
declaration written inside an `<if>` lands before the branch, so a reference
after the branch still resolves:

```
<if=input.on>
  <signal/count=7/>
</if>
<p>${count}</p>
```

emits `const count = 7;` at the function head, above `if (input.on) {`. Inside
a `<define>` it stops at that define's own function, since the statement may
read the define's params.

**3. Binding registry — `ctx.bindings.register(name, rewrite)`.** Rewrites
identifier *references* to a name the host owns. Registering `count` with
`` ref => `${ref}()` `` makes `${count + 1}` emit `count() + 1` — a host whose
state is a getter needs exactly this. Precision limits, all deliberate and all
tested:

- Reference positions only: `obj.count` and `{ count: 1 }`'s key are untouched
  (Babel's own `isReferencedIdentifier` draws the line).
- **Declarations print through `declName()`, never `expr()`**, and a declaration
  *shadows* the host's binding for the scope it binds. `<const/count=count + 1/>`
  emits `const count = count() + 1` — the initializer is evaluated before the
  binding exists, so it is still the host's; every later `${count}` is the local.
  `<for|count| of=xs>` and `<define/Row|count|>` shadow their bodies and restore
  afterwards. Without this split, a declared name that collides with a registered
  one emitted `const count() = …`: invalid JS with no diagnostic. A host adding a
  construct that declares a name must use `declName` for it.
- Shadowing is respected. An identifier is rewritten only when it is *free* in
  the expression (`path.scope.getBinding(name)` finds nothing), because a free
  name is the one that refers to the template-level binding the host registered.
  A parameter, `const`/`let`, or catch-clause binding of the same name inside the
  expression shadows it: `xs.map(count => count)` is untouched, while
  `xs.map(x => x + count)` is rewritten. Both pinned by tests.
- The walk runs only when something is registered, so a host with no stateful
  tags pays nothing.

## Which Babel the core uses

Two places need a JS parser: `importBindings()` (an `import` statement's local
binding names, which decide whether a tag is a component call) and the binding
rewrite above (walk an expression, replace references, re-parse the host's
returned source text). Both use **`@marko/compiler/internal/babel`**, required
lazily inside `markoBabel()` in `src/core.ts`, for `parse`, `parseExpression`,
`traverse` and `types`.

It is a **subpath export of `@marko/compiler`**, declared in that package's own
`exports` map — reachable by design, not a deep `node_modules` path — but the
`internal/` segment says plainly that its *contents* are the compiler's business,
not a semver-stable API. Three reasons that is the right trade here rather than a
second Babel dependency:

- **The nodes already belong to that instance.** Marko parses with its own
  bundled Babel and registers `MarkoTag` and friends on it; `traverse` from any
  *other* `@babel/traverse` refuses a visitor for those types outright, because
  it snapshots `TYPES` at module load (measured in
  `notes/research/marko-seam-spikes.md` spike 2 — registering Marko's types on a
  second instance updates the mutable registries but not the derived `is*`,
  generator or traverse tables). Asking a second Babel to walk these nodes is
  not "safer", it is broken.
- **The version is pinned exactly.** `@marko/compiler` is `5.42.5` with no
  range, here and in every consumer (AGENTS.md "Exact-pin policy"), so the
  surface cannot shift under us without a deliberate bump — and a bump is the
  moment to re-check it, which is true of the AST shapes this package consumes
  from the same instance anyway.
- **The alternative is worse.** Adding `@babel/parser` + `@babel/traverse` as
  real dependencies buys a second copy of Babel, a second version to keep in
  step, and the cross-instance problem above. `@mxlang/html` used to reach
  for `@mxlang/parser` (the *SolidMX parser* package, a vendored `@babel/parser`
  fork) for exactly one `parse` call; dropping that is what leaves this package
  with a single dependency.

If a future `@marko/compiler` removes or reshapes that subpath, the blast radius
is `markoBabel()` — one function, four named values — and the failure is a
missing export at require time, not silent wrong output.

## The two front doors

**`compileSource(source, filename, declarations, host)`** — a whole file,
through `@marko/compiler`'s `config.translator` seam (ADR 0001). `host` is
required and carries its `emitIr` function plus the
taglibs to register, the tag-discovery directories, and an optional `postEmit`
pass over the emitted module text. `createTranslator(host)` is exported
separately because the taglib lookup is keyed on the translator object, so a
caller that wants the lookup must hand the compiler the same object.

**`parseFragment(source, { filename, baseOffset, baseLine, baseColumn })`** — a
Marko *substring* of a larger file, with every position shifted to the
enclosing file. The consumer is a host whose MX lives inside another language
(SolidMX's `.solid.mx`). This is the stopgap
`notes/research/marko-seam-spikes.md` spike 1 measured, not a fix: the fix is an
additive base-position parameter upstream, which MX still intends to send.
SolidMX's own bridge (`packages/parser/src/mx/bridge.ts`) now calls this
front door for every MX region it finds — see `packages/hosts/solid/README.md`
for the bridge's own side of that hand-off. Documented limits:

- Marko's own nodes (`MarkoTag`, `MarkoAttribute`, …) carry **no** numeric
  `start`/`end` at all — only `loc.{line,column}`. Nothing to shift there.
- The Babel expression nodes nested inside them carry their offset at
  `loc.*.index`, not at `start`/`end`. Both shapes are shifted.
- Position objects are **shared** between nodes, so the walk dedupes them: a
  second shift would land at `base + base` (measured — raw index 16 with
  `baseOffset: 42` came out at 100 instead of 58).
- A thrown parse error's position lives on the exception, not in the tree; it
  is shifted separately and the same error rethrown.
- Marko never populates Babel's file-level `comments` array; `MarkoComment`
  nodes in the body shift like any other node.

## Programmatic custom tags

For the author-facing path from a zero-config template through sidecars,
discovery, and the complete API, see the docs site's
[Custom tags](../../apps/docs/docs/custom-tags/index.md) section.

Every front door and host compiler accepts a `customTags` map whose keys are
the names written at call sites and whose values implement `CustomTag`:

```ts
import type { CustomTag } from "@mxlang/core";

const icon: CustomTag = {
  attributes: {
    name: { type: "string", required: true, literalOnly: true },
  },
  transform(call, ctx) {
    const name = call.attrs.find((attr) => attr.kind !== "spread" && attr.name === "name");
    if (name?.kind !== "static") throw ctx.fail("requires a static `name`");
    return [ctx.build.element("svg", [ctx.build.attr("data-icon", name.value)])];
  },
};

compileSource(source, filename, declarations, {
  customTags: { icon },
  emitIr,
});
```

A map passed in this way is the explicit route, used by a caller that builds
tags itself. The ordinary route is discovery (see below), which fills the same
map. Either way the core remains synchronous: it injects only each
definition's `parseOptions` (`text`,
`preserveWhitespace`, `openTagOnly`) into `@marko/compiler` before parsing,
then validates declared `attributes` and `attributeTags` before `transform`.
An unknown key in an `attributes`/`attributeTags` declaration (a typo, or a
retired name such as `staticOnly`/`repeated`) is rejected at registration,
before any file is parsed, since neither key is checked against a runtime
schema anywhere else. Transforms receive resolved author material and return ordinary IR. Builder
output is stamped with the call-site position, `ctx.gensym()` is unique within
the file, and `ctx.build.hostTag()` is the only route to a host primitive.

Write failures as `throw ctx.fail(message, position?)`. TypeScript does not
reliably narrow after a bare call through the parameter property `ctx.fail`,
despite its `never` return type. Unexpected exceptions are wrapped with the tag
name and call-site position; an existing `TranslateError` passes through.

## Discovering custom tags

`getCustomTags(file)` builds that same map from the filesystem, so a tag needs
no import and no configuration:

```
my-package/
  package.json          # optionally: "mx": { "tags": [...] }
  tags/
    icon.tag.ts         # <icon>, a sidecar with hooks
    note.mx             # <note>, a template-only tag (expansion is P3)
  src/
    page.mx             # calls <icon/> and <note/> with no import
```

The walk runs from the calling file's directory up to the package root,
collecting `tags/` directories; a tag's name is its file's basename. Nearest
directory wins. `package.json#mx.tags` — a string, or entries of
`{ dir, prefix?, hosts?, parseOptions? }` — extends the walk in array order
with directory-level defaults a sidecar may override, and comes last in
precedence.

Two properties make this usable from every integration:

- **It is synchronous**, because every consumer is: Bun's `onLoad`, Volar's
  `createVirtualCode`, the language server's `diagnoseDocument` and `mx-tsc`
  all call from positions that cannot await.
- **It indexes without executing.** `parseOptions` must reach Marko before the
  *calling* file is parsed, so it is read statically out of the sidecar's
  default export. That export must be an object literal, or an identifier
  bound once at module scope to one; `parseOptions` itself must be an object
  literal of boolean-valued known keys. A spread, a computed key or a value
  imported from elsewhere cannot be read without running code and is a
  positioned diagnostic naming the sidecar. Hooks load lazily on first use.

### Writing a sidecar

Two constraints, because the two runtimes that load a sidecar do not accept
quite the same module (both measured, not inferred):

- **No top-level `await`.** Bun loads it; Node refuses with `require() cannot
  be used on an ESM graph with top-level await`.
- **Explicit extensions on relative imports** — `./helper.ts`, not
  `./helper`. Bun resolves the bare form; Node does not.

Neither costs anything real in compile-time configuration, but a sidecar that
breaks one works in a `bun` build and fails in the editor, which is the
disagreement a single loader exists to prevent. The loader restates the
constraint in its error when the runtime's own message identifies it.

Sidecars are loaded through Node's type-stripping `require`, so the packages
that load them declare `engines.node >= 22.18`; an older Node reports
`Unknown file extension ".ts"` at first tag use.

### Naming and caching

A tag's name is its filename, case included: `tags/Icon.tag.ts` is `<Icon>`,
not `<icon>`. A name must start with a letter, digit or underscore and may
then contain letters, digits, underscores, hyphens and dots; anything else —
including a dotfile such as `.DS_Store.mx`, and `tags/.mx`, whose empty name
makes `@marko/compiler` fail *every* file in the package — is skipped or
reported rather than registered. A `.solid.mx` file in a `tags/` directory is
a different file kind and is reported, not silently ignored.

Results are cached per directory and invalidated by what the scan recorded: a
directory's entry list, each tag file's mtime, and the `package.json` carrying
`mx.tags`. Invalidation is therefore only as precise as the filesystem's mtime
granularity; every platform MX targets records sub-second mtimes, but two
writes inside one tick can look like one. A broken sidecar — unparseable `parseOptions`, or a module that
throws while loading — is a `TranslateError` naming that file, which is what
lets the language server report a diagnostic rather than crash. An `mx.tags`
entry naming a directory that does not exist is softer still: it lands in
`ScanResult.diagnostics` and the scan carries on, so one typo in
`package.json` cannot break compilation of every file in the package. A
caller is expected to surface that array — the language server publishes each
as a warning naming the offending `package.json`, and the Vite and TypeScript
plugins warn once per distinct problem — because a diagnostic nothing reads is
just silence.

## The collecting pair: `analyze`, `finalize` and `ctx.store`

Most tags need only `transform`: one call in, IR out. The pair exists for the
tags whose output depends on the *set* of calls in a file rather than on any
one of them — a sprite sheet that defines each icon once however many times it
is used, a table of contents, a collected style block. `analyze` sees every
call before any of them expands, `finalize` contributes output once, and
`ctx.store` is the only channel between them.

```ts
const icon: CustomTag = {
  attributes: { name: { type: "string", required: true, literalOnly: true } },
  analyze(calls, ctx) {            // every <icon> in this file, before any expands
    ctx.store.set("used", new Set(calls.map(nameOf)));
  },
  transform(call, ctx) {           // each call: a small <use>, not a path tree
    return [ctx.build.element("svg", [], [useOf(call, ctx)])];
  },
  finalize(ctx) {                  // once per file: one <symbol> per distinct name
    return [spriteSheet(ctx, ctx.store.get<Set<string>>("used"))];
  },
};
```

**Order.** Per file: every `analyze`, then every `transform` in source order,
then every `finalize`. Both hook phases run **sorted by tag name**, and
`finalize`'s nodes are prepended to the program body in that order. A
`finalize` is handed no other tag's output and no route to the program, so
ordering can never become semantically load-bearing — the coupling decision 80
rules out, which would otherwise return through this door. The result is
reproducible: the same file compiles to the same bytes on any machine, whatever
order its calls appear in.

**Scope.** A store belongs to one tag in one file. It is created with the
file's `Ctx` and dies with it, so neither another file's compile nor another
tag in the same file can read it — which matters because a definition object is
a module-level singleton the scan hands to every file in a package. A tag
called from *inside* a tag template writes into the same file-level store as
one called at the top level: a template's `<icon>` contributes to the caller's
sprite sheet, and the template's own nested lower runs no hooks of its own.
The file-level `analyze` still sees that template-nested `<icon>` in its call
array alongside calls written directly in the file.

**What runs, and what does not.** Only a tag actually called in the file is
finalized; a package may register dozens a given file never mentions. A tag
with `analyze` but no calls is skipped rather than analyzed with an empty
array, so "this file uses no icons" leaves the store untouched. A tag that
declares **only** `finalize` is a registration error, named once before any
file is parsed: it has no call site and nothing to collect, which is almost
always a `transform` that was renamed or deleted. `analyze` without `finalize`
is fine — `transform` reads the same store.

**Failures.** `throw ctx.fail(...)` from `analyze` is positioned at that tag's
first call in the file, the earliest place an author can start reading. Any
other exception from either hook is wrapped as ``` `<tag>`: custom tag
`analyze` threw: … ```, so a tag's bug stays distinguishable from a core bug. A
`finalize` returning anything but an array is a positioned error.

**Cost.** `analyze` needs every call before any output is fixed, so a file
containing a tag that defines it is lowered twice: once over a scratch `Ctx`
that records the calls and discards its hoists, warnings and template imports,
then once for real. The scratch walk lowers each call exactly as the real walk
will, which is what lets `analyze` be handed the identical `TagCall` its own
`transform` later receives. It also expands tag templates far enough to record
their nested calls, without running any transform hook; that analyze-only IR
is never admitted to the template cache. A file whose tags define no
`analyze` is walked once, as before.

**Not detected, by choice.** A tag whose `analyze` writes a store key nothing
ever reads compiles silently. Detecting it means guessing at intent — the store
is opaque by design — and a false positive on a legitimate pattern is worse
than the omission. Read `analyze` and `finalize` as a pair.

## Template custom tags

A tag may instead be backed by a template file — `tags/icon.mx`, ordinary MX
with no sidecar — by carrying a `template` (`src/template-tag.ts`):

```ts
const icon: TemplateBackedTag = {
  template: { filename: "/tags/icon.mx", source, mtimeMs },
};
```

A tag's template is a **compilation unit**. It compiles through the same
per-file pipeline a page uses, into a module whose default export is the tag in
MX's calling convention, and the caller emits an injected `import` plus an
ordinary `Component` node — the shape an explicitly imported tag already
lowered to on every host. The template is never spliced into the caller, so a
host sees an ordinary component call and never learns which layer wrote the
markup.

**`input` is a real parameter**, bound by the call, because the tag is a
separate module with its own named `(input)` export. Attributes become that object;
an omitted one is `undefined`, so `input.size ?? 24` behaves as written. Every
restriction the old substitution strategy carried is gone with it: a template
may read an attribute as many times as it likes (the caller's expression is
evaluated once, at the call), take a spread, use `input` as a value, or
destructure it. `content` remains reserved as an attribute name, and
`<@content>` is rejected, because both name the body slot.

**The body is a call-site closure.** It arrives as `content`, built where the
call is written — so a body inside a `<for>` captures that row rather than the
last — and the tag places it by writing `<${input.content}/>`. Each `<@name>`
arrives the same way, repeats preserved. How often the body renders is the
tag's choice: never if the template omits the placeholder, N times if it
writes it N times. A body passed to a tag whose template never reads
`input.content` warns at the call site, from the unit's cached metadata rather
than from watching the expansion; a tag that must refuse a body declares
`parseOptions.openTagOnly`, and a call passing one is then a positioned error
(``​`<x>` does not accept content``).

**Hygiene is the module boundary.** A template's declarations are private
because they live in another module — there is no renaming pass, no
caller-side import or `static` merging, and no way for a template binding to
reach the caller's scope. Its `export interface Input` is the tag's **public
type**, consumed through the import, rather than something discarded to avoid
colliding with the caller's own. `import` and `static` stay in the tag's
module and run **once per process**, at import time, as the module system
defines.

**Injected imports are gensym'd and deduped by resolved path.** A discovered
tag may be named `icon`, which the casing rule never resolves as a component,
and the caller may already bind that name — so the local is always generated
(`$mx_Icon1`), minted from the file-level counter against the caller's
bindings and source text. One import per module per tag; a caller that already
imports the same resolved path keeps its own binding and nothing is injected.
That counter is shared **by reference** with a nested unit's own compile, so a
name minted while compiling a template and one minted by its caller can never
be the same serial.

**A tag may call other tags, including itself.** A module importing itself is
legal ESM, so recursion terminates on the tag's own data rather than on a
compiler depth cap — there is no expansion depth limit, no node cap and no
cycle detector, because a cycle between two template modules is an ordinary
module cycle. A unit mid-compile is recorded in the cache as `pending`, which
both breaks the recursion and tells a caller that what the unit reads is not
known yet, so a silent-drop warning is never raised off a placeholder.

**Metadata, cached.** Compiling a unit yields `{ readsContent, attributeTags }`
(with `returnsValue` reserved for `<return>`) on `Ir.tagMetadata`, cached by
path, mtime and source and bounded at 256 entries — process-wide, and a
language server is long-lived. It is what the caller consumes for the warnings
above, the same shape Marko's own `loadFileForTag` has. Calls written inside a
template belong to that template's unit and are **not** replayed into the
caller, so a caller's `analyze` sees only the calls its own file wrote.

**Positions** from a template keep that file's line and column, carried on the
optional `Position.file` and `Expr.file` and on `TranslateError.file`. Absent
means the file being compiled. A diagnostic inside a template is now simply a
diagnostic in a file the pipeline is itself compiling; the channel stays
because a sidecar `transform` may still return IR built elsewhere. Warnings go
through `ctx.warnings` (an `MxWarning[]` the caller passes in) rather than
`console.warn`, so the language server can surface them as diagnostics in the
file being edited; unset, they print as before.

**Composition.** When a tag has both a template and a `transform`, the
`transform` wins: it may return IR of its own — a macro the author wrote, the
only expansion left in the language — or return a `TagCall`, rewritten or not,
to route the call to the adjacent template unit; `ctx.build.template(call)`
does the same. A sidecar with `attributes`/`parseOptions` and no `transform`
routes the call to the template as an L1-only tag does, now validated.

## Host-policy resolution

**`resolveHostPolicy(filePath)`** (`src/host-policy.ts`) answers which host a
file compiles through, and whether strictly: walk up to the nearest
`package.json`, take its `"mx"` field if present (`{ host, strict? }`, with
`"translator"` accepted as a deprecated alias for `"html"`); failing that, use
its sole `@mxlang/*` host dependency if there is exactly one; otherwise fall
back to the default non-strict HTML policy.

It lives here rather than in either caller because two entry points ask the
same question — `@mxlang/language-server` (which policy to diagnose a document
under) and `@mxlang/typescript-plugin` (which host to compile a `.mx` file's
virtual TypeScript through). An editor and a `tsc --noEmit` resolving a file to
different hosts is exactly the drift a second copy invites, so there is one
implementation and one set of branch tests (`src/host-policy.test.ts`, covering
all six branches including two-host ambiguity and a walk that reaches the
filesystem root). Unlike the rest of this package it reads the filesystem,
which is why it is its own module rather than part of `core.ts`.

## The IR, and what a host implements (decision 79)

The core **lowers** a Marko template into a small host-independent tree, and
a host **emits** from that tree. No host walks a Marko node.

```
Marko AST ──lower()──▶ Ir ──drive(emitter)──▶ whatever the host emits
             ▲                                  (strings, JSX nodes, …)
             └─ HostDeclarations: the questions the lowerer asks
```

`src/ir.ts` defines the kinds. Each one exists because a host has to emit it
differently, and each carries a `loc` (1-based line, 0-based column — the
shape `TranslateError` reports, which is what an editor squiggle needs):

| Kind | The Marko construct it comes from |
| --- | --- |
| `Text` | A literal run, already normalized by Marko's own `onText` (decision 33) |
| `Interpolation` | `${expr}` and `$!{expr}`; `escaped` is false for the raw form |
| `Element` | An HTML/SVG/MathML element, with `attrs`, `children` and a `void` flag |
| `Component` | A component call: target is an import binding, a `<define>`, or `<${expr}/>` |
| `IfChain` | `<if>` plus every `<else if>`/`<else>`, grouped; the trailing else has a null condition |
| `For` | All four `<for>` forms, normalized to `of` / `in` / `range` (with `inclusive` for `to=` vs `until=`, `step` on a `range` source, and `key` from `by=` for a host with reconciliation — a string-emitting host ignores both; Solid's `<Repeat>` uses `step`, its `<For keyed>` uses `key`) |
| `Define` | `<define/Name\|params\|>` |
| `Const` | `<const/name=expr/>` |
| `Static` | A `static` block, and any host statement block that hoists like one |
| `Import` | An `import` statement, with the binding names it introduces |
| `Export` | Any other top-level `export`, hoisted verbatim |
| `InputInterface` | `export interface Input`, lifted so a host can place it |
| `Hoisted` | A statement lifted by decision 70's `hoist` hook |
| `HostTag` | A tag the host claimed, with attrs/children/attribute tags/params/var resolved, plus its own opaque `data` |
| `DocumentType` | `<!doctype html>`, delimiters already stripped by Marko |
| `Comment` | A comment; `html` distinguishes `<!-- -->` from `//`, which only the source can tell apart |

An expression arrives as `Expr`: the printed `code` (sliced from source if untouched, or rewritten through
the binding registry, so an emitter stays dumb) plus the original `node`, for a
host that must inspect the shape — `class={a: true}` versus `class=someCall()`
is an `ObjectExpression` test, not a string test.

The five statement kinds — `Static`, `Import`, `Export`, `InputInterface` and
`Hoisted` — carry their code as a plain string, with no `Expr` and so no Babel
node to read a span from. They therefore carry an **`end` position** beside
`loc`, giving each one a full source range. `Ir`'s own `imports`, `hoisted`,
`inputInterface` and `prelude` fields hold these nodes rather than bare
strings, so a consumer that needs positions has them and an emitter that does
not simply reads `.code`. `ctx.hoist(code, node)` takes the producing node for
the same reason: a statement a host hook synthesizes still maps back to the tag
that produced it. Without these ranges a type error inside a `static` block or
an `export const` cannot be placed, which is what
`@mxlang/typescript-plugin` maps whole-block (see its README's mapping-coverage
section).

### Writing a host, in order

1. **Declare.** Supply a `HostDeclarations` (`src/declarations.ts`): the `tags`
   disposition table, `isElement`, `isComponent`, optionally `checkBinding`,
   `keepComments`, `claimsTag`, `resolveHostTag` and `rejectModifier`. Every
   member is a *question* — none of them can emit, because during lower there
   is nothing to emit into.
2. **Claim what is yours.** `claimsTag(name)` says the host lowers a tag
   itself; `resolveHostTag(name, node, ctx)` then records its decision into the
   node's `data` slot while the Marko node is still in hand. An emitter that
   had to re-inspect `tag.node` would be walking Marko nodes again — the thing
   the IR exists to stop. This is also the seam decision 80's user-tag macros
   will need.
3. **Emit.** Implement `Emitter<Out>` (`src/emit.ts`), one method per kind, and
   let `drive()`/`emit()` walk the tree. Every method is required: an emitter
   that silently ignored a kind would drop authored content from a successful
   compile (the S8 class this codebase's guards exist to close), so a host that
   cannot express a construct throws from the method, naming it and its
   position.
4. **Wire it.** Pass the required `emitIr` in `HostOptions`; the core resolves
   and hands your emitter the `Ir`.

**The string worked example is `@mxlang/html`** (`src/emitter.ts`): the vanilla
HTML host, an `Emitter<string[]>` that accumulates `out +=` lines. It is the
one to read, because it reproduces its predecessor's output byte for byte —
including two details that look accidental and are not: literals merge across
node boundaries into a single `out +=`, and `$forN` names a loop temporary from
the emitted-line count rather than a loop counter. The expression-shaped
example is `@mxlang/astro`'s `.amx` emitter: an `Emitter<string>` producing
ternaries, `.map` expressions, `class:list` and Astro named slots.

Statement tags lower into `Ir.imports`, `Ir.hoisted` and
`Ir.inputInterface`; each host places them in its own module shape. This is
also how `.amx` moves a template `static` statement into Astro frontmatter.

## Tests

```
bunx vitest run --root ../.. --project @mxlang/core
```

`src/lower.test.ts` (one fixture per IR kind, positions, host hooks and error
cases), `src/emit.test.ts` (the exhaustive driver), `src/fragment.test.ts` (the
fragment door, non-zero bases and the error path), `src/custom-tags.test.ts`,
`src/scan.test.ts` (the walk, `mx.tags`, static `parseOptions` reading, cache
invalidation and taglib-id reuse, over fixtures in `src/fixtures/scan/`), and
`src/escape.test.ts`.
