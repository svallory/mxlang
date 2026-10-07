# html — agent instructions

`packages/targets/html` (`@mxlang/html`) holds the string target.

**After editing this package, rebuild `@mxlang/typescript-plugin` too** (`cd packages/tooling/typescript-plugin && bun run build`): its `dist` bundles `@mxlang/html`, so `mx-tsc` tests (`packages/tooling/tsc`) run the stale html until it is rebuilt.

It contains:

- `escape(value)` plus the sink (`createOut`, `createBufferedOut`, the `Out`
  type; also published as `@mxlang/html/runtime`, `src/runtime.ts`) — the
  *entire* runtime. `escape` escapes `& < > " '`; `null` and
  `undefined` render as `""`, not their names.
- `compile(source, filename, options?)` -> `{ code, map }`, driving the
  translator under `@marko/compiler`. `options.strict` swaps in `strictPolicy`
  (see the translator section below). The map is currently an identity
  placeholder: the translator builds text directly rather than printing an
  AST. Marko's nodes do carry real `loc`, so genuine mappings are now
  possible — a separate task.
- `TranslateError` — a construct that parses as Marko but has no string
  lowering, carrying `line`/`column` rather than byte offsets, because that is
  what Marko's nodes have.

Emitted module shape (decision 155, the Marko render model): one runtime
import (`escape`, `createOut`, `createBufferedOut` only when a `<try>` uses it,
and the `Out` type, all from `"@mxlang/html"`, kept in **one** import because
the oracle and the test harnesses rewrite that specifier once), the author's
hoisted `import`s and `static` blocks, their `export interface Input`
verbatim, then two entries:
`export default function <Name>(input: Input): string` (named after the file —
see the export-name bullet below), which creates a sink, calls `__mxRender` and
returns the string, followed by `<Name>.render = __mxRender;`; and
`function __mxRender(input, __mxOut: __MxOut)`, which writes with
`__mxOut.write(…)` (literals merged into one call — the goldens diff this
code) and returns the `<return>` value, exported as `render`. The sink entry is
named `__mxRender` so it cannot collide with an author's `render` binding.
Tag calls pass `__mxOut` down: `Name.render(props, __mxOut)` for a discovered,
self-recursive or known-returning callee, `__mxRenderTag(__mxOut, Callee)(props)`
(run-time `.render` dispatch, typed as `Callee` itself so props are checked as
before) for anything else, `__mxRenderDynamic(__mxOut, …)` for a dynamic tag.
Blocks (`content`, `<define>`, renderable attribute tags) stay `() => string`
with their own sink. Every compiled module imports `createOut` at run time, so
a test fixture that nests its own `package.json` must make `@mxlang/html`
resolvable (see `linkRuntime` in `bun.test.ts`).

Whitespace on **every** host, Solid included, is decision 33's rule
applied once, by Marko's own `onText` before `@mxlang/core`'s resolver ever
sees a `MarkoText` node (see the four Marko facts in `packages/tsx-bridge/AGENTS.md`) — there is no
separate Solid-specific whitespace pass to keep in sync; a second
implementation on any host's path would collapse whitespace twice.

Goldens live at `packages/targets/html/fixtures-marko/<name>/` with
`input.marko`, `input.json` and `expected.html`, and are asserted on
**rendered HTML**, not on emitted code, so the emitter stays free to improve.
`biome.json` ignores `**/fixtures-marko`.

## `@mxlang/html`: the vanilla html target on `@mxlang/core`

`packages/targets/html` (`@mxlang/html`, decisions 66, 68) compiles an
**ordinary Marko template** to a runtime-free `(input) => string` module. Not
a dialect: tag discovery through taglibs and `tags/` directories, Marko's own
HTML/SVG/MathML element registry, Marko's attribute-tag and component
conventions. The seam is `config.translator` — package-name discovery is a
dead end, since 5.42.5 scans only `@marko/runtime-*`.

