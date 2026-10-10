# `@mxlang/core`

The MX front end and lowerer every MX host is built on.

> **Beta.** This package is at 0.x. Its API may change in any release until 1.0.0.

MX is a template language born from Marko: Marko's syntax is the default row,
brought to wherever JSX lives today (see `notes/mx-vision.md`). MX itself defines
the markup and the **structural** tags — `<if>` / `<else if>` / `<else>`, `<for>`
in all its forms, attribute tags, tag params, `<define>`, `<const>`, `static`,
`import` — and each **host** decides what state, reactivity and output mean. This
package is the half that is the same for every host: it parses a template with
its own front end (the MX AST), lowers the structural forms into an IR, and asks
`HostDeclarations` for everything host-specific.

Marko is the default syntax, not the parser: no template is parsed with
`@marko/compiler`, and a `.marko` file is not an input. Where MX has no ruling of
its own the answer is Marko's, and every difference is listed in
`divergences.md` in the repository. A dialect package can change the syntax
for the file extensions it claims (see "Dialects" below).

The only runtime dependency is `@babel/parser`. The published bundle inlines the
MX front end and a copy of the Marko compiler core uses for taglib lookup and
code printing, so installing core installs no `@marko/*` package.

## Core versus host

| Belongs to the core | Belongs to a host |
| --- | --- |
| The structural tag lowerings (`<if>`, `<for>`, `<define>`, `<const>`, statement tags) | The disposition table: which tags are inert, which are errors, why |
| The field guard (`rejectUnsupportedFields`) and the inert-shape guard | Component-versus-element resolution, and what a component call emits |
| The IR and its `drive`/`emit` traversal | An `Emitter` for the target's output shape, attributes and component calls |
| The two front doors (`compileSource`, `parseFragment`) | Stateful tags (`<let>`, `<effect>`, `:=`), through the three hooks |
| Custom-tag declarations, validation, and IR transforms | Discovery and sidecar loading in the calling integration |
| `escape` | Its own integration: a Vite plugin, a Bun loader, a TypeScript plugin |

`@mxlang/target-html` is the first host (vanilla HTML strings); `@mxlang/host-astro`
(`.astro.mx`, expression-shaped Astro syntax) and `@mxlang/host-solid` (Solid's
`.solid.mx` bridge, Solid JSX text) are the other two.

## The HostDeclarations contract

A host passes one `HostDeclarations` object. `Policy` remains a compatibility
alias of that type only. Every member is a lower-time question:

| Member | What it decides |
| --- | --- |
| `tags` | Per-tag-name dispositions: `inert` (accepted, no output, in a declared shape) or `error` (this target cannot express it). Decision 65: never "my code cannot". |
| `isElement(name, ctx)` | Whether an unbound lowercase tag name is a real element. |
| `isComponent(name, ctx)` | Whether a tag name resolves to a component in this host. |
| `isDelegatedTag?(name, ctx, shape?)` | Whether the host owns a tag the structural core does not. |
| `resolveDelegatedTag?(name, node, ctx)` | Records the host's decision in `DelegatedTag.data` while the Marko node is available. |
| `rejectModifier?`, `rejectAttributeMethod?` | Replace generic attribute diagnostics with the host's own wording. |
| `rejectElementAttributeTags?`, `rejectComponentTag?`, `rejectUnknownTag?` | Replace generic tag-routing diagnostics with the host's own wording. |
| `checkBinding?(target, what)` | Inspects a name a construct is about to bind at *render* scope; not called for tag params, which open a nested scope. |
| `keepComments?` | Whether an HTML comment reaches the output. |

The tag hooks and IR node are named `isDelegatedTag`, `resolveDelegatedTag` and `DelegatedTag` (decision 132; formerly `claimsTag`, `resolveHostTag`, `HostTag`).

