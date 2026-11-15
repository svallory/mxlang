---
title: "The jsx target"
description: "How the Preact, React, Hono and Solid targets fold into one jsx target: what they share today, the hook points the target owns, how each host fills them, and the steps that get there."
---

# The jsx target

**Status: proposed (decision 187).** Nothing here is built yet. This note
decides no removal or rename of public API; those questions are listed under
"Open for the operator" at the end, with a recommendation each.

**Summary.** MX has four JSX-producing targets today: `preact-jsx`,
`react-jsx`, `hono-jsx` and `solid-jsx`. Three of them already run on one
emitter that lives in `@mxlang/host-preact` and differ only in a table of
names. Decision 187 folds all four into one `jsx` target that owns a small set
of hook points, each with a default, and turns `preact`, `react`, `hono` and
`solid` into hosts built on it (`builtOn: "jsx"`). A host then supplies
handlers for the hooks it needs to change, plus its tag resolution and file
kinds. This note records what is shared today, names the hooks, maps each host
onto them, proposes a package home and lists the fold as a sequence of later
units. Solid goes last.

Every claim about today's code cites a file and line at the commit named in
the footer.

## Today

### One emitter already serves three hosts

Core walks the IR with one interface: `Emitter<Out>` has one method per IR
kind (`packages/core/src/emit.ts:35`), and `drive` calls them
(`packages/core/src/emit.ts:59`). The JSX hosts implement it once:

- `PreactEmitter` (`packages/hosts/preact/src/emitter.ts:1076`) is the only
  JSX emitter for Preact, React and Hono.
- React and Hono have no emitter of their own. `compileReactMx` calls
  `compilePreactMx` with `reactDialect` and `reactDeclarations`
  (`packages/hosts/react/src/compile.ts:53-62`); `compileHonoMx` does the same
  with `honoDialect` and `honoDeclarations` (`packages/hosts/hono/src/compile.ts:53`). Their region entries
  call the shared `compileJsxRegion` (`packages/hosts/react/src/compile.ts:88`,
  `packages/hosts/hono/src/compile.ts:88`), defined in
  `packages/hosts/preact/src/region.ts:187`.
- Both depend on `@mxlang/host-preact` as a package
  (`packages/hosts/react/package.json:19`, `packages/hosts/hono/package.json:25`).

### What differs between them is data

The per-host differences sit in one object type, `JsxDialect`
(`packages/hosts/preact/src/dialect.ts:18`). It holds names, not branches:

| Field | What it decides | Read at |
|---|---|---|
| `jsxImportSource` | the `@jsxImportSource` pragma | `packages/hosts/preact/src/compile.ts:712` |
| `classAttr`, `forAttr` | `class`/`className`, `for`/`htmlFor` | `packages/hosts/preact/src/emitter.ts:1823-1824` |
| `eventPropNames`, `closedEventPropNames` | event prop casing, and whether an undeclared event is an error | `packages/hosts/preact/src/emitter.ts:1855-1856` |
| `rawHtmlProp`, `rawHtmlValue` | the prop and value shape for `$!{…}` | `packages/hosts/preact/src/emitter.ts:2603`, `:2628` |
| `textObjectGuard`, `textDataGuard`, `nodeShape` | how a `${…}` value is guarded, and which objects count as renderable nodes | `packages/hosts/preact/src/emitter.ts:2513-2515`, `packages/hosts/preact/src/compile.ts:221` |
| `textareaContent`, `textareaLeadingNewline` | how `<textarea>` content reaches the renderer | `packages/hosts/preact/src/emitter.ts:2680`, `packages/hosts/preact/src/compile.ts:231` |
| `reactBooleanAttributes` | boolean attributes as presence-only props | `packages/hosts/preact/src/emitter.ts:1563` |
| `errorBoundaryModule`, `errorBoundaryName`, `suspenseName` | what the `<try>` lowering imports | `packages/hosts/preact/src/compile.ts:118`, `packages/hosts/preact/src/emitter.ts:3483`, `:3514` |
| `fragmentModule`, `mxClassModule`, `attrTagModule` | where `Fragment`, `mxClass` and the `AttrTag` type come from | `packages/hosts/preact/src/compile.ts:110`, `:122`, `:716` |
| `hookModules` | which hook imports a returning unit refuses | `packages/hosts/preact/src/compile.ts:806` |

The three values are `preactDialect` (`packages/hosts/preact/src/dialect.ts:308`),
`reactDialect` (`packages/hosts/react/src/dialect.ts:273`) and `honoDialect`
(`packages/hosts/hono/src/dialect.ts:11`).

