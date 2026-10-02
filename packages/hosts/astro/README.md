# @mxlang/astro

MX (Markup eXtended) is a template language born from Marko: it takes Marko's
syntax and brings it to wherever JSX lives today, MX 1.0 being a strict subset
of Marko so every borrowed Marko tool keeps working. `.mx` is MX's only
extension — MX supports only the MX 1.0 subset of Marko syntax, so a real
`.marko` file is not treated as MX; porting a Marko component that stays
within the subset is a rename.

`@mxlang/astro` is **the Astro host**: it renders `.mx` components inside an
Astro project as static markup at build time. An MX component compiles to a
runtime-free `(input) => string` function ([`@mxlang/html`](../translator/README.md)),
is called during Astro's build, and never reaches a browser. No islands, no
hydration, no client JS from this renderer.

Project [custom tags](../../../apps/docs/docs/custom-tags/index.md) are
discovered and expanded to ordinary IR before Astro emission, using the same
definitions as the other hosts.

## Install

```
bun add -d @mxlang/astro
```

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import mx from "@mxlang/astro";

export default defineConfig({
  integrations: [mx()],
});
```

That is the whole setup. The integration registers a renderer and adds MX's
existing Vite plugin (`@mxlang/vite-plugin`, unchanged — an Astro project is a
Vite project, and that plugin already turns a `.mx` file into a plain module).

```astro
---
import Card from "../components/card.mx";
---

<Card title="Hello">
  <p>Default slot content.</p>
  <Fragment slot="footer">Footer content.</Fragment>
</Card>
```

```mx
// card.mx
export interface Input {
  title: string;
  content: () => string;
  footer?: () => string;
}

<article class="card">
  <h2>${input.title}</h2>
  <div>$!{input.content()}</div>
  <if=input.footer>
    <footer>$!{input.footer()}</footer>
  </if>
</article>
```

## How slots map

Astro hands a renderer its slots as `Record<string, string>` of **already
rendered HTML**. MX's compiled modules take children and attribute tags as
`() => string` thunks. The mapping is therefore one line: each slot string is
wrapped in a thunk that returns it.

| Astro | MX |
| --- | --- |
| the default slot | the `content` prop (MX's name for ordinary children) |
| `<Fragment slot="footer">` | the `footer` prop — what `<@footer>` sets |
| a prop | a prop, unchanged |

Insert a slot with `$!{...}`, not `${...}`: the slot is markup Astro already
rendered, and `${...}` would escape it into visible angle brackets.

Two limits follow from slots being strings, both inherent to Astro's contract
rather than to MX:

- **Attribute-tag params get nothing.** A template writing `<@footer|year|>`
  compiles to a `footer: (year) => string` its caller invokes with an argument.
  A slot from Astro is already rendered, so the thunk ignores whatever it is
  handed. Astro has no channel for passing a value back into a slot, so this is
  documented rather than detected: the renderer receives a compiled function,
  not the template that declared the params.
- **Slot HTML is inserted verbatim.** Astro rendered it, so it is markup, not
  text to escape.

## What is and is not supported

**Supported**: MX's structural core — `<if>` / `<else if>` / `<else>`, every
`<for>` form, attribute tags, tag params, `<define>`, `<const>`, `static`,
`import` — props, slots, and one MX component calling another.

**Not supported, by design**: the stateful tags. `<let>`, `<effect>`,
`<lifecycle>`, `<script>`, `client` blocks, `<id>`, `<log>` and `<debug>` are
**compile errors** naming the construct. This host compiles MX under
`@mxlang/html`'s `strictPolicy`: it renders once, at build time, with no
reactive runtime anywhere, so a construct that only means something with a
runtime is a build error rather than markup that silently renders once and
never updates (decision 71 — stateful tags mean whatever the host says;
decision 111 adds `<log>`/`<debug>` as debug-only tooling rejected the same
way, rather than the default policy's inert disposition).

**`client:*` directives** on an MX component **fail the build**, naming the
component:

```
`Card` is an MX component and renders statically: remove the `client:load`
directive. MX compiles to a plain function with no state and no runtime, so
there is nothing to hydrate on the client.
```

This host raises that itself. Astro ships an error for exactly this case
(`NoClientEntrypoint`: *"component has a `client:` directive, but no client
entrypoint was provided by RENDERER_NAME"*) but never throws it — measured
against `astro@7.3.2`, the only occurrences in the installed package are the
message definition in `dist/core/errors/errors-data.js` and its `.d.ts`, and
the render path is a bare `if (renderer.clientEntrypoint)`
(`dist/runtime/server/hydration.js:98`) with no else branch. Left to Astro, the
build would succeed and ship an `<astro-island client="load">` whose loader
falls back to a no-op hydrator: an island that silently does nothing, on a host
whose whole claim is shipping no client JS.

So `renderToStaticMarkup` throws when Astro's `metadata.hydrate` is set.
`examples/astro-static/e2e/build-errors.spec.ts` asserts the failing build.

## Astro hooks dependency

This integration relies on Astro's undocumented and non-semver `addPageExtension` hook (passed to `astro:config:setup`) to register `.mx` and `.amx` as routable page extensions. Astro notes this hook is intended for internal integrations and may change outside of major versions. If an Astro update removes or changes this hook, pages under `src/pages` will stop routing, and the build will fail immediately with a clear error until the integration is updated.

## Pages

Decision 76b: an `.mx` file directly under `src/pages` is a **page**, not a
component. The integration calls Astro's `addPageExtension(".mx")`, so
`src/pages/about.mx` routes to `/about` the way `about.astro` would. `.marko`
is not an extension this integration registers at all, so a `.marko` file
anywhere in the project is simply not MX's.

```mx
// src/pages/hello.mx
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