`DYNAMIC_TAG` is the sentinel name `isDelegatedTag` receives for `<${expr}/>`;
match against the exported constant rather than retyping it. A bare
`${expr}` placeholder and `<${expr}/>` lower to the identical node (no
attrs, no body), so `isDelegatedTag`'s third argument carries `"bare"` or
`"tagged"` — `"bare"` only for the no-attrs-no-body shape, `"tagged"`
otherwise — letting a host opt out of claiming the bare shape and leave it to
the `Interpolation` fallback. The argument is passed only alongside
`DYNAMIC_TAG`; every other tag name gets `undefined`. An `isDelegatedTag` that
ignores the third argument keeps claiming both shapes, which is every
current host's behavior — the parameter is opt-in, not a required change.

## The three stateful-tag hooks (decision 70)

MX does not define `<let>`, `<effect>`, `<lifecycle>`, `<script>` or `:=` —
those are framework territory, and mean whatever the host says (decision 71).
The core gives a host exactly three capabilities, exercised through the
resolver tests:

**1. Tag handler — `isDelegatedTag` + `resolveDelegatedTag`.** The core offers every tag
it does not own to the declarations before component/element routing. A host's
`<signal/count=1/>` records its resolved form in `DelegatedTag.data`; the emitter
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

Lowering parses, walks, prints and strips TypeScript with stock Babel
packages (decision 197): `@babel/parser` for `parse`/`parseExpression`,
`@babel/core`'s own `traverse`, `types` and `File`, `@babel/generator`,
`@babel/code-frame` and `@babel/plugin-transform-typescript`. They are
exact-pinned runtime dependencies (not bundled), loaded lazily in
`src/babel.ts` (`coreBabel()`), so importing core loads no Babel. `traverse`,
`types` and `File` come from `@babel/core` so the TS strip's file, its paths
and the walk over them are one instance whatever an install dedupes. The
published `.d.ts` names no `@babel/*` type: nodes are untyped (`Node`) at
core's boundary. The MX front end parses payloads with its own fork
(`@mxlang/babel`); Babel's helpers dispatch on `node.type`, so they read
those nodes like their own.

Until PR 6 core used `@marko/compiler`'s bundled Babel (7.29.7, patched for
Marko's own node types, which MX payloads never are); `src/babel.test.ts`
pins that the stock generator prints every payload of the repo's `.mx`
corpus as Marko's did.

**`printExpression(node)` is a public export**: the generator is part of the
byte contract, so every host prints an expression node back to source text
through the one function `newCtx`'s `translate` visitor already uses, rather
than with its own Babel generator. `@mxlang/host-solid` used
to carry its own copy over `@babel/generator` — a *different* Babel instance
from the one that parsed the node — before switching to this export.

## The two front doors

**`compileSource(source, filename, declarations, host)`** — a whole file. It
parses with the MX front end (`@mxlang/parser/frontend`, inlined into the
dist), reading each tag's shape and the statement keywords from core's tag
table (`tagTable(translator, declarations.nativeTags)`: the host translator's
taglibs over the target's native elements, core's own HTML elements when it
declares none; decision 197), lowers the MX AST, and runs the host's
`emitIr`. `host` is required and carries its `emitIr` function plus the
taglibs to register, the tag-discovery directories, and an optional `postEmit`
pass over the emitted module text. `createTranslator(host)` is exported
separately because the table is cached per translator object, so a caller
that wants the table a compile reads must hand the same object to `tagTable`.
No `marko.json` is read, and no template is parsed by `@marko/compiler`.