The type's doc comment states the rule this note keeps: a knob the emitter
would have to branch on structurally does not belong in the table; it
"belongs in a second emitter rather than in a boolean here"
(`packages/hosts/preact/src/dialect.ts:12-15`). In the fold, a handler is the
form that rule takes: a host that lowers a construct differently supplies a
handler for it, never a flag.

### Declarations and helpers are shared too

- `createJsxDeclarations(name, { region? })`
  (`packages/hosts/preact/src/emitter.ts:627`) builds each host's tag policy.
  React and Hono call it (`packages/hosts/hono/src/dialect.ts:37`,
  `packages/hosts/react/src/dialect.ts:298`). It maps the host's display name
  back to a package name with a ladder over `"Preact"`, `"React"` and
  `"Hono"` (`packages/hosts/preact/src/emitter.ts:632-639`): shared code
  that names hosts, which the fold moves into the hosts.
- `<try>` is the only tag the JSX hosts lower themselves, besides
  `<html-comment>`, which they claim only to refuse it
  (`isDelegatedTag`, `packages/hosts/preact/src/emitter.ts:709`;
  `resolveDelegatedTag`, `:721-730`). The `<try>` lowering is
  `delegatedTag` (`packages/hosts/preact/src/emitter.ts:3452`).
- The callee reader is one module, `@mxlang/host-preact/callee-reader`, which
  the React and Hono descriptors require
  (`packages/hosts/react/src/descriptor.ts:96-97`,
  `packages/hosts/hono/src/descriptor.ts:97-98`).
- Hono's default-tag scope uses Preact's `translator`
  (`packages/hosts/hono/src/default-tag.ts:13`, defined at
  `packages/hosts/preact/src/index.ts:148`).

### Solid has its own emitter

`SolidEmitter` (`packages/hosts/solid/src/emitter.ts:2509`) is a separate
implementation of the same core interface with its own declarations
(`solidDeclarations`, `packages/hosts/solid/src/emitter.ts:698`;
`isDelegatedTag`, `:719`). It imports nothing from `@mxlang/host-preact`
(`packages/hosts/solid/package.json` has no such dependency). Its control flow
is Solid's components, not JavaScript expressions:

- `<if>` becomes nested `<Show when={…} fallback={…}>` when the chain has at
  most two conditioned branches, and `<Switch fallback={…}>` with one
  `<Match when={…}>` per branch when it has three or more (`ifChain`,
  `packages/hosts/solid/src/emitter.ts:3099`; `<Show` at `:3115`, the
  two-branch test at `:3127`, `<Match` at `:3137`, `<Switch` at `:3146`).
- `<for>` becomes `<For each={…}>` with accessor parameters
  (`forLoop`, `packages/hosts/solid/src/emitter.ts:3150`; `<For` at `:3187`).
- `<try>` becomes `<Loading>`/`<Errored>`
  (`delegatedTag`, `packages/hosts/solid/src/emitter.ts:3441`).
- Event props come from `solidEventPropName`
  (`packages/hosts/solid/src/event-names.ts:187`, called at
  `packages/hosts/solid/src/emitter.ts:1221`), raw HTML rides `innerHTML`
  (`packages/hosts/solid/src/emitter.ts:2602`).
- `<let>`, `<effect>` and `<lifecycle>` are refused
  (`STATEFUL_ERRORS`, `packages/hosts/solid/src/emitter.ts:57-66`).

### Descriptors and `builtOn`

Each host registers its own target: `preact-jsx`
(`packages/hosts/preact/src/descriptor.ts:49`), `react-jsx`
(`packages/hosts/react/src/descriptor.ts:49`), `hono-jsx`
(`packages/hosts/hono/src/descriptor.ts:49`) and `solid-jsx`
(`packages/hosts/solid/src/descriptor.ts:35`). The registry imports all four
(`packages/target-registry/src/index.ts:46-49`).

None of them sets `builtOn`, but core already supports it. It is not missing
from `packages/`, only unused by the JSX hosts:

- `TargetDescriptor.builtOn` (`packages/core/src/target-descriptor.ts:338`)
  and `TargetLookup.baseTargetOf` (`packages/core/src/target-descriptor.ts:387`).
- The registration check refuses a `builtOn` that names no registered target
  (`packages/core/src/host-policy.ts:613-625`).
- The registry reads `mx.<base>.defaultTag` as the rung below a target's own
  key (`baseConfigFor`, `packages/target-registry/src/index.ts:463-481`).