The generic half now lives in `packages/core` (`@mxlang/core`) — see
"`@mxlang/core`: the Marko-node consumer" in `packages/core/AGENTS.md`.
`packages/targets/html` keeps
`translate.ts` (the policy rows, `strictPolicy`), `bun.ts`, `types/`,
`example.ts`, the taglib and the fixtures; its `index.ts` is a thin wrapper
over the core's `compileSource`, and its own `emitProgram` is now a
`postEmit(code: string) => string` pass that appends the
`classValue`/`styleValue`/`escapeComment`/`renderDynamic` helpers a template
actually calls. `escape` moved to the core and is re-exported here, so every
compiled template's `import { escape } from "@mxlang/html"` is
unchanged. The `./core` export is **gone** (breaking): importers take
`@mxlang/core` directly.

Policy table (decision 65): the target renders what Marko's server render
emits, minus resume markers. **Inert** (accepted, no output, each verified
byte-identical against Marko): `<effect>`, `<lifecycle>`, `<script>`, `<id>`,
`<log>`, `<debug>`, `client` blocks (client-only), and `by=` on `<for>`. A
`server` block is **not** inert — this is the server render, so it runs and
hoists like `static`, and its bindings are readable from the template
(verified: `server const S = 41 + 1` then `${S}` renders `42`). `<return>` is
**not** an error any more: under the unit model a tag is its own module and
its caller invokes it, so a returning unit's `render(input, out)` writes its
output to the caller's sink and returns the value, which `/var` binds (decision
155; see the `<return>` bullet in `packages/core/AGENTS.md`). **Evaluate initial
value**: `<let>`, `<const>`, `:=`. **Error** — only what the target genuinely
cannot: `<await>` (Marko itself refuses to render one to a string) and
`<try>` with a `<@placeholder>` (needs a second pass). A plain `<try>` with
`<@catch>` lowers to `try`/`catch` whose body writes into a buffered sub-sink
(`createBufferedOut`), committed on success and dropped on a throw, as Marko
does. A `<try>` without `<@catch>` is a plain block: the error propagates, as
in Marko (locked by a unit test; the oracle cannot express a throw). The
`try-*` fixtures in `fixtures-marko` lock the partial-output drop; the JSX oracles
skip three of them (TODO `jsx-try-ssr-error-boundary`, `tryGaps` in
`packages/oracle/src/report-preact.ts`).

**Inert is a shape, not a licence to drop.** An inert row declares the body
and attributes its own Marko tag definition allows, and anything else is an
error naming the tag and what was found — otherwise
`<effect><div>x</div></effect>` compiles clean with the `<div>` deleted, which
is the S8 silent-drop class reopened. The declarations are per tag because
Marko is: `<effect foo="bar"/>` and `<log=1 foo="bar"/>` are refused there,
while `<lifecycle foo="bar"/>` compiles (a lifecycle tag's attributes are its
configuration), and `<script>` is the one inert tag taking a body (raw text).

Some constructs need no row at all, because Marko's own parser rejects them
before a translator runs — do not add code for these, and do not read their
absence as tolerance: `key=` on an element, and `$!{…}` in an attribute value.

`class:foo`/`style:foo` are a separate category: **not Marko syntax**, rather
than something this target cannot express. Marko has no such modifier and says
so (*"`class:active` is not a valid attribute, did you mean
`class={ active: condition }`?"*), so the translator errors with Marko's own
fix-it. There is no behaviour to reproduce and no fixture to write, since no
`.marko` file using them compiles at all.

A **render-scope** binding named `input` (`<let/input=…>`, `<const/input=…>`)
is rejected: it would shadow the emitted `function (input: Input)` parameter
and make the template's own input unreachable, and Marko refuses it as a
duplicate declaration. A **tag param** (`<for|input|>`, `<define/R|input|>`) is
*accepted*, because it opens a nested scope where an ordinary JS shadow is
correct — Marko renders those. Rejecting them would be an implementation limit
stated as a rule, which decision 65 forbids. Note the codegen consequence: a
`<for>`'s iterable is bound to a temporary before the loop opens, or a param
shadowing the name used in the iterable (`<for|input| of=input.items>`) hits
the temporal dead zone and throws at render time.

Two behaviours worth knowing before editing the policy, both verified rather
than assumed:

- **Marko hoists `value` first on `<input>`**, so
  `<input type="text" value=x>` emits `<input value=… type=text>`. A browser
  applies `type` before `value`, and some types reinterpret a later `value`.
  The emitter's `elementAttributes` does it at emission (html no longer
  implements the core `orderAttrs` hook, which reordered the IR across
  spreads); `htmlEquals` compares attribute order, so getting this wrong fails
  the oracle. With a spread on the tag, Marko's own shape is followed instead:
  attributes after the last spread are written first, the rest is one merged
  object in authored order, and `<input>` keeps authored order (decision 135
  addendum).
