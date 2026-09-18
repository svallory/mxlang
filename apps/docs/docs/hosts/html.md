---
title: "HTML host"
description: "Compile .mx and .marko templates to a plain (input) => string function, no runtime beyond an escape helper."
---

# HTML host

The HTML host (`@mxlang/html`) is the vanilla MX host. It compiles an `.mx` file (or its `.marko` alias) to a pure function: a JS/TS module whose default export is `(input) => string`, with no runtime beyond an `escape` helper. No scheduler, no signals, no hydration, no resume markers.

The generic half of the work — consuming Marko's AST, applying the structural lowerings, the string-emit model — lives in the shared core. This host supplies the policy on top of it: which tags are inert and which are compile errors, component-versus-element resolution, structured `class`/`style` values, and its own integrations (a Bun loader, the `escape` runtime, a taglib).

Because MX 1.0 is a strict subset of Marko syntax, this host compiles **stock Marko**, not a dialect: tag discovery through taglibs and `tags/` directories, Marko's own HTML/SVG/MathML element registry, Marko's attribute-tag and component conventions. A template written for Marko compiles here unchanged and renders the same bytes Marko's own server render produces.

```html
<!-- greeting.mx -->
<h1 class={greeting: true}>Hello, ${input.name}!</h1>
```

compiles to:

```typescript
import { escape } from "@mxlang/html";

export interface Input {}

function Greeting(input: Input): string {
  let out = "";
  out += "<h1";
  {
    const value = classValue({ greeting: true });
    if (value !== "") out += " class=\"" + value + "\"";
  }
  out += ">Hello, ";
  out += escape(input.name);
  out += "!</h1>";
  return out;
}
Object.defineProperty(Greeting, Symbol.for("mx.component"), { value: true });

export default Greeting;
```

The default export is a **named** declaration, after the file (`greeting.mx` gives `Greeting`, `table-of.mx` gives `TableOf`), and carries a `Symbol.for("mx.component")` brand. The name is derived, never authored — and it is what lets a tag call itself with no self-import. The brand is what lets a host that receives a compiled module as an opaque value — the Astro renderer, for one — recognize it as an MX component without sniffing the function's name. `classValue` is one of four helpers (`classValue`, `styleValue`, `escapeComment`, `renderDynamic`) appended to the module only when the template actually calls them; a template using none of them compiles to `escape` and string concatenation alone.

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
- `escape(value)` — the entire runtime the emitted module imports
- `TranslateError` — thrown for a construct with no lowering, carrying `line`/`column`

The package is also a plain `@marko/compiler` translator, so the compiler's own entry points work directly:

```typescript
import { compileSync } from "@marko/compiler";
import translator from "@mxlang/html";

compileSync(source, filename, { translator, output: "html" });
```

## Loaders

Two loaders make `import page from "./page.mx"` (or `"./page.marko"`) resolve, one per runtime.

**Bun** — `@mxlang/html/bun` is a plugin that intercepts `.mx` and `.marko` imports and compiles them on the fly (`.solid.mx` is excluded; that is a different file kind handled separately). Register it once:

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

By default this host renders what Marko's own server render would emit for the stateful tags (`<let>`'s initial value, `<effect>`/`<lifecycle>`/`<script>`/`client` blocks/`<id>` as inert — contributing no output). Passing `{ strict: true }` switches to a stricter policy that rejects those same constructs as compile errors instead, for a template that has no business needing a reactive runtime:

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
| `<return>` | Hands a value to a parent template; a module compiled to `(input) => string` has no parent |
| `<let/input=…>`, `<const/input=…>` | Shadows the render function's own `input` parameter, making the template's input unreachable. A **tag param** named `input` (`<for|input|>`) is fine — that opens a nested scope, which is an ordinary JS shadow |
| A capitalized tag with no matching binding | No HTML element is capitalized, so this is a missing import rather than an element |
| `class:foo`, `style:foo` | Not Marko syntax at all — see [Errors](/language/errors/) |

## Events

An element's `on<Name>=fn` (`onClick`, `onDblClick`) or `on-<exact>=fn`
(`on-my-event`) is an event handler — and this host has nowhere to bind one:
`@mxlang/html` renders once to a string, so an expression-valued event
attribute is a compile error naming the attribute and the host.

- **Static strings** (`onclick="alert(1)"`) are an ordinary attribute and
  pass through verbatim; MX does not invent a policy against inline handler
  strings — it only stops creating one from a function. A *bare* `onClick`
  is HTML's spelling of `true` and renders as the boolean attribute.
- **`on:` / `oncapture:`** are rejected with a fix-it naming `on-<exact>`:
  `on:click=fn` → `onClick=fn` (or `on-click=fn` for a custom name).
- On a **component** (a `<define>` or an imported template), an `on*`
  attribute is an ordinary prop, never an event.

## `<try>`

A `<try>` with `<@catch>` lowers to a real `try`/`catch` around the block's output:

```html
<try>
  <p>${input.risky()}</p>
  <@catch|err|><p>failed: ${err.message}</p></@catch>
</try>
```

compiles to:

```typescript
function Risky(input: Input): string {
  let out = "";
  try {
    out += "<p>";
    out += escape(input.risky());
    out += "</p>";
  } catch (err) {
    out += "<p>failed: ";
    out += escape(err.message);
    out += "</p>";
  }
  return out;
}
```

Output already appended before the throw stays appended — the `catch` branch continues from there rather than discarding it, which is what a single-pass string builder can do. A `<try>` carrying `<@placeholder>` is a compile error: showing a placeholder and then replacing it needs a second pass this target does not have.

## Structured `class` and `style`

`class` and `style` take structured values, lowered through the emitted helpers:

| Written | Renders |
|---|---|
| `class={a: true, b: false}` | `class="a"` |
| `class=["x", {y: true}]` | `class="x y"` |
| `style={color: "red", top: 0}` | `style="color:red;top:0"` |

One ordering detail is load-bearing: Marko hoists `value` first on `<input>`, so `<input type="text" value=x>` emits `value` before `type`. A browser applies `type` before `value`, and some input types reinterpret a later `value`. This host reproduces that order, and the parity oracle compares attribute order, so getting it wrong fails the run.

## Parity with Marko

`bun run oracle:marko` renders every fixture in the stock set two ways — through the real Marko 6 toolchain, and through this host — and compares both against the expected HTML for semantic equality. Current state: **43 fixtures, 41 pass, 2 reasoned skips, 0 translator bugs.** Fixture expectations are generated from real Marko, never hand-written.

## Examples

- `examples/mx-site` — a Hono-on-Bun server and a static build, both rendering `.mx` templates through the Bun loader, no prebuild step.
- `examples/mx-vite` — the same templates through the Vite plugin instead.
