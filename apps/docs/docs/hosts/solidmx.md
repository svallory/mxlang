---
title: "SolidMX"
description: "The .solid.mx host — MX markup in JSX's position inside a Solid component file, lowered to Solid 2 JSX."
---

# SolidMX

SolidMX (`.solid.mx`) is MX markup written directly inside a Solid component file, in the same position JSX would go, lowered to Solid's own JSX at compile time. A `.solid.mx` file is otherwise an ordinary TypeScript module — imports, functions, hooks — with MX markup wherever an expression is expected.

SolidMX ships as `@mxlang/solid`, the third emitter over `@mxlang/core`'s shared IR alongside the HTML and Astro hosts. The MX parser's vendored Babel fork finds each MX region inside a `.solid.mx` file and hands it to `compileSolidMx`, which resolves the region through the same Marko-syntax core every host shares and emits Solid JSX text back into the surrounding TypeScript module, at the same span — so positions and source maps stay anchored to the original file.

## Install

```bash
bun add -d @mxlang/vite-plugin
```

`.solid.mx` compiles through the Vite plugin, which must come before Solid's own plugin — both are `enforce: "pre"`, so array order decides:

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import mx from "@mxlang/vite-plugin";
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [mx(), solid()],
});
```

Type-checking uses `mx-tsc --noEmit` rather than `tsc --noEmit`: `tsc` ignores `compilerOptions.plugins`, so a plain `tsc` run would silently miss every error inside a `.solid.mx` file. This host targets **Solid 2 only**.

## The idea

Two rules make MX markup work naturally inside Solid, both applying to any tag, not only Solid's built-in control-flow components:

**Tag params turn children into a function.** `<Tag|p1, p2|>body</Tag>` lowers to `<Tag>{(p1, p2) => body}</Tag>`. This is what lets Solid's own render-prop components be called directly from MX markup:

```html
<For|item, i| each=xs()>
  <li>${i}: ${item}</li>
</For>

<Show|user| when=user()>
  <p>Hello, ${user.name}</p>
</Show>
```

**Attribute tags become props.** `<@name>body</@name>` inside any tag becomes `name={body}` on the parent; `<@name|p|>body</@name>` becomes `name={(p) => body}`.

## `<for>` lowering

Every `<for>` form lowers to one of Solid's own iteration primitives:

| Written | Lowers to |
|---|---|
| `<for\|item, i\| of=xs()>` | `<For each={xs()} keyed={false}>{(item, i) => body}</For>` |
| `<for\|item, i\| of=xs() by="id">` | `<For each={xs()} keyed={x => x.id}>{(item, i) => body}</For>` |
| `<for\|k, v\| in=obj()>` | `<For each={Object.entries(obj())} keyed={e => e[0]}>{([k, v]) => body}</For>` |
| `<for\|i\| from=a to=b>` | `<Repeat count={(b) - (a) + 1} from={a}>{(i) => body}</Repeat>` |
| `<for\|i\| from=a until=b>` | `<Repeat count={(b) - (a)}>{(i) => body}</Repeat>` |
| `<for\|i\| from=a to=b step=s>` | `<Repeat count={N}>{(mxIndex) => { const i = (a) + mxIndex * (s); return body; }}</Repeat>` |

`from=`/`to=`/`until=`/`step=` follow the same read-once-per-access discipline as any other Solid JSX attribute — keep them pure (a signal, a literal, or a memo). With `step=` present they are each re-read once per row rather than once for the whole range, and the row count is clamped through `Number.isFinite(...) ? Math.max(0, ...) : 0` when the bounds are not fully literal — so a runtime `step` of `0` renders zero rows instead of looping forever.

## Everything else

| Written | Lowers to |
|---|---|
| `text`, `${expr}` | literal text, `{expr}` |
| `$!{expr}` | `innerHTML={expr}`; must be the sole child |
| An HTML/SVG/MathML element | a JSX element; void elements self-close |
| A component | a JSX element, attribute tags as render props, tag params as the child callback |
| `.cls` / `#id` shorthand | folds into `class="…"` / `id="…"`; with an object `class={...}` it merges to `class={["cls", {...}]}` |
| `prop:name=value` | kept as `prop:name={value}` |
| `<if>` / `<else>`, 1–2 conditioned branches | `<Show when fallback>` |
| `<if>` / `<else>`, 3+ conditioned branches | `<Switch fallback><Match when>…</Match></Switch>` |
| `<try>` | `<Loading fallback>` wrapped in `<Errored fallback>` when `<@catch>` is present |