- `TargetDescriptor.configKey` lets a renamed target keep its old config key
  (`packages/core/src/target-descriptor.ts:350`).
- Documented for third-party targets in
  [Third-party targets](/targets/third-party-targets/) (`builtOn`, line 94) and
  in the specification, §13.5 "Base target"
  (`apps/docs/docs/specification.md:4322`).

## Hook points

The `jsx` target owns the lowering. A hook is a place where a host may replace
one piece of it. Each hook has a default, and **every default is today's
Preact behaviour**, so a host that supplies nothing compiles exactly as Preact
does now. The signatures below are sketches; the fold units fix the final
names.

All hooks live in the `jsx` target's package. None of them adds anything to
`packages/core`: core keeps its `Emitter` interface and `BindingRegistry`, and
the `jsx` target's emitter calls a host handler where it calls its own code
today. A host hands its handlers to the target from its descriptor's `load()`
(the closure that already passes the `JsxDialect` value and the declarations to
the compile entry, `packages/hosts/react/src/compile.ts:53-62`). A third-party host on
`jsx` uses the same mechanism; how one is found is MX 2's question.

| Hook | What it does | IR kind | Signature sketch | Default | Today's default lives at |
|---|---|---|---|---|---|
| `If` | turns an `<if>`/`<else-if>`/`<else>` chain into JSX | `IfChain` (`Emitter.ifChain`) | `ifChain(node, lower): MappedCode` | a ternary chain ending in `null` | `packages/hosts/preact/src/emitter.ts:3258` |
| `For` | turns a `<for>` into JSX that renders each row | `For` (`Emitter.forLoop`) | `forLoop(node, lower): MappedCode` | `.map` with a `key` per row | `packages/hosts/preact/src/emitter.ts:3292` |
| `Try` | renders `<try>`'s body under an error boundary and a placeholder | `DelegatedTag` with data `{ kind: "try" }` (no IR kind of its own) | `tryTag(node, lower): MappedCode` | `MxErrorBoundary` with a body thunk, `MxPlaceholder` (Preact's `Suspense`) under `<@placeholder>` | `packages/hosts/preact/src/emitter.ts:3452` |
| `Await` | reserved for `<await>` | none: `<await>` never reaches an emitter | `awaitTag?(node, lower): MappedCode` | refuse, with today's error | each JSX host refuses `<await>` with its own error today, Solid through the field guard (`apps/docs/docs/specification.md:4134`) |
| Binding read/write | rewrites references to a binding a host declares (a `<let>` read as `count()`) | none: core's `BindingRegistry`, used during lowering | `bindingRewrite?(name, declaredBy): BindingRewrite \| undefined` | no rewrite | core's registry (`packages/core/src/core.ts:345`), see below |
| Output flavour | the names and small value shapes the emitted JSX uses | every kind that prints a name | a value of today's `JsxDialect` type | `preactDialect` | `packages/hosts/preact/src/dialect.ts:308` |

`lower` in the sketches stands for the emitter services a handler needs to
print child content: rendering children as an expression, opening a scope for
row bindings, adding a runtime import. Today these are private members of
`PreactEmitter` (`#expression`, `#inScope`, `#runtimeImports`, used in
`forLoop` and `delegatedTag`: `packages/hosts/preact/src/emitter.ts:3296-3297`,
`:3483`, `:3514`); the step that introduces the hooks makes them
the handler's argument.

**`Await`.** No host fills it. It exists because decision 187 names it, and
its default keeps today's refusal, so adding it changes no output.

**Binding read/write.** Core already has the mechanism. `BindingRegistry`
(`packages/core/src/core.ts:345`) maps a binding name to a rewrite; its doc
comment's example is a Solid signal, `count` read as `count()`
(`packages/core/src/core.ts:331`). Lowering sees it as
`TranslateContext.bindings` (`packages/core/src/core.ts:429`), and core
rewrites free references when it prints an expression
(`packages/core/src/core.ts:1392-1419`, done in `rewriteReferences`, `:1859`).
No host registers a rewrite today (`git grep "bindings.register" --
'packages/hosts/*/src'` finds nothing), and Solid refuses `<let>`. The hook's
default is therefore no rewrite, its first consumer is Solid's signals, and it
is **added with its first user**, not before.

**Output flavour.** The hook is today's `JsxDialect` fields, as they are. The
fold adds no field to it. A future difference that would need an `if` on a
host in the emitter becomes a handler, never a flavour field.

No hook beyond these six is proposed. If folding Solid shows that it differs
somewhere else (element lowering is the likely place), that step proposes the
extra handler with Solid as its user.

## Host mapping