**`parseFragment(source, { filename, baseOffset, baseLine, baseColumn, nativeTags })`** — an
MX *substring* of a larger file, with every position shifted to the
enclosing file. The consumer is a host whose MX lives inside another language
(Solid's `.solid.mx`). This is the stopgap
`notes/research/marko-seam-spikes.md` spike 1 measured, not a fix: the fix is an
additive base-position parameter upstream, which MX still intends to send.
Solid's own bridge (`packages/tsx-bridge/src/mx/bridge.ts`) now calls this
front door for every MX region it finds — see `packages/hosts/solid/README.md`
for the bridge's own side of that hand-off. Documented limits:

- `FragmentResult.body` is the MX body and `FragmentResult.ast` the
  `MxDocument`. Their nodes carry file-absolute UTF-16 offsets
  (`start`/`end`, and `span` on field shapes) computed from the fragment's
  base, so a consumer slices the enclosing file with them directly.
- The Babel expression nodes nested in a container carry their offset at
  `loc.*.index`, shifted the same way.
- An expression error stays on its container and is raised when the fragment
  is lowered; `parseFragment` itself throws for a template error, a bare `,`
  line, and any expression error when a method's type parameters fail.
- Comments are `MxComment` nodes in the body and shift like any other node.

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
`preserveWhitespace`, `openTagOnly`) into the injected taglib, from which the
MX front end reads the tag's shape (its `tagTypes` entry) before parsing,
then validates declared `attributes`, `attributeTags`, `children` and `parents` before `transform`.
Attribute-tag declarations also accept recursive `attributes`, `attributeTags` and `children` maps. The shared attribute checker supports E1 types at every depth; defaults on attribute-tag attributes are not applied. E2's children check runs on each attribute tag's authored body before child lowering, including `#text` and path cardinality. Errors name the owner chain (`` `<card>`: `<@row>`: unknown attribute `bogus` ``) and stop at the first. A declaration with none of these maps keeps the prior no-template shape/control-flow rejection; template `Input` and host capability gates remain unchanged (decision 138 E4).
`children` closes authored plain child names with `{ required?, repeatable? }` cardinality; the reserved `#text` key permits non-whitespace text and interpolations. Control flow is transparent, declarations and comments are ignored, and dynamic children are errors in a closed contract. The check runs before plain children lower, so transform output cannot change their counted names; `TagCall.childTree` exposes that authored shape to hooks. Children cannot be combined with raw-text or open-tag-only parse options (decision 138 E2).
`parents?: string[]` restricts authored direct parents: control flow is transparent, any other authored tag breaks the chain, and an attribute-tag body has parent `@name`. The reserved `#root` key means a file/template unit's own top level, including recursion, not its caller's parent. Omitted parents are open; an empty list permits none. Registration cross-checks both directions for registered tags: a parent's closed `children` list and each child's declared `parents` must agree on their shared entry. Both contradiction messages end with the alternative list edits. `<define>` is not transparent, and a dynamic parent never matches a `parents` list. Core checks placement before lowering the call's body, equally for transform, template-sidecar and parents-only delegated contracts (decision 138 E3).
An unknown key in an `attributes`/`attributeTags`/`children` declaration (a typo, or a
retired name such as `staticOnly`/`repeated`) is rejected at registration,
before any file is parsed, recursively at every attribute-tag depth. Transforms receive resolved author material and return ordinary IR. Builder
output is stamped with the call-site position, `ctx.gensym()` is unique within
the file, and `ctx.build.delegatedTag(name, children, attributeTags, attrs?)` is the
only route to a host primitive from a `transform`. A tag with only a contract
(no `transform`, no template) on a name the host claims skips the transform
altogether: core validates the call and lowers it to a `DelegatedTag` carrying the
call's attributes (decision 130). On a host that does not claim the name it
still fails with "neither a `transform` nor a template".

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
with directory-level defaults a sidecar may override, after local directories.
`mx.contracts` names a module (string, `{ module, hosts? }`, or array) default-exporting `ContractMap`: declarations plus `analyze`, no transforms or templates; it comes last, replaces whole entries, and warns on shadowing or duplicate names (decision 142, spec §9.2).

Two properties make this usable from every integration:

- **It is synchronous**, because every consumer is: Bun's `onLoad`, Volar's
  `createVirtualCode`, the language server's `diagnoseDocument` and `mx-tsc`
  all call from positions that cannot await.
