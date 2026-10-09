---
title: "HTML target"
description: "Compile .mx and .marko templates to a plain (input) => string function, no runtime beyond an escape helper."
---

# HTML target

The html target (`@mxlang/html`) is the vanilla MX target. It compiles an `.mx` file (or its `.marko` alias) to a pure function: a JS/TS module whose default export is `(input) => string`, with no runtime beyond an `escape` helper and a string-buffer sink. No scheduler, no signals, no hydration, no resume markers.

The generic half of the work — consuming Marko's AST, applying the structural lowerings, the string-emit model — lives in the shared core. This target supplies the policy on top of it: which tags are inert and which are compile errors, component-versus-element resolution, structured `class`/`style` values, and its own integrations (a Bun loader, the `escape` runtime, a taglib).

## Selecting the host

HTML is a **hostless target**. Select it with `"mx": { "target": "html" }`
in `package.json`. `mx.host: "html"` remains a silent legacy alias;
`mx.host: "translator"` retains its deprecation warning. An explicit HTML
target beats dependency inference, and combining it with `mx.host: "solid"`
is a positioned `target-host-mismatch` error (decisions 129/132;
[spec §13.5](/specification/#the-mx-language-13-host-semantics-table-135-host-and-target-selection)).

The other hostless target, `tree`, is checked by `mx-tsc` but not wired into the
editor tools or Vite yet: explicit `mx.target: "tree"` errors at its value there
and names `TODO data-target-tooling-dispatch`. See [the tree target](/targets/data/)
(decision 131 addenda).

## Attribute-tag values

Import `AttrTag` from `@mxlang/html` in hand-written TypeScript. A renderable
attribute tag is a thunk `() => string`; params change it to
`(...params) => string`. The default data shape carries attrs and nested tags
plus an optional `content` thunk. Arrays are real arrays, and conditional and
looped occurrences preserve source order. See [AttrTag](/language/attr-tag/)
for declarations, fallback inference, errors, and compiled examples.

Because MX 1.0 uses a strict subset of Marko syntax, this target compiles
**stock Marko syntax**, not a parser dialect: tag discovery through taglibs
and `tags/` directories, Marko's own HTML/SVG/MathML element registry, and
Marko's component conventions. Consumer-declared `AttrTag` values deliberately
differ from Marko's iterable record (decision 106); body-only untyped values
remain compatible under decision 108. Templates outside that recorded
divergence render the same bytes as Marko's own server render.

```html
<!-- greeting.mx -->
<h1 class={greeting: true}>Hello, ${input.name}!</h1>
```

compiles to:

```typescript
import { escape as __mxEscape, createOut as __mxCreateOut, type Out as __MxOut } from "@mxlang/html";

export interface Input {}

function Greeting(input: Input): string {
  const __mxOut = __mxCreateOut();
  __mxRender(input, __mxOut);
  return __mxOut.toString();
}
Greeting.render = __mxRender;

function __mxRender(input: Input, __mxOut: __MxOut): void {
  __mxOut.write("<h1");
  {
    const __mxValue = __mxClassValue({greeting: true});
    if (__mxValue !== "") __mxOut.write(" class=\"" + __mxValue + "\"");
  }
  __mxOut.write(">Hello, ");
  __mxOut.write(__mxEscape(input.name));
  __mxOut.write("!</h1>");
}
export { __mxRender as render };
Object.defineProperty(Greeting, Symbol.for("mx.component"), { value: true });

export default Greeting;
```

The module has two entries (decision 155, the Marko render model). `render(input, out)` writes the HTML to a sink and returns the template's `<return>` value; the default export creates the sink, calls `render`, and returns the string. `Greeting.render` is the same function as the named `render` export, so a caller holding only the default export can render into its own sink. A tag call passes the caller's sink down rather than concatenating a returned string; the specification's "The html target: render entry and sink" section has the call-by-call rules.

The default export is a **named** declaration, after the file (`greeting.mx` gives `Greeting`, `table-of.mx` gives `TableOf`), and carries a `Symbol.for("mx.component")` brand. The name is derived, never authored — and it is what lets a tag call itself with no self-import. The brand is what lets a host that receives a compiled module as an opaque value — the Astro renderer, for one — recognize it as an MX component without sniffing the function's name. `__mxClassValue` is one of the helpers (`__mxClassValue`, `__mxStyleValue`, `__mxEscapeComment`, `__mxRenderDynamic`, `__mxRenderTag`) appended to the module only when the template actually calls them; a template using none of them compiles to the runtime import and sink writes alone. Every generated name carries the reserved `__mx` prefix, and an authored binding with that prefix is a compile error (see "Reserved generated identifiers" in the specification), which is why the public `escape` export is imported under a private alias.

## Install

```bash
bun add @mxlang/html
```

## API

```typescript
import { compile } from "@mxlang/html";

const { code } = compile(source, "greeting.mx");
```

- `compile(source, filename, { strict? })` → `{ code, map }`
- `compileFile(filename, { strict? })` → `{ code, map }`
- `build(filenames, { strict? })` → `Map<filename, { code, map }>`, a CLI-free build step
- `escape(value)`, `createOut()`, `createBufferedOut(parent)` — the entire runtime the emitted module imports; the sink half is also published as `@mxlang/html/runtime`
- `Out` — the sink type: `write(html: string)` and `toString()`
- `TranslateError` — thrown for a construct with no lowering, carrying `line`/`column`

`compile` is the supported entry. The package also exports a named `translator`, but it works only inside `compile`, `compileFile` and `build`; passing it to `@marko/compiler`'s `compileSync` directly throws "no compile in flight".

## `mx(source)`/`loadMx(path)`: no bundler, no manual caching

For a bundler-free consumer (Express, Hono, a plain Bun server) wanting Pug's `compile`/`renderFile` ergonomics instead of driving `compile`/`compileFile` and executing/caching the result by hand:

```typescript
import { loadMx, mx } from "@mxlang/html";

const page = loadMx<{ name: string }>("./views/page.mx");
page({ name: "Ada" }); // -> "<p>Ada</p>"

const greet = mx<{ name: string }>("<p>${input.name}</p>");
greet({ name: "Ada" });
```

Both compile once, resolve every import in the compiled output to a real absolute target, and evaluate the result **synchronously, in memory, with zero disk writes** — on Bun (a `require` of a `data:` URL) and on Node ≥22.15 (`node:module`'s `registerHooks`, plus its `stripTypeScriptTypes` to erase the compiled output's own type annotations). `mx(source)` needs `filename` (the real path the source would live at) whenever its template has a custom tag or any import of its own, since that's the anchor a relative or bare import resolves against; `loadMx`'s own `path` is already that anchor. A discovered custom tag's `.mx` import is compiled recursively through the same cache, so a page whose tag itself imports another `.mx` file invalidates correctly when the deepest file changes. An import cycle across `.mx` files is a compile-time error naming the cycle.

Node-only caveats: `stripTypeScriptTypes` prints one `ExperimentalWarning` per process (not per call), suppressible with `--disable-warning=ExperimentalWarning`; and each recompiled module needs a fresh internal `require`-cache URL (Node cannot evict an already-loaded ESM module), so a long-lived dev process editing templates repeatedly grows this cache without bound — an unchanged file is a cache hit and adds nothing.

## Loaders

Two loaders make `import page from "./page.mx"` (or `"./page.marko"`) resolve, one per runtime.

**Bun** — `@mxlang/html/bun` is a plugin that intercepts `.mx` and `.marko` imports and compiles them on the fly (`.solid.mx`, `.react.mx`, `.preact.mx` and `.hono.mx` are excluded; each is a region file kind handled separately). Register it once:

```toml
# bunfig.toml
preload = ["@mxlang/html/bun"]
```

or at runtime:

```typescript
import markoPlugin from "@mxlang/html/bun";
Bun.plugin(markoPlugin);
```

**Vite** — `@mxlang/vite-plugin`'s `mx()` plugin handles `.mx` and `.marko` alongside `.solid.mx` by default:

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import mx from "@mxlang/vite-plugin";

export default defineConfig({
  plugins: [mx()],
});
```

`import page from "./x.mx"` typechecks against ambient declarations (`declare module "*.mx"`, typed `(input: any) => string`); add the file to your `tsconfig.json` `include` to pick them up.

## Consumer usage

```typescript
import render from "./greeting.mx";

const html = render({ name: "World" });
// '<h1 class="greeting">Hello, World!</h1>'
```

## Strict mode

By default this target renders what Marko's own server render would emit for the stateful tags (`<let>`'s initial value, `<effect>`/`<lifecycle>`/`<script>`/`client` blocks/`<id>` as inert — contributing no output). Passing `{ strict: true }` switches to a stricter policy that rejects those same constructs as compile errors instead, for a template that has no business needing a reactive runtime:

```typescript
const { code } = compile(source, "greeting.mx", { strict: true });
```

`compileFile` and `build` take the same option. See [Stateful tags](/language/stateful-tags/) for what a host is free to decide for itself.

## What each construct compiles to

The target is Marko's own server render, minus resume markers. That is the whole rule; the table below is what it implies, construct by construct.

**Inert** — accepted, contributing no output, each verified byte-identical against Marko:

| Construct | Why it renders nothing |
|---|---|
| `<effect>`, `<lifecycle>` | Client-side lifecycle; there is no client here |
| `<script>` | Component script, not a rendered `<script>` element |
| `<id>` | Identity for hydration |
| `<log>`, `<debug>` | Developer output |
| `client` blocks | Client-only by definition |
| `by=` on `<for>` | Reconciliation key; a string render reconciles nothing |

Inert is a *shape*, not permission to drop content. Each inert tag still declares the body and attributes its own Marko definition allows, and anything else is an error naming the tag and what was found — otherwise `<effect><div>x</div></effect>` would compile clean with the `<div>` silently deleted. The declarations are per tag, because Marko's are: `<effect foo="bar"/>` is refused, `<lifecycle foo="bar"/>` compiles (its attributes are its configuration), and `<script>` is the one inert tag that takes a body.

**Evaluated** — the initial value is computed and rendered:

| Construct | Result |
|---|---|
| `<let/x=expr/>` | `expr` evaluated once; no reactivity to update it |
| `<const/x=expr/>` | A `const` binding in the render function |
| `:=` | The initial value, same as `<let>` |
| `server` blocks | **Not** inert — this *is* the server render, so it runs and hoists like `static`, and its bindings are readable from the template |

**Errors** — only what the target genuinely cannot express:

| Construct | Why |
|---|---|
| `<await>` | Marko itself refuses to render one to a string |
| `<try>` with `<@placeholder>` | A placeholder needs a second render pass |
| `<return>` inside `<if>`, `<for>` or any other tag | It declares the value the whole unit returns, so it must be at the top level of its template. At the top level it compiles, in a tag and in a page alike: `render(input, out)` returns the value, which is what `/var` reads; the output goes to the sink |
| `<let/input=…>`, `<const/input=…>` | Shadows the render function's own `input` parameter, making the template's input unreachable. A **tag param** named `input` (`<for|input|>`) is fine — that opens a nested scope, which is an ordinary JS shadow |
| A capitalized tag with no matching binding | No HTML element is capitalized, so this is a missing import rather than an element |
| `class:foo`, `style:foo` | Not Marko syntax at all — see [Errors](/language/errors/) |

## Events

An element's `on<Name>=fn` (`onClick`, `onDblClick`) or `on-<exact>=fn`
(`on-my-event`) is an event handler — and this target has nowhere to bind one:
`@mxlang/html` renders once to a string, so an expression-valued event
attribute is a compile error naming the attribute and the target.

- **Static strings** (`onclick="alert(1)"`) are an ordinary attribute and
  pass through verbatim; MX does not invent a policy against inline handler
  strings — it only stops creating one from a function. A *bare* `onClick`
  is HTML's spelling of `true` and renders as the boolean attribute.
- **`on:` / `oncapture:`** are rejected with a fix-it naming `on-<exact>`:
  `on:click=fn` → `onClick=fn` (or `on-click=fn` for a custom name).
- On a **component** (a `<define>` or an imported template), an `on*`
  attribute is an ordinary prop, never an event.

## `<try>`

A `<try>` with `<@catch>` lowers to a real `try`/`catch`, with the body rendered into a buffered sub-sink:

```html
<try>
  <p>${input.risky()}</p>
  <@catch|err|><p>failed: ${err.message}</p></@catch>
</try>
```

compiles to:

```typescript
function __mxRender(input: Input, __mxOut: __MxOut): void {
  const __mxTry0 = __mxCreateBufferedOut(__mxOut);
  try {
    __mxTry0.write("<p>");
    __mxTry0.write(__mxEscape(input.risky()));
    __mxTry0.write("</p>");
    __mxTry0.commit();
  } catch (err) {
    __mxOut.write("<p>failed: ");
    __mxOut.write(__mxEscape(err.message));
    __mxOut.write("</p>");
  }
}
```

The body's output reaches the page only when the body finishes. When it throws, the partial output is dropped and the `catch` branch renders in its place, as Marko 6.4.4 does (before decision 155 this target kept the partial output). A `<try>` with neither `<@catch>` nor `<@placeholder>` is a compile error, as in Marko 6.4 (it would have no effect; Marko 6.3.51 rethrew from it at render time). A `<try>` carrying `<@placeholder>` is a compile error: showing a placeholder and then replacing it needs a second pass this target does not have.

## Structured `class` and `style`

`class` and `style` take structured values, lowered through the emitted helpers:

| Written | Renders |
|---|---|
| `class={a: true, b: false}` | `class="a"` |
| `class=["x", {y: true}]` | `class="x y"` |
| `style={color: "red", top: 0}` | `style="color:red;top:0"` |

One ordering detail is load-bearing: Marko hoists `value` first on `<input>`, so `<input type="text" value=x>` emits `value` before `type`. A browser applies `type` before `value`, and some input types reinterpret a later `value`. This target reproduces that order, and the parity oracle compares attribute order, so getting it wrong fails the run.

## Parity with Marko

`bun run oracle:marko` renders every fixture in the stock set two ways — through the real Marko 6 toolchain, and through this target — and compares both against the expected HTML for semantic equality. Current state: **43 fixtures, 41 pass, 2 reasoned skips, 0 translator bugs.** Fixture expectations are generated from real Marko, never hand-written.

## Examples

- `examples/mx-site` — a Hono-on-Bun server and a static build, both rendering `.mx` templates through the Bun loader, no prebuild step.
- `examples/mx-vite` — the same templates through the Vite plugin instead.
