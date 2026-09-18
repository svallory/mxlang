---
title: "Astro host"
description: "Render .mx components and pages, and .amx templates, to static markup inside an Astro project — no islands, no client JS."
---

# Astro host

`@mxlang/astro` renders `.mx` components inside an Astro project as static markup at build time. An MX component compiles to a runtime-free `(input) => string` function, is called during Astro's build, and never reaches a browser. No islands, no hydration, no client JavaScript from this renderer.

## Install

```bash
bun add -d @mxlang/astro
```

```javascript
// astro.config.mjs
import { defineConfig } from "astro/config";
import mx from "@mxlang/astro";

export default defineConfig({
  integrations: [mx()],
});
```

That is the whole setup. The integration registers a renderer and adds MX's own Vite plugin, which already turns a `.mx` file into a plain module.

## `.mx` components

```astro
---
import Card from "../components/card.mx";
---

<Card title="Hello">
  <p>Default slot content.</p>
  <Fragment slot="footer">Footer content.</Fragment>
</Card>
```

```html
<!-- card.mx -->
<article class="card">
  <h2>${input.title}</h2>
  <div>$!{input.content()}</div>
  <if=input.footer>
    <footer>$!{input.footer()}</footer>
  </if>
</article>
```

Astro hands a renderer its slots as already-rendered HTML strings, and MX's compiled modules take children and attribute tags as `() => string` thunks. The mapping is one line: each slot string is wrapped in a thunk that returns it.

| Astro | MX |
| --- | --- |
| the default slot | the `content` prop |
| `<Fragment slot="footer">` | the `footer` prop, set by `<@footer>` |
| a prop | a prop, unchanged |

Render slot content with `$!{...}`, never `${...}` — the slot is markup Astro has already rendered, and `${...}` would escape it into visible angle brackets.

One real limitation follows from slots being plain strings: an attribute tag declaring params, like `<@footer|year|>`, compiles to a `footer: (year) => string` a caller can invoke with an argument — but a slot from Astro is already rendered, with nothing left to pass a value into. Astro's slot contract has no channel for this, so it is documented rather than fixed: the renderer receives a compiled function, not the template that declared the params.

**Supported**: the structural core — `<if>`/`<else if>`/`<else>`, every `<for>` form, attribute tags, tag params, `<define>`, `<const>`, `static`, `import` — props, slots, and one MX component calling another.

**Not supported**: the stateful tags — `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client` blocks, `<id>` — are compile errors naming the construct. This host has no reactive target at all: it renders once, at build time, so a construct that only means something with a runtime is a build error rather than markup that silently renders once and never updates. This is a stricter policy than the HTML host's own default, and it applies unconditionally here, not behind a flag.

`client:*` directives on an MX component fail the build, naming the component:

```
`Card` is an MX component and renders statically: remove the `client:load`
directive. MX compiles to a plain function with no state and no runtime, so
there is nothing to hydrate on the client.
```

## `.mx` pages

An `.mx` file directly under `src/pages` is a page, not a component — `src/pages/about.mx` routes to `/about` the way `about.astro` would. `.marko` is not registered as a page extension; it stays a component-only alias.

```html
<!-- src/pages/hello.mx -->
export const layout = "../layouts/Base.astro";
export const title = "Hello";

static const items = ["one", "two"];

<h1>${title}</h1>
<ul>
  <for|item, i| of=items>
    <li>${i}: ${item}</li>
  </for>
</ul>
```

Inside a page, `input` is `{ ...props, params, url }` — the page's own Astro props, plus `Astro.params` and `Astro.url` merged in under those names. A dynamic route reads `input.params.slug` the same way a `.astro` page reads `Astro.params.slug`.

`export const layout = "../layouts/Base.astro";` wraps the page's rendered HTML in that layout's default slot. Every other top-level `export const NAME = ...` the page declares becomes a `frontmatter` key passed to the layout — the same convention Astro uses for Markdown pages. Without `layout`, the rendered HTML is used as-is.

Named exports pass straight through: `getStaticPaths`, `prerender`, and any other top-level `export` reach Astro's router unchanged, exactly as they would in a `.astro` file.

```html
<!-- src/pages/posts/[slug].mx -->
export const getStaticPaths = () => [
  { params: { slug: "first" }, props: { title: "First post" } },
  { params: { slug: "second" }, props: { title: "Second post" } },
];

export const prerender = true;

<h1>${input.title}</h1>
```

Pages compile under the same strict policy as components, and have no `Astro.slots` — nothing renders a page inside another component's slot.

## `.amx` templates

An `.amx` file is an Astro component whose template is written in MX instead of JSX. This is a different kind of file from `.mx`: a `.mx` component compiles to a runtime-free function and is *called through* this host's renderer, while an `.amx` component *becomes* a real Astro component. Its `---` frontmatter fence passes through untouched, with ordinary Astro semantics — `Astro.props`, imports, `getStaticPaths` — and only the markup after the fence is MX.