Rows are hooks; each cell names what supplies the behaviour today.

| Hook | preact | react | hono | solid |
|---|---|---|---|---|
| `If` | `PreactEmitter.ifChain` (`packages/hosts/preact/src/emitter.ts:3258`) | the same code, through `compilePreactMx` | the same code, through `compilePreactMx` | `SolidEmitter.ifChain`, `<Show>`/`<Switch>` (`packages/hosts/solid/src/emitter.ts:3099`) |
| `For` | `PreactEmitter.forLoop` (`packages/hosts/preact/src/emitter.ts:3292`) | the same code | the same code | `SolidEmitter.forLoop`, `<For>` (`packages/hosts/solid/src/emitter.ts:3150`) |
| `Try` | `PreactEmitter.delegatedTag` with `preactDialect`'s `MxErrorBoundary`/`MxPlaceholder` from `@mxlang/host-preact/runtime` (`packages/hosts/preact/src/dialect.ts:318-320`) | the same code with `reactDialect`'s names from `@mxlang/host-react/runtime` (`packages/hosts/react/src/dialect.ts:285-287`) | the same code with `honoDialect`'s `MxErrorBoundary` and `Suspense` from `@mxlang/host-hono/runtime` (`packages/hosts/hono/src/dialect.ts:24-27`) | `SolidEmitter.delegatedTag`, `<Loading>`/`<Errored>` (`packages/hosts/solid/src/emitter.ts:3441`) |
| `Await` | refused (spec §13.3) | refused | refused | refused |
| Binding read/write | not yet (no `<let>` rewrite) | not yet | not yet | not yet (`<let>` refused, `packages/hosts/solid/src/emitter.ts:58-61`) |
| Output flavour | `preactDialect` (`packages/hosts/preact/src/dialect.ts:308`) | `reactDialect` (`packages/hosts/react/src/dialect.ts:273`) | `honoDialect` (`packages/hosts/hono/src/dialect.ts:11`) | emitter code: `solidEventPropName` (`packages/hosts/solid/src/event-names.ts:187`), `innerHTML` (`packages/hosts/solid/src/emitter.ts:2602`) |

After the fold, the preact column is the defaults, react and hono supply only
an output flavour, and solid supplies `If`, `For`, `Try` and an output
flavour (plus whatever the Solid step finds).

## Package home

**Recommendation (open for the operator):** a new package,
`packages/targets/jsx`, named `@mxlang/target-jsx`, next to
`@mxlang/target-html` (`packages/targets/html`). It holds what is in
`@mxlang/host-preact` today and is not Preact's: the emitter
(`./emitter`), the `JsxDialect` type (`./dialect`), the region engine
(`./region`), the callee reader (`./callee-reader`) and the compile entries
`compilePreactMx` and `compileJsxRegion`, plus the `jsx` target descriptor.
`@mxlang/host-preact` keeps its descriptor, `preactDialect`, its runtime and
its file kind, and re-exports the moved names from its current subpaths so no
import breaks (`packages/hosts/preact/package.json:12-19`). React and Hono
then depend on `@mxlang/target-jsx` instead of `@mxlang/host-preact`.

Why a package and not a folder in `host-preact`: the fold's point is that no
host is the base. While the shared code lives in `host-preact`, React and Hono
depend on Preact's package, and Solid would have to as well.

## Selection after the fold

Unless the operator rules otherwise, selection behaves as today
(`apps/docs/docs/specification.md:4209-4230`):

- **`mx.host: "preact"`** selects the host's default target, `preact-jsx`,
  as today.
- **`mx.target: "preact-jsx"`** selects the same target. Its descriptor now
  says `builtOn: "jsx"`, so its base target is `jsx`: a check keyed on the
  base target applies to it, and `mx.jsx.defaultTag` becomes the rung below
  `mx["preact-jsx"].defaultTag` (`packages/target-registry/src/index.ts:463-481`).
  The `mx["preact-jsx"]` key keeps working.
- **`mx.target: "preact"`** stays an `unknown-target` error whose hint names
  `preact-jsx`.
- **`mx.target: "jsx"`** is new: the `jsx` descriptor must be registered for
  `builtOn` to resolve. Whether it is also selectable is open for the
  operator, below.

The same holds for `react`, `hono` and `solid`. The specification's §13.5
callout already describes the fold and says the registry still lists the
four `*-jsx` targets (`apps/docs/docs/specification.md:4190-4195`).

## Fold steps