**What `input` receives**: `{ ...props, params, url }` — the page's own
Astro props (from `getStaticPaths`'s `props`, or the parent route's props for
a nested page), plus `Astro.params` and `Astro.url` merged in under those
names. A dynamic route reads `input.params.slug` the same way a `.astro` page
reads `Astro.params.slug`.

**`layout`**: `export const layout = "../layouts/Base.astro";` in the page's
TypeScript section (a plain string literal; Marko allows a top-level
`export`, mirrored here for exactly this one purpose). When present, the
page's rendered HTML becomes the layout's default slot, and the layout
receives `{ frontmatter, url, params }` as props — `frontmatter` being every
other top-level `export const NAME = ...;` the page declares, mirroring
Markdown's own `layout` behaviour (`astro/dist/vite-plugin-markdown`: the
content becomes the layout's slot, frontmatter keys become
`Astro.props.frontmatter`). Without `layout`, the rendered HTML is used as-is
— the page writes its own `<html>` or composes through an ordinary MX
`content` prop.

**Named exports pass through.** `getStaticPaths`, `prerender`, and any other
top-level `export` in the page's TypeScript section reach Astro's router
unchanged — `@mxlang/core`'s `emitStatement` hoists any `export` (not only
`export interface Input`) to real module scope, so a dynamic route works the
same way it would in a `.astro` file:

```mx
// src/pages/posts/[slug].mx
export const getStaticPaths = () => [
  { params: { slug: "first" }, props: { title: "First post" } },
  { params: { slug: "second" }, props: { title: "Second post" } },
];

export const prerender = true;

<h1>${input.title}</h1>
```

**Strict policy applies here too.** A page compiles under the same
`strictPolicy` as components: `<let>` (and the rest of the stateful tags) in
a page is a build error naming the construct and the file, exactly as in a
component.

**Limits**: a page has no `Astro.slots` — nothing renders a page inside
another component's slot — and, like components, `client:*` on a page-mode
MX file fails the build for the same reason (nothing to hydrate).

## AstroMX templates (`.amx`)

Decisions 76c/78. An `.amx` file is an **Astro component whose template is
MX**: a TypeScript frontmatter fence with Astro's own semantics, followed by
an MX template instead of Astro's JSX-shaped markup. The template is lowered
to Astro template syntax and the whole file is handed to Astro's compiler, so
everything downstream — scoped styles, `Astro.props`, `getStaticPaths`,
source maps — is Astro's own.

