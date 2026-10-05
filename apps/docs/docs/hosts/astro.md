---
title: "Astro host"
description: "Render .mx components and pages, and .astro.mx templates, to static markup inside an Astro project — no islands, no client JS."
---

# Astro host

An Astro component with MX in place of the template. An `.astro.mx` file is an Astro component: the `---` frontmatter fence, `Astro.props`, imports and `getStaticPaths` pass through untouched with ordinary Astro semantics, and Astro's own compiler still builds the component. MX replaces only the markup after the fence, which it lowers to Astro template syntax. Astro renders at build time, so the example has no event handler.

Plain `.mx` files on this host are a different thing, described [below](#mx-components): a runtime-free function that Astro's renderer calls, not an Astro component.

```astro title="Greeter.astro"
---
export interface Props {
  label: string;
  names: { id: number; text: string }[];
}
const { label, names } = Astro.props as Props;
---
<section>
  <h1>{label}</h1>
  {names.length > 2 && <p>That is plenty.</p>}
  <ul>
    {names.map((name) => <li>{name.text}</li>)}
  </ul>
</section>
```

```mx title="Greeter.astro.mx"
---
export interface Props {
  label: string;
  names: { id: number; text: string }[];
}
const { label, names } = Astro.props as Props;
---
<section>
  <h1>${label}</h1>
  <if=(names.length > 2)><p>That is plenty.</p></if>
  <ul>
    <for|name| of=names><li>${name.text}</li></for>
  </ul>
</section>
```

`@mxlang/astro` renders `.mx` components inside an Astro project as static markup at build time. An MX component compiles to a runtime-free `(input) => string` function, is called during Astro's build, and never reaches a browser. No islands, no hydration, no client JavaScript from this renderer.

## Selecting the host

`mx.host: "astro"` selects `astro-html`; `mx.target: "astro-html"` alone
selects Astro behaviour too. The target uses Astro's strict policy in the
editor and `mx-tsc`. If both keys are given, the target must belong to Astro;
disagreement is a positioned `target-host-mismatch` error (decisions 129/132;
[spec §13.5](/specification/#135-host-and-target-selection)). `.astro.mx`
remains its own extension-selected template pipeline, not an `mx.target` name.

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

Astro exposes each named-slot payload as a `() => string` thunk. A declared
`as: "renderable"` property receives that thunk directly; the default data
shape exposes the same thunk as `.content`. This is projection, not a general
value channel: arrays/repeats/loops, authored attrs, params, nested tags, and
bodiless `<@name/>` are positioned compile errors. Mutually exclusive
`<if>` branches are supported because only the selected slot renders. Import
the specialized type from `@mxlang/astro`; see
[AttrTag](/language/attr-tag/) for the complete contract.

**Supported**: the structural core — `<if>`/`<else if>`/`<else>`, every `<for>` form, singular attribute-tag projections, generic tag params where the target can express them, `<define>`, `<const>`, `static`, `import` — props, slots, and one MX component calling another.

**Not supported**: the stateful tags — `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client` blocks, `<id>` — are compile errors naming the construct. This host has no reactive target at all: it renders once, at build time, so a construct that only means something with a runtime is a build error rather than markup that silently renders once and never updates. This is a stricter policy than the html target's own default, and it applies unconditionally here, not behind a flag.

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

## `.astro.mx` templates

An `.astro.mx` file is an Astro component whose template is written in MX instead of JSX. This is a different kind of file from `.mx`: a `.mx` component compiles to a runtime-free function and is *called through* this host's renderer, while an `.astro.mx` component *is* an Astro component, with MX writing only its template. Its `---` frontmatter fence passes through untouched, with ordinary Astro semantics — `Astro.props`, imports, `getStaticPaths` — and only the markup after the fence is MX.

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

`.astro.mx` is for components and layouts. **A page cannot be `.astro.mx`**: Astro strips only the last extension of a route file, so `src/pages/about.astro.mx` would route to `/about.astro`, not `/about`. The integration reports every `.astro.mx` file under `src/pages` as an error, in `astro dev` and `astro build` (decision 134, addendum). Write `about.astro` and import the `.astro.mx` component from it, or write the page as `about.mx`.

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
| `<html-comment>text ${expr}</html-comment>` | a real `<!--…-->`, as Marko renders it (see below) |
| `<textarea value=expr/>` | `<textarea>{content}</textarea>` (see below) |
| Several root elements | several root elements |

The `---` fence passes through byte for byte, with Astro's own semantics: `Astro.props`, imports, and `getStaticPaths` all work exactly as they do in a `.astro` file. `static` statements from the MX template are hoisted into that fence.

### `<html-comment>` and `<textarea value>`

`<html-comment>` renders a real `<!-- -->` comment, not a literal `<html-comment>` element. It takes text and placeholders only. Like Marko, it escapes only `>` (as `&gt;`, so a value cannot close the comment early), renders `null`, `undefined`, `false` and `""` as nothing but keeps `0`, and writes `<!-- -->` when the comment holds only placeholders that all render empty. A placeholder that would render as `[object Object]` throws, as Marko's debug build does (optimized Marko prints `[object Object]`). A nested `<!-- -->` stays in the comment as text, with its `>` escaped. `<!-- -->` written directly in the template is a different thing: it is kept as written.

`<textarea value=expr/>` renders the value as the textarea's escaped content, never as a `value` attribute, as Marko does. `null`, `undefined`, `false` and `true` render nothing, `0` is kept, and a leading newline is doubled so the HTML parser's dropped first newline restores it. A spread's `value` is read the same way, the later of an explicit `value` and a spread's wins, and a spread's `value` yields to a body. A `value` together with a body is a build error, as in Marko.

### Not supported

Nothing silently degrades: every construct this target cannot express is a build error naming the construct, the reason, and the line.

- Stateful tags — same stance as `.mx` under this host: static markup at build time, no reactive runtime.
- `<await>` — needs a suspense-capable renderer.
- `<return>` — hands a value to a parent template; an Astro component has none.
- `<const>` — declare the value in the `---` fence instead.
- `<define>` — Astro has no local component form; extract it into its own `.astro.mx` file.
- `<try>` — needs an error boundary; Astro renders statically.
- Tag params, and attribute-tag params — these lower to a render prop, and Astro passes markup through slots, not functions.
- Attribute tags on a plain HTML element — named slots exist only on a component.
- Attribute methods (`onClick() { … }`) — an event handler needs a runtime.
- Expression-valued event attributes (`onClick=fn`, `on-my-event=fn`) — same reason: `.astro.mx` renders static markup at build time and has no runtime to bind a handler to. A *string*-valued `onclick="alert(1)"` is an ordinary static attribute and passes through verbatim; MX does not invent a policy against inline handler strings.
- `:=` — a two-way binding needs a reactive runtime.
- A dynamic tag name (`<${expr}>`) — Astro resolves component names statically.

## Events

The event rule is the MX-wide one — an element's `on<Name>` lowercases to the
DOM event name, `on-<exact>` is verbatim — but on this host every
expression-valued form is a compile error: an event handler requires a
runtime, and an `.astro.mx` template renders static markup at build time. The
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

Do not also list `@astrojs/ts-plugin`: a second Volar tsserver plugin is silently skipped, so adding it would disable this one. `astro: true` composes Astro's own language plugin, which is what also type-checks `.astro.mx` itself; without it, `.astro.mx` files are ignored.

Command-line checks use `mx-tsc --astro --noEmit`, not `tsc --noEmit` — `tsc` ignores `compilerOptions.plugins` entirely, so a plain `tsc` run would miss every error inside an MX file.

There is deliberately no ambient `declare module "*.mx"` shim. A shim asserts one generic `(input: any) => string` shape for every file, which hides both each component's real props and every error inside it.

## Example

`examples/astro-static` is a full static Astro site built on this host: `.mx` components with props and named slots, `.mx` pages with `getStaticPaths` and a layout, an `.astro.mx` template, and an e2e suite that asserts no page contains a `<script>` — the host's whole claim. It also asserts the two builds that *must* fail: `<let>` in a component, and `client:load` on one.