```html
<try>
  <p>${body()}</p>
  <@placeholder><p>loading</p></@placeholder>
  <@catch|err|><p>${err.message}</p></@catch>
</try>
```

```tsx
<Errored fallback={(err) => <p>{err.message}</p>}>
  <Loading fallback={<p>loading</p>}><p>{body()}</p></Loading>
</Errored>
```

The builtins (`For`, `Show`, `Switch`, `Match`, `Loading`, `Errored`, `Repeat`, and the rest) are auto-imported by Solid's own compilers, so nothing here adds an import of its own.

## Events

An element's `on<Name>=fn` (`onClick`, `onDblClick`) or `on-<exact>=fn`
(`on-my-event`) is an event handler. MX derives the **DOM event name** —
everything after `on` lowercased, or the exact text after `on-` — and this
host emits Solid's prop recomposed from it: `on` plus the capitalized DOM
name. `onClick=f` → `onClick={f}`; `onDblClick=f` and `on-dblclick=f` both
→ `onDblclick={f}` (Solid derives the event name from the prop, so it binds `dblclick`).

- **No aliases.** `onDoubleClick` lowercases to `doubleclick`, which is not
  a DOM event: the compiler warns at the attribute and emits
  `onDoubleclick={f}` exactly as written — never silently `onDblClick`.
- **Custom DOM events** (`on-my-event=f`) are a compile error: Solid has no
  custom-event prop. The error names the escape hatch Solid's own docs give
  for listener options — a `ref` callback calling
  `addEventListener("my-event", fn)`.
- **Static strings** (`onClick="alert(1)"`) are an ordinary attribute and
  pass through verbatim; MX does not invent a policy against inline handler
  strings — it only stops creating one from a function.
- **`on:` / `oncapture:`** keep their removed-in-Solid-2 rejection, with a
  fix-it naming `on-<exact>`: `on:click=fn` → `onClick=fn` (or `on-click=fn`
  for a custom name).
- On a **component**, an `on*` attribute is an ordinary prop (`<Row
  onSelect=pick/>` passes the callback), never an event.

The handler receives the DOM event, as Solid always delivers it.

## Errors

**Stateful tags.** `<let>`, `<effect>`, `<lifecycle>`, `<script>` and `:=` are compile errors, each naming Solid's own primitive instead — `createSignal`, `createEffect`, the lifecycle primitives, an explicit event handler. State is framework territory, and in a `.solid.mx` file it belongs in the surrounding TypeScript module, which is a real place to put it.

**Removed Solid 2 namespaces.** `on:`, `oncapture:`, `attr:`, `bool:` and `use:` are gone from Solid 2, so each is rejected with its replacement in the message: `on:x=fn` → `onX=fn` or `on-x=fn` for a custom event name, `oncapture:` → `onX=fn` (capture needs a `ref` callback with `{ capture: true }`), `attr:`/`bool:` → the plain attribute, `use:foo=opts` → `ref=foo(opts)`. Only `prop:` survives.

**Wrong scope.** `<define>`, `<const>`, hoisted statements and `<!doctype html>` inside a JSX expression are errors: a `.solid.mx` file is already a TypeScript module, and that is where they belong.

**Not MX 1 at all.** `<if|u|=cond>` (tag params on `<if>`), tag params and `<@name>` attribute tags on native HTML elements, and a `<fragment>` wrapper are rejected by real Marko itself, so the subset rule excludes them. Each is recorded with Marko's exact error in [Divergences & MX 2](/divergences-and-mx-2/). For a fragment wrapper, use a TSX fragment `<>…</>`.

## Verification

`bun run oracle` compiles every fixture two ways — MX, and a hand-written Solid twin — across both Solid 2 backends (the Babel plugin and the native Oxc compiler) and both generate variants, then compares the generated code. Five fixtures × two backends × two variants: **20 rows, all passing.** `bun run oracle -- --strict` is expected to exit 0 too; a skip or a pending fixture fails the run rather than passing quietly.

## Examples

- `examples/counter-app` — a small Solid 2 app whose components are `.solid.mx`.
- `examples/todomvc` — the full TodoMVC spec in MX: hash-routed filters, localStorage persistence, edit-in-place.