```astro
---
// This half is untouched: ordinary Astro frontmatter.
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

This is a different file kind from `.mx`. An `.mx` component compiles to a
runtime-free `(input) => string` function and is called *through* this
package's renderer; an `.amx` component **becomes** an Astro component. Use
`.amx` when you want Astro's own component semantics with MX's syntax, and
`.mx` when you want a portable MX component that happens to render in Astro.

**Components, layouts and pages**, all from the one extension — `.amx` is
registered with `addPageExtension`, so `src/pages/about.amx` routes to
`/about`.

For TypeScript, enable Astro composition in `@mxlang/typescript-plugin` or run
`mx-tsc --astro`. The `.amx` emitter records source spans while it writes the
lowered Astro template; the TypeScript plugin composes those spans with
Astro's `convertToTSX` map, so frontmatter, prop, and interpolation diagnostics
land on the original `.amx` line and column. Without Astro mode, `.amx` is
deliberately ignored.

**Why the single dot.** The obvious spelling was `.astro.mx`, and it works for
components. It cannot work for pages: Astro's route collection keys on
`path.extname(basename)`, which returns only the **last** extension segment,
so `.astro.mx` can never be registered as a page extension. Measured against
`astro@7.3.2`, a `page.astro.mx` under `src/pages` is skipped entirely; and
once `.mx` is also registered, it is routed to `/page.astro/` — a literal
`.astro` in the URL. `.amx` has one segment, so every file kind works.

### The lowering table

| MX | Astro | Notes |
| --- | --- | --- |
| `${expr}` | `{expr}` | Astro escapes by default, as MX does |
| `$!{expr}` | `<Fragment set:html={expr} />` | the unescaped placeholder |
| text containing `{` or `}` | `&#123;` / `&#125;` | a literal brace would otherwise open an expression |
| `<if=c>` / `<else if=c>` / `<else>` | `{c ? (<Fragment>…</Fragment>) : …}` | a ternary chain; a chain with no `<else>` gets a `null` arm |
| `<for\|x\| of=xs>` | `{[...xs].map((x) => (…))}` | `<for\|x, i\|>` passes the index |
| `<for\|k, v\| in=obj>` | `{Object.entries(obj).map(([k, v]) => (…))}` | |
| `<for\|n\| from=a to=b>` | `{Array.from({length: …}, …).map(…)}` | `to=` inclusive, `until=` exclusive |
| `attr="static"` | `attr="static"` | unchanged |
| `attr=expr` | `attr={expr}` | |
| `...obj` | `{...obj}` | |
| `class={a: true}` / `class=[…]` | `class:list={…}` | Astro's own structured-class attribute |
| `<@name>` on a component | `<Fragment slot="name">…</Fragment>` | an attribute tag is a named slot; `<if>` branches emit a conditional slot |
| children | the default slot | |
| HTML comments | HTML comments | |
| several root elements | several root elements | Astro allows a fragment at top level |

### Errors

Nothing silently degrades: every construct this target cannot express is a
build error naming the construct, the reason, and the line in the `.amx` file.

- **Stateful tags** — `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client`
  blocks, `<id>`. Same stance as `.mx` under this host (decision 71): static
  markup at build time, no reactive runtime, so "this needs a runtime" is a
  build error rather than markup that renders once and never updates.
- **`<await>`** — needs a suspense-capable renderer.
- **`<return>`** — hands a value to a parent template; an Astro component has
  none.
- **`/var` on a returning tag called from the template** — structural, not a
  missing feature (ruled 2026-09-28, TODO `amx-tag-var`): Astro runs the
  `---` fence to completion before the template's tags are ever lowered or
  called, so there is no statement position left — in the fence (already
  finished) or the template (markup, not statements) — to bind a value into.
  Calling the same tag *without* `/var` already works: Astro's renderer
  unwraps its `{ value, output }` pair itself (`server.ts`). To use the
  bound value, call the unit directly from the fence's own TypeScript
  instead, where it is an ordinary function call:
  ```astro
  ---
  import Counter from "./tags/counter.mx";
  const { value } = Counter({ start: 1 });
  ---
  <p>{value}</p>
  ```
- **`<const>`** — a template expression cannot introduce a binding. Declare it
  in the `---` fence, which is where an Astro component declares values.
- **`<define>`** — Astro has no local component form. Extract it into its own
  `.amx` file and import it.
- **`<try>`** — needs an error boundary; Astro renders statically.
- **Tag params** (`<Comp|x|>`) — these lower to a render prop, and Astro
  passes markup through slots, not functions. The same applies to an attribute
  tag declaring params (`<@footer|year|>`).
- **Attribute tags on an HTML element** — named slots exist only on a
  component.
- **Array attribute tags, attributes on `<@name>`, nested attribute tags, and
  attribute-tag params** — a named slot is keyed by one name and carries only
  rendered markup. The host reports each as a positioned error.