- **It indexes without executing.** `parseOptions` fix a tag's shape for the
  MX front end before the *calling* file is parsed, so it is read statically out of the sidecar's
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
makes the taglib lookup (`@marko/compiler`'s) fail *every* file in the package — is skipped or
reported rather than registered. A `.solid.mx` file in a `tags/` directory is
a different file kind and is reported, not silently ignored.

Results are cached per directory and invalidated by what the scan recorded: a
directory's entry list, each tag file's mtime and content hash, and the
`package.json` carrying `mx.tags` or `mx.contracts`. Contracts modules evaluate
on a cache miss; unchanged scans reuse the same map. Edited ESM/TS modules need a
tool restart under Node; Bun reloads them. CommonJS `.cjs` modules reload correctly
on Node (TODO `sync-esm-reload-node`). Keep modules self-contained:
transitive imports are not tracked or evicted; restart to reload edited helpers. A broken sidecar — unparseable `parseOptions`, or a module that
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

## Dialects

A dialect is a package. It declares itself in its own
`package.json`, under `mx.dialect`:

```json
{
  "name": "@acme/mesh",
  "mx": {
    "dialect": {
      "id": "mesh",
      "name": "Mesh",
      "extensions": [".mesh.mx"],
      "module": "./dialect.js"
    }
  }
}
```

`id` is lower-case words joined by `-` (never `mx`, MX's own); `name` is what
tooling calls the dialect, and core's diagnostics on its files say it where
they would say "MX"; `extensions` are the extensions it claims (never `.mx`);
`module` is the path, inside the package (never absolute, never out
through `..`), to the module whose default export is the dialect:
`{ table, … }`, a syntax table overlaid on the `.mx` default row, plus
optional hooks (`lowerTrigger`, `lowerBlockTag`, `lowerFilter`, `afterLower`,
the contract hooks below), a `tagRules` preset (`html` when it states none; `lowerSource` parses under
it when its call states no `tagRules`)
and `nodeTypes`. Core stamps the manifest's `id` and `name` on it; the module
may leave them out (`DialectModule`).

`mx.dialect` is an identity block, never project configuration: the project's
own `mx` settings are read as if it were not there, and it is never an
unknown-key error. A project uses a dialect by depending on it. Core reads the direct
dependencies of a file's nearest `package.json` (all four dependency fields),
statically, and routes the file to the dialect that claims the longest
extension its name ends with. Every other file, `.mx` included, parses with
MX's default row. Discovery follows the dependencies on disk, so an install
or an edited dependency manifest is seen at the next compile. Two dependencies
with one `id` is an error naming both. Two dialects claiming one extension is
an error naming both; the project settles it with `mx.extensions`:

```json
{ "mx": { "extensions": { ".mesh.mx": "mesh" } } }
```

A malformed manifest is an error at its field, in the dialect's
`package.json`; a `module` that cannot be resolved, at `mx.dialect.module`. A
problem in the dialect itself is an error in the module file, and a module
that fails to load keeps that error until the file changes. On Node, an edited
ES-module dialect is picked up after a restart (Bun, and CommonJS on Node,
reload it). `mx.syntax` is removed. `discoverDialects(projectFile)` lists a project's dialects without
loading any code, and `routeDialect(file)` says which one a file goes to.
`compileSource`, `parseFragment` and `lowerSource` also take a `dialect` option
(a dialect with its `id` and `name`, or a bare table), which wins over
routing.

### Node types (`@unstable`)

A dialect can register its own node types, keyed `id:Type` in one registry
with core's own (core is dialect zero, `mx`: `mx:Tag`, `mx:Attribute`, …). A
trigger row names one with `node: { type, dialect }`, in an attribute list,
on a tagless line, or in the value position (`valueTriggers`: an attribute's
whole `=value`). In an attribute list and on a line the row's `match` decides
where the node ends; in the value position the parser already knows where the
value ends, so `match` must cover the whole value and only decides whether the
row is asked. While the file parses, core hands the text, its span and a
context (`ClaimContext`: the position, the tag's static name, the attribute's
name for a value, `fail`) to the type's `parse`. Fields claim the text: core
stamps them with `type` and `span`, and the node stays in the MX AST at that
position (a value node is the `MxAttribute`'s `value`). `undefined` declines
it: the parse goes on as if no row matched there. At lowering, core calls the
`lower` of the node's `type`, with the same `ctx` constructors `lowerTrigger`
gets:

```ts
import type { Dialect, DialectNode, NodeType } from "@mxlang/core";

interface Ref extends DialectNode {
  readonly path: readonly string[];
}

const Ref: NodeType<Ref> = {
  keys: [],
  parse: (text, _span, ctx) => {
    if (text === "~skip") return undefined; // declined: `~skip` parses as it would with no row
    const path = text.slice(1).split(".");
    if (path.includes("")) ctx.fail("empty segment");
    return { path };
  },
  print: (node) => `~${node.path.join(".")}`,
  // In the value position, `lower` returns the attribute's value.
  lower: (node) => node.path.join("."),
};

export default {
  id: "ref",
  name: "Ref",
  table: {
    valueTriggers: [
      {
        id: "ref",
        chars: "~",
        match: "~[a-z]+(?:\\.[a-z]+)*",
        standIn: "identifier",
        node: { type: "Ref", dialect: "ref" },
      },
    ],
  },
  nodeTypes: { Ref },
} satisfies Dialect;
```

`print(parse(text))` gives the text back. `<sort to=~user.name>` lowers to a
static attribute `to="user.name"` whose IR carries the node (`Attr.node`)
beside the `value` every target emits. A value node's `lower` returns a string
or `ctx.expression(node)`; in an attribute list or on a line it builds
attributes and tags, as `lowerTrigger` does. A row names a type of its own
dialect or one of core's: `mx:Trigger` (the same as `{ call }`; attribute and
line), `mx:Expression` (declines every text; every position) and `mx:String`
(claims a value as the string it spells, quoted or bare; value position only).
Naming another dialect's types is not supported yet. Any other name is the one
error the claim owns. For this dialect's value row naming `ref:Path`: ``the
`ref` trigger names `ref:Path`, which is not a registered node type (a row can
name `mx:String`, `mx:Expression`, `ref:Ref`)``; the list is the types a row
in that position can name. A type registered only for other positions is
named as such (``… which is not a registered node type in value position (a
row there can name `mx:String`, `mx:Expression`, `ref:Ref`)``).

## A reference dialect: `@mxlang/core/syntax/member`

Core ships one dialect as a reference for extension authors: Mesh's `&`
member sigil (`&status` in an expression, `sort asc &dueOn` in an attribute
list, `&title` on a tagless line). It is not a host and core knows no
"member"; it is built on the public hook API only (`Dialect`, `Trigger`
and the `lowerTrigger` context), so it doubles as a worked example of all
three trigger positions. A tag built from a tagless line carries
`trigger: { id, span, text }`; an authored `<member>` does not.

Use it as is, as the `dialect` option or as the `module` of a dialect package:

```ts
import { lowerSource } from "@mxlang/core";
import memberSyntax from "@mxlang/core/syntax/member";

const result = lowerSource(source, file, { dialect: memberSyntax });
```

or copy `dist/syntax/member.js` from the package (or the source, `packages/core/src/syntax/member.ts` in the mxlang repo) into your project and rename it. The sigil
(`chars` and `match`), the dialect's `id` and `name` (`member` and `Mesh`
here), the row `id`, the `self` receiver and the child tag name are that
file's choices. In the source, change its one type import from `../index.ts` to
`@mxlang/core`; edit the row, and name your copy as the `module` of your
dialect package's `mx.dialect`. It loads
through Node's strip-only `require`: types-only imports, no enums or
parameter properties.

## Atoms and name sugars as a dialect: `@mxlang/core/syntax/atoms-sugars` and `@mxlang/core/syntax/mesh`

Decisions 183 and 196 take atoms (`:name` values, decision 156) and the
name sugars (`:name` setting `name`, spaced `#id` and `.class`, decision
146) out of core's grammar before the beta. `@mxlang/core/syntax/atoms-sugars`
is the reference dialect that carries them as layer-2 triggers on the public
hook API only; `@mxlang/core/syntax/mesh` combines it with the member dialect
(the shape Mesh copies as its own dialect). Until the move lands, core still
handles them itself on the `.mx` default row; a loaded row on a character
(`:` in an expression, `:`, `#` or `.` in an attribute list) replaces core's
built-in handling of that character. What the dialect reads differently from
the built-in path is the list in `scripts/sugar-module/deltas.json`, each
entry naming its ruling (`#x=1` refused, decision 183, among them).

```ts
import { lowerSource } from "@mxlang/core";
import meshSyntax from "@mxlang/core/syntax/mesh";

const result = lowerSource(source, file, { dialect: meshSyntax });
```

Copy it the way the member dialect is copied (its type imports from
`../index.ts` become `@mxlang/core`; `mesh.ts` also imports its two siblings).

**Lifetime** (decision 183 addendum 6): both dialects are exported, `@unstable`,
through the beta, as reference material rather than a host's API. Mesh vendors
them at the alpha.15 pin and owns its copy from then on. `atom`, `name` and
`member` are Mesh's forms; `id` and `class` are kept for parity with the
built-in sugars and may be dropped. `syntax/mesh` also has the value row
`atom-value` (a whole attribute value `:name`, the node type `mesh:Atom`,
lowered to the atom-marked string literal the `atom` row builds); Mesh copies
it and the `Atom` node type into its own syntax. Mesh's entity files and docs blocks are a
golden corpus here (`src/fixtures/syntax/mesh-corpus/`, its README, and
`src/ir-entry/mesh-corpus.test.ts`); the deletion of the built-ins
(slice c) must pass it unchanged.

### Contract checks in a dialect: `contractFields`, `checkContract` and `afterLower(unit)`

The atom contract keys (an attribute's `values`, `pattern` and `ref`, a
tag's `declares`) are checked by the atoms dialect too, not by core, once the
dialect is loaded. Three `@unstable` parts of `Dialect` carry this, and
none names atoms:

- `contractFields: { attribute?: string[], tag?: string[] }` lists the
  contract keys the dialect owns. Core accepts a listed key at registration
  as opaque data, in `customTags`, `mx.contracts` and tag sidecars alike, and
  never checks it. A key that no core rule knows and no dialect lists is
  still a registration error. Of core's own keys only those four can be
  listed. Claims are per key and independent. Core keeps the whole-value
  shape check (`type: "atom"` or `"member"`) and `ctx.declare` in
  `analyze`, and never reads a claimed key to word its shape error.
- `checkContract(tag, contract, ctx)` runs at registration for every
  contract that uses a listed key, at any depth, called or not. `contract`
  is plain data (`attributes`, `attributeTags`, `children` and the listed
  tag keys). `ctx.fail(message, { code? })` raises the error where core's
  own registration error lands: in the sidecar, in the `mx.contracts`
  module at 1:0, or with no position for the `customTags` option.
- `describeAttribute(declaration)` words what a declaration that uses a
  listed key accepts, for core's shape error (`" (one of :a, :b)"`).
- Contract data handed to a dialect is a deep-frozen copy; an expression's
  `node` is core's live node, read-only by contract.
- `afterLower(unit)` runs once per unit, after core's own checks. `unit` is
  a frozen `LoweredUnit`:
  - `calls`: every custom tag call with its contract (the listed tag keys
    included), its attributes as written (`string`, `atom`, `member`,
    `boolean`, `expression`, `spread`), its attribute tags at any depth, and
    its authored ancestors with an opaque `scope` per tag instance.
  - `declared`: what `analyze` hooks declared.
  - `fail(message, { at?, code?, also? })` and `warn(message, at?)`.

```ts
import type { Dialect, LoweredUnit } from "@mxlang/core";

const checks: Partial<Dialect> = {
  contractFields: { attribute: ["unique"] },
  afterLower(unit: LoweredUnit) {
    for (const call of unit.calls) {
      for (const attr of call.attrs) {
        if (attr.kind === "spread") continue;
        const declared = call.contract.attributes?.[attr.name];
        if (declared?.unique && attr.kind === "atom") {
          // A positioned error; `code` reaches `DataDiagnostic.code`.
          unit.fail(`\`:${attr.value}\` must be unique`, {
            at: attr.span,
            code: "UNIQUE",
          });
        }
      }
    }
  },
};
```

The atoms dialect's diagnostics are core's built-in ones, word for word and
at the same positions: shape problems from its `checkContract`, uses from
its `afterLower`.

Which dialect claims the keys follows the file's syntax. A discovery scan
(`tags/`, `mx.tags`, `mx.contracts`) reads the dialect the file's extension
routes it to; it cannot see an explicit `dialect` option. So a
scanned contract that uses a key only the option's dialect claims is refused
at the scan, positioned in the sidecar or the contracts module. Contracts
passed as `customTags` follow the explicit option. One thing is the built-in path's only: completion
facts (`CompileResult.atomFacts`, `atomCandidates`) are empty for a unit
whose dialect takes over the atom keys.

## Host-policy resolution

**`resolveTargetPolicy(filePath)`** (`src/host-policy.ts`) answers which host a
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

Edge cases of the walk, each pinned by tests:

- The nearest `package.json` is the one that *exists*. A malformed one (or one
  that is not a JSON object) ends the walk with the default `html` policy and a
  warning naming it and the ancestor whose host the file used to take; it never
  falls through to an unrelated ancestor (Node, TypeScript and `scan.ts` stop
  there too).
- A directory with no `package.json` of its own belongs to the nearest
  ancestor's project, a monorepo root included — that is how `src/` works, and
  it cannot be told apart from a member that forgot its manifest. Give the
  member its own `package.json` (or `mx.host`) to opt out.
- The walk stops at a `node_modules` directory, as Node's package scope does:
  an installed package with no `package.json` gets `html`, not the consumer's host.
- An `mx.host` naming no host warns (valid hosts, nearest match) and is ignored.
- Two or more host dependencies still mean `html`.
- `peerDependencies` are never counted: a host listed only as a peer does not select that host (decision 124).

`resolveTargetPolicyDetailed(filePath)` returns `{ policy, diagnostics }`;
`resolveTargetPolicy` is its `policy`. All diagnostics are warnings
(`{ file, message, line, column }`, positioned in the `package.json`). Today
only the Vite plugin (`this.warn`) and the language server (a warning on the
open document) surface them; `mx-tsc` and the editor's TypeScript plugin get
the same fallback behaviour silently.

## Target descriptors (unstable)

`TargetDescriptor`, `TargetLookup`, `createTargetLookup`, `validateDescriptor`
and `loadTargetDescriptor` (`src/target-descriptor.ts`, `src/target-loader.ts`)
are the contract a *target* (an output format, optionally belonging to a host
framework) registers with. They are **unstable** (`descriptorVersion: 0`) and
nothing in the repo consumes them yet; see `AGENTS.md` for the rules the
validator and the lookup enforce and for how a descriptor is loaded from a
project.

## The IR, and what a host implements (decision 79)

The core **lowers** an MX template into a small host-independent tree, and
a host **emits** from that tree. No host walks a parser node.

```
MX AST ──lower()──▶ Ir ──drive(emitter)──▶ whatever the host emits
             ▲                                  (strings, JSX nodes, …)
             └─ HostDeclarations: the questions the lowerer asks