- **`class`/`style` take structured values**: `class={a: true, b: false}` →
  `class="a"`, `class=["x", {y: true}]` → `class="x y"`,
  `style={color: "red", top: 0}` → `style="color:red;top:0"`. These lower to
  emitted `classValue`/`styleValue` helpers, inlined only when called, so a
  template using none of them still compiles to `escape` and concatenation
  alone.

`bun run oracle:marko` prints one table, for
`packages/targets/html/fixtures-marko` — see the "oracle:marko" section in
`packages/oracle/AGENTS.md` for the current fixture count and pass/skip/bug totals. Fixture
`expected.html` files are generated from real Marko, never hand-written.

### The `strict` policy

Decision 68's policy fold: the retired `.mx` dialect rejected reactive
constructs (`<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client` blocks,
`<id>`) by name, since standalone MX had no reactive target at all. The
default `policy` above instead renders what Marko's own server render would
emit for those (inert, or `<let>`'s initial value) — decision 65's table.
`strictPolicy` (`translate.ts`) keeps `.mx`'s stance as an *opt-in*: the same
six constructs become errors naming the construct, for an author who wants
"this needs a reactive runtime" to be a compile error. `compile`/`compileFile`/
`build` take `{ strict: true }` to select it.

Decision 111 extends `strictPolicy` to also reject `<log>` and `<debug>` by
name, as errors rather than the default policy's inert rows: both are
debug-only tooling, not reactive constructs, but a strict author wants the
same "name the construct, don't silently compile it away" treatment for them.
The `input`-shadowing check
(`checkBinding`) is **not** `strict`-only — it was already the default in
both the old `.mx` policy and this one, since a `<let>`/`<const>` binding
named `input` silently breaking the template's own input is a bug either way,
not a stricter preference. Dropped rather than folded in (decision 65: these
were conventions of the old `.mx` walk, not target capabilities, so they do
not survive as a policy toggle): the explicit-import requirement, the
`export interface Input` requirement (Marko allows arbitrary TS regardless),
`<fragment>`, and lowercase-by-scope tag resolution.

`<html-comment>` lowers placeholders as Marko does, through an emitted
`escapeComment` helper that escapes **only `>`** — `<`, `&` and quotes pass
through raw, matching Marko's own `_escape_comment`. Filtering placeholders
out (an earlier bug) turned `<html-comment>build ${input.sha}</html-comment>`
into `<!--build -->`.

## Attribute-tag values (decisions 106–107)

This host declares `attrTags: 2` and emits only core's resolved
`attrTagProps` plan. It never regroups the legacy flat `attributeTags` list.
Decision 108 makes an untyped body-only property renderable; attributes or
nested tags on any occurrence keep the fallback data-shaped. Declared shapes
remain unchanged.
Cardinality comes from the callee's `Input`: singular values are one value or
`undefined`, arrays are real arrays (including `[]`), and control-flow tags
become conditional values or push loops in source order. Nested plans are
emitted recursively.

`@mxlang/html` exports its own `AttrTag<C>`. A renderable value is always an
HTML block function `(...params) => string` (with `[]` when params are absent).
A data value is `attrs & nestedProps & { content?: (...params) => string }`;
`content` is explicitly `undefined` when the occurrence has no body. Dynamic
tag arguments are forwarded so a callee can invoke a parameterized data
`content` or renderable tag with `<${value}(args)/>`. Calling a data value
itself through an untyped dynamic target fails with a diagnostic that points
to its `content` route instead of the engine's opaque "not a function" error.

Declared attribute-tag values retain their contextual types through
conditional and loop plans: emitted concrete values use `satisfies` against
the callee's `Input` property, so tag params do not become implicit `any` when
an array is assembled incrementally. A one-param `for in` loop destructures
only the key; it never synthesizes a local named `value` that can shadow an
author binding (the same rule applies to ordinary content loops).


## Bun loader

`packages/targets/html/src/bun.ts` (`@mxlang/html/bun`) is the Bun-side
`.mx` integration, decision 58 roadmap item 2, half A (moved here from the
retired `@mxlang/html/bun` by decision 68). It exports a `BunPlugin` that
registers `build.onLoad({ filter: MX_FILTER }, ...)` — `MX_FILTER` is
`/(?<!\.solid)\.mx$/`, `.mx` only; `.marko` is deliberately not registered
(see "`.mx` is the only template extension" in `packages/tsx-bridge/AGENTS.md`). On each matched `.mx`
file it reads the source, runs it through `compile()`, and returns
`{ contents: code, loader: "ts" }` — `compile()`'s output is plain TypeScript
(an `import`, an optional `export interface Input`, a default-exported
function, no JSX), so Bun's own TS stripper handles it directly with no
second transform.

The plugin object self-registers at import time (`Bun.plugin(markoPlugin)`
runs at module scope, in addition to the `export default`): `bunfig.toml`'s
`preload = ["@mxlang/html/bun"]` runs a preloaded module purely for its
side effects — it does **not** call `Bun.plugin` on a default export
automatically — so without the self-registration call, `.mx`
imports silently fall through to Bun's default loader and resolve to the
file's path string, not a compiled function. `Bun.plugin` is idempotent for
an already-registered plugin object, so `import markoPlugin from
"@mxlang/html/bun"; Bun.plugin(markoPlugin)` (the programmatic form)
still works without double-registering.

`examples/mx-site` uses this loader: `bunfig.toml` preloads it, `.mx` pages
import each other directly (`import Layout from "./layout.mx"`), and
`src/server.ts`/`src/build.ts` import pages directly with no prebuild step.
The compiled-output equality check decision 58 calls for ("cannot paper over
an emit bug") lives in the e2e suite's own content assertions
(`e2e/routes.spec.ts`), run against both the dev server and the static
build — there is no separate golden-file diff, since the rendered HTML
itself is the golden.

`packages/targets/html/src/bun.test.ts` is a `bun:test` file (not vitest — it
exercises `Bun.plugin` and Bun's own dynamic `import()`, both Bun-runtime
only), run via `bun run test:bun` in that package. `packages/targets/html`'s
own `vitest.config.ts` excludes it from the vitest project so the root
`bun run test` does not try to load `bun:test` under Node/Vite.

`mx()`/`loadMx()` (`src/helpers.ts`) evaluate on Bun as `Bun.plugin`
virtual modules under the `mx-virtual:` scheme, never `data:` URLs: Bun 1.3.14
(the CI pin in `.prototools`) fails `require("data:…")` with `NameTooLong` past
~1.5 KB, and nested tags embed base64 in base64. Bun 1.4.x has no such limit,
so `test:bun` passes there even if a `data:` path comes back. Run `test:bun`
under the pinned Bun (`PATH=~/.proto/tools/bun/1.3.14:$PATH`); a shell whose
`bun` is newer than `.prototools` hides this class of bug.

## `.mx` import typing

`packages/targets/html/types/marko.d.ts` declares `declare module "*.mx"`,
typing the import as `(input: any) => string`. `any`, not each file's real
`Input` interface: per-file typing
needs a virtual-file projection of the compiled module (the same shape
`@mxlang/typescript-plugin` now does for `.solid.mx` — see
`packages/tooling/typescript-plugin/AGENTS.md`), which is the phase-3 language server's job for this file kind, not
something an ambient wildcard declaration can derive. A consumer references it by adding the file to its own
`tsconfig.json` `include` (see `examples/mx-site` and `examples/mx-vite`);
there is no package-level `types` wiring that pulls it in automatically,
since a `.solid.mx`-only project (the Solid examples) has no reason to load
it.