Each step is a later unit. Every step keeps the emitted modules of the
preact, react and hono hosts identical byte for byte: the proof in each is
`bun run oracle:preact`, `oracle:react` and `oracle:hono` with the same
pass and skip counts as the base, plus a comparison of every oracle fixture's
emitted module at the base and the head, and the affected tests unchanged.

1. **Move the shared code into `@mxlang/target-jsx`.** Size M. Packages:
   new `packages/targets/jsx`, `packages/hosts/preact`, `packages/hosts/react`,
   `packages/hosts/hono`. Moves the emitter, `JsxDialect`, the region engine,
   the callee reader and the compile entries as they are, with
   `@mxlang/host-preact` re-exporting them. Moves no behaviour. Proof: the
   oracles and byte comparison above, and `bun run pack-probe` (new package,
   changed dependencies and exports). Depends on the operator's answers to
   questions 2 and 3.
2. **Take host names out of the shared code.** Size S. Packages:
   `packages/targets/jsx`, the three hosts. `createJsxDeclarations` takes the
   package name from its caller instead of the `"Preact"`/`"React"`/`"Hono"`
   ladder (`packages/hosts/preact/src/emitter.ts:632-639`). Proof: the
   oracles and byte comparison, and the declarations' existing tests.
   Depends on step 1.
3. **Register `jsx` and set `builtOn`.** Size S. Packages:
   `packages/targets/jsx`, the three hosts, `packages/target-registry`.
   Adds the `jsx` descriptor and `builtOn: "jsx"` on `preact-jsx`,
   `react-jsx` and `hono-jsx`. Proof: a registry test that
   `baseTargetOf("react-jsx")` is `"jsx"`; the oracles and byte comparison.
   Depends on step 1 and the operator's answer to question 1.
4. **Introduce the hooks with Preact's code as their defaults.** Size M.
   Packages: `packages/targets/jsx`, the three hosts. `If`, `For` and `Try`
   become handlers whose defaults are today's methods; `Await` is reserved
   with its refusal; output flavour is today's `JsxDialect` value. React and
   Hono pass their flavour and no handler. No binding hook yet. Proof: the
   oracles and byte comparison. Depends on step 2.
5. **Fold Solid.** Size L; may take several PRs. Packages:
   `packages/hosts/solid`, `packages/targets/jsx`. Solid supplies `If`
   (`<Show>`/`<Switch>`), `For` (`<For>`), `Try` (`<Loading>`/`<Errored>`) and an output
   flavour, and drops the parts of `SolidEmitter` the target then covers. Its
   first PR compares `SolidEmitter` with the target's emitter and lists every
   difference outside the named hooks; any extra hook it needs is proposed
   there, with Solid as its user. Proof: Solid's emitted modules unchanged
   byte for byte over its own fixtures, its render tests
   (`packages/hosts/solid/src/ssr-render.test.ts`,
   `packages/hosts/solid/src/client-render.test.ts`), and the three oracles
   unchanged. Depends on steps 3 and 4.
6. **Binding hook, with its first user.** Not part of the fold. Solid's
   `<let>` as a signal is a language change on that host (it is refused
   today) and needs its own ruling and bead; the binding hook is added in
   that unit.

## Open for the operator

1. **Target names and config keys.** Keep `preact-jsx`, `react-jsx`,
   `hono-jsx` and `solid-jsx` as the registered names, with their `mx.target`
   values and `mx["<name>"].*` config keys; or rename them (to `jsx` plus a
   host, for example) and keep the old keys through `configKey`. Also: is
   `jsx` itself selectable with `mx.target: "jsx"`, and if so, which host
   does it compile for? **Recommendation:** keep the four names and their
   keys unchanged; register `jsx` as a base target and refuse it in
   `mx.target` with a hint that names the four host targets, since `jsx`
   alone does not say which runtime to emit for.
2. **Moving `@mxlang/host-preact`'s shared exports.** Move the `./emitter`,
   `./dialect`, `./region` and `./callee-reader` exports and
   `compilePreactMx`/`compileJsxRegion` into the new package and re-export
   them from `@mxlang/host-preact`; move them without re-exports (a breaking
   change for anyone importing them); or leave them where they are and only
   add hooks. **Recommendation:** move and re-export, marking the
   `host-preact` re-exports deprecated; remove them in a later release by a
   separate ruling.
3. **The new package's name.** `@mxlang/target-jsx` in `packages/targets/jsx`;
   or `@mxlang/jsx`; or keeping the code in `@mxlang/host-preact`.
   **Recommendation:** `@mxlang/target-jsx`, which follows `@mxlang/target-html`.

---

Code citations are at commit `8535be0a3`.