```

`src/ir.ts` defines the kinds; the normative contract — every field, position rule and emitter invariant — is the docs site's [IR specification](../../apps/docs/docs/architecture/ir-spec.md). Each one exists because a host has to emit it
differently, and each carries a `loc` (1-based line, 0-based column — the
shape `TranslateError` reports, which is what an editor squiggle needs):

| Kind | The construct it comes from |
| --- | --- |
| `Text` | A literal run, already whitespace-normalized by the front end (decision 33) |
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
| `DelegatedTag` | A tag the host claimed, with attrs/children/attribute tags/params/var resolved, plus its own opaque `data` |
| `DocumentType` | `<!doctype html>`, delimiters already stripped by the parser |
| `Comment` | A comment; `html` distinguishes `<!-- -->` from `//`, which only the source can tell apart |

An expression arrives as `Expr`: the printed `code` (sliced from source if untouched, or rewritten through
the binding registry, so an emitter stays dumb) plus the original `node`, for a
host that must inspect the shape — `class={a: true}` versus `class=someCall()`
is an `ObjectExpression` test, not a string test. `Expr.span?: SourceSpan`
(core contract C4) carries file-absolute UTF-16 code-unit offsets of the expression's own
authored source text, filled by `exprOf` for every construction site and
absent only when the expression has no authored source — a synthesized `Expr`
built with no backing node, or a custom tag's fabricated literal default —
rather than a fabricated span pointing at unrelated text. `mapping.ts`'s
`mappedExpr(expr)` is the thin wrapper a host emitter uses to turn one into a
`GeneratedMapping`, mirroring `mapped(name, nameSpan)` for the attribute-name
half of the mapped population; adopting it is per host and out of scope here.