- **A bodiless `<@name/>`** — a named slot projects the tag's body, so an empty
  self-closing tag has no observable content and is a positioned error.
- **Attribute methods** (`onClick() { … }`) — an event handler needs a
  runtime.
- **`:=`** — a two-way binding needs a reactive runtime.
- **A dynamic tag name** (`<${expr}>`) — Astro resolves component names
  statically.

`@mxlang/astro` exports `AttrTag<C>` for declarations. A named slot is a
callable `() => string`; the renderer also exposes that thunk as `.content`,
so the default data declaration and `as: "renderable"` are equivalent slot
views on this host. Slots never carry authored attribute data.

### Dev notes and known limits

**HMR works in `astro dev`.** The plugin gives Vite a virtual module id
(`Base.amx` → `Base.amx.astro`), and Vite keys its module graph by that
resolved id — a path that does not exist on disk. An edit to the real `.amx`
file would therefore match nothing in the graph, so the plugin carries a
`handleHotUpdate` hook mapping the changed file back to its virtual module and
invalidating it. Without that hook the dev server serves the previously
compiled output until a manual restart; `@mxlang/vite-plugin` carries the same
hook for `.solid.mx`/`.mx`, for the same reason.

**The fence ends at the first `---` line.** A `---` inside a string, template
literal or comment in the frontmatter closes the fence early, and the rest of
the intended TypeScript is then parsed as MX template. This is Astro's own
frontmatter behaviour, not an MX restriction — a `.astro` file splits the same
way — but it is worth knowing, because the resulting error points at the
template rather than at the stray `---`.

### How it works

`.amx` uses `@mxlang/core`'s fragment door, whose base-offset shifting places
every diagnostic after the frontmatter fence. The core resolves that Marko AST
into its host-independent IR, consulting Astro's `HostDeclarations` for
host-specific rejections, then drives this package's `Emitter<string>`. The
emitter sees IR kinds and resolved `DelegatedTag.data`, never Marko nodes. Module
statements such as `static` arrive in the IR's hoisted fields and are inserted
into the Astro fence; the template emitter produces the expression-shaped
ternaries, `.map` calls, attributes and slots below it.

The Vite mechanism is forced rather than chosen. Astro's `astro:build`
`transform` filters `include: [/\.astro$/, /\.astro\?/]` and then re-checks
`if (!parsedId.filename.endsWith(".astro")) return;`, so a transform on the
real `.amx` id can never reach Astro's compiler — the module id itself has to
end in `.astro`. `resolveId` appends that suffix to whatever Vite's own
resolver returns and `load` returns the lowered source, the same shape
`@mxlang/vite-plugin` already uses for `.solid.mx`.

## Typing `.mx` imports and `.amx` templates

Use `@mxlang/typescript-plugin`; it compiles each `.mx` file to a
virtual TypeScript module and derives component props from that file's real
`Input` interface. Because Astro and MX both use Volar, they must be composed
inside one tsserver plugin:

```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@mxlang/typescript-plugin", "astro": true }
    ]
  }
}
```

List only `@mxlang/typescript-plugin`; a separate `@astrojs/ts-plugin` entry is
silently skipped because two Volar tsserver plugins cannot decorate one
project. Enabling `astro: true` lazily loads the optional
`@astrojs/language-server@2.16.16` peer and composes its Astro language plugin.
It also enables `.amx` virtual TSX through the emitter-to-Astro source-map
composition; this format is not claimed when `astro` is omitted.

Do not add an ambient `declare module "*.mx"` shim or reference
`@mxlang/astro/types`. The old wildcard erased each component's real props and
has been removed. For command-line checks use `mx-tsc --astro --noEmit`, since
plain `tsc` does not load tsserver plugins.

## Example

`examples/astro-static` is an Astro site built from `.mx`: components (props,
a default slot, a named slot, one component composed from another) and pages
(a layout page with a `static`-block and
`<if>`/`<for>`, a page with no layout, and a dynamic `posts/[slug].mx` with
`getStaticPaths`). Its e2e suite asserts the rendered HTML for every page and,
separately, that both expected-to-fail builds fail for the right reason.

```
cd examples/astro-static
bun run build      # astro build -> dist/
bun run typecheck  # mx-tsc --astro --noEmit
bun run e2e        # headless Chromium over dist/, plus the two error builds
```