```astro
---
export interface Props { title: string; members: string[] }
const { title, members } = Astro.props as Props;
---
<h1>${title}</h1>
<if=members.length>
  <ul>
    <for|member, i| of=members>
      <li>${i}: ${member}</li>
    </for>
  </ul>
</if>
<else>
  <p>Nobody here yet.</p>
</else>
```

Components, layouts and pages all come from this one extension — `src/pages/about.amx` routes to `/about`.

### Lowering

| MX | Astro |
| --- | --- |
| `${expr}` | `{expr}` |
| `$!{expr}` | `<Fragment set:html={expr} />` |
| `<if=c>` / `<else if=c>` / `<else>` | a ternary chain |
| `<for\|x\| of=xs>` | `{[...xs].map((x) => (…))}` |
| `<for\|k, v\| in=obj>` | `{Object.entries(obj).map(([k, v]) => (…))}` |
| `<for\|n\| from=a to=b>` | `{Array.from({length: …}, …).map(…)}` |
| `class={a: true}` / `class=[…]` | `class:list={…}` |
| `<@name>` on a component | `<Fragment slot="name">…</Fragment>` |
| `attr="static"` | unchanged |
| `attr=expr` | `attr={expr}` |
| `...obj` | `{...obj}` |
| Text containing `{` or `}` | escaped to `&#123;` / `&#125;` |
| Ordinary children of a component | the default slot |
| HTML comments | HTML comments |
| Several root elements | several root elements |

The `---` fence passes through byte for byte, with Astro's own semantics: `Astro.props`, imports, and `getStaticPaths` all work exactly as they do in a `.astro` file. `static` statements from the MX template are hoisted into that fence.

### Not supported

Nothing silently degrades: every construct this target cannot express is a build error naming the construct, the reason, and the line.

- Stateful tags — same stance as `.mx` under this host: static markup at build time, no reactive runtime.
- `<await>` — needs a suspense-capable renderer.
- `<return>` — hands a value to a parent template; an Astro component has none.
- `<const>` — declare the value in the `---` fence instead.
- `<define>` — Astro has no local component form; extract it into its own `.amx` file.
- `<try>` — needs an error boundary; Astro renders statically.
- Tag params, and attribute-tag params — these lower to a render prop, and Astro passes markup through slots, not functions.
- Attribute tags on a plain HTML element — named slots exist only on a component.
- Attribute methods (`onClick() { … }`) — an event handler needs a runtime.
- Expression-valued event attributes (`onClick=fn`, `on-my-event=fn`) — same reason: `.amx` renders static markup at build time and has no runtime to bind a handler to. A *string*-valued `onclick="alert(1)"` is an ordinary static attribute and passes through verbatim; MX does not invent a policy against inline handler strings.
- `:=` — a two-way binding needs a reactive runtime.
- A dynamic tag name (`<${expr}>`) — Astro resolves component names statically.

## Events

The event rule is the MX-wide one — an element's `on<Name>` lowercases to the
DOM event name, `on-<exact>` is verbatim — but on this host every
expression-valued form is a compile error: an event handler requires a
runtime, and an `.amx` template renders static markup at build time. The
error names the attribute and the host. `on:` / `oncapture:` are rejected
with a fix-it naming `on-<exact>`; a string-valued `onclick="…"` stays an
ordinary attribute; an `on*` attribute on a component is an ordinary prop.

## Typing `.mx` imports

Each `.mx` file gets **its own** `Input` type, derived from the file, through the TypeScript plugin. Add one Volar plugin entry to `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "plugins": [
      { "name": "@mxlang/typescript-plugin", "astro": true }
    ]
  }
}
```

Do not also list `@astrojs/ts-plugin`: a second Volar tsserver plugin is silently skipped, so adding it would disable this one. `astro: true` composes Astro's own language plugin, which is what also type-checks `.amx` itself; without it, `.amx` files are ignored.

Command-line checks use `mx-tsc --astro --noEmit`, not `tsc --noEmit` — `tsc` ignores `compilerOptions.plugins` entirely, so a plain `tsc` run would miss every error inside an MX file.

There is deliberately no ambient `declare module "*.mx"` shim. A shim asserts one generic `(input: any) => string` shape for every file, which hides both each component's real props and every error inside it.

## Example

`examples/astro-static` is a full static Astro site built on this host: `.mx` components with props and named slots, `.mx` pages with `getStaticPaths` and a layout, an `.amx` template, and an e2e suite that asserts no page contains a `<script>` — the host's whole claim. It also asserts the two builds that *must* fail: `<let>` in a component, and `client:load` on one.