`mappedMethod(expr)` is the sibling for an attribute method shorthand
(`onClick() { … }`). It returns the `function` expression Marko's printer made
of it, with the printed head unmapped and the body mapped token by token
against the authored body (`Expr.bodySource`/`bodySpan`, `mappedRewrite`), also
when the printer reformatted the body or reads were rewritten. When the printed
code is not a single function expression, it returns the whole value unmapped,
with no mappings. It returns `undefined` only when `expr` has no authored body
(`bodySpan`/`bodySource` absent), so a caller falls back to `mappedExpr(expr)`. Callers: the Preact emitter, which the React and Hono
hosts share, and the Solid emitter, both as `mappedMethod(expr) ?? mappedExpr(expr)`.

`Define.nameSpan`/`paramSpans` and `For.paramSpans` extend the same
convention to `<define>`'s own name and params and a `<for>`'s params — the
file-absolute UTF-16 code-unit spans every other source-derived IR run already carried.
Each is `undefined` under the same rule as `Expr.span`: no span for a node
with no authored `loc`. A component call's own tag-name span is not
duplicated on `ComponentTarget`: `Component.nameSpan` (above) already
carries it, computed from the same `node.name`.

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
   `keepComments`, `isDelegatedTag`, `resolveDelegatedTag` and `rejectModifier`. Every
   member is a *question* — none of them can emit, because during lower there
   is nothing to emit into.
2. **Claim what is yours.** `isDelegatedTag(name)` says the host lowers a tag
   itself; `resolveDelegatedTag(name, node, ctx)` then records its decision into the
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

**The string worked example is `@mxlang/target-html`** (`src/emitter.ts`): the vanilla
html target, an `Emitter<string[]>` that accumulates `out +=` lines. It is the
one to read, because it reproduces its predecessor's output byte for byte —
including two details that look accidental and are not: literals merge across
node boundaries into a single `out +=`, and `$forN` names a loop temporary from
the emitted-line count rather than a loop counter. The expression-shaped
example is `@mxlang/host-astro`'s `.astro.mx` emitter: an `Emitter<string>` producing
ternaries, `.map` expressions, `class:list` and Astro named slots.

Statement tags lower into `Ir.imports`, `Ir.hoisted` and
`Ir.inputInterface`; each host places them in its own module shape. This is
also how `.astro.mx` moves a template `static` statement into Astro frontmatter.

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
