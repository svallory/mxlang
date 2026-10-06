---
title: "Astro: .mx components and pages"
description: "Plain .mx files in an Astro project: components Astro renders through the MX integration, and pages under src/pages with layouts and getStaticPaths."
---

# Astro: `.mx` components and pages

Besides [`.astro.mx`](/hosts/astro/), the integration renders plain `.mx` files. They are a different kind of file: an `.astro.mx` *is* an Astro component, while a `.mx` compiles to a function from props to an HTML string that Astro calls at build time. Use `.mx` for a template you also render outside Astro, with the [HTML target](/targets/html/).

Both render static markup. The stateful tags (`<let>`, `<effect>`, `<lifecycle>`, `<script>`, `<id>`, `client` blocks) are build errors here.

## Components

```astro
---
import Card from "../components/card.mx";
---
<Card title="Hello">
  <p>Default slot content.</p>
  <Fragment slot="footer">Footer content.</Fragment>
</Card>
```

```mx "card.mx"
export interface Input {
  title: string;
  content: () => string;
  footer?: () => string;
}

<article.card>
  <h2>${input.title}</h2>
  <div>$!{input.content()}</div>
  <if=input.footer>
    <footer>$!{input.footer()}</footer>
  </if>
</article>
```

Astro hands over its slots already rendered, and MX receives each as a function returning that HTML: the default slot is `input.content`, `<Fragment slot="footer">` is `input.footer`, and props are props.

**Render a slot with `$!{…}`, never `${…}`.** The slot is markup Astro already rendered; `${…}` would escape it into visible angle brackets.

A `client:*` directive on an MX component fails the build and names the component: there is no state and no runtime, so there is nothing to hydrate.

## Pages

A `.mx` file under `src/pages` is a page: `src/pages/about.mx` routes to `/about`.

```mx "src/pages/posts/[slug].mx"
export const layout = "../../layouts/Base.astro";
export const getStaticPaths = () => [
  { params: { slug: "first" }, props: { title: "First post" } },
  { params: { slug: "second" }, props: { title: "Second post" } },
];

<h1>${input.title}</h1>
<p>Reading ${input.params.slug} at ${input.url.pathname}.</p>
```

- **`input`** is the page's props plus `params` and `url`, which are `Astro.params` and `Astro.url`.
- **`export const layout`** wraps the page in that layout's default slot. Every other top-level `export const` becomes a `frontmatter` key for the layout, as with Astro's Markdown pages.
- **`getStaticPaths`, `prerender`** and any other export reach Astro's router unchanged.

## Typing `.mx` imports

With the [TypeScript plugin](/hosts/astro/#astro-setup) configured, each imported `.mx` has its own props type, derived from the file. There is no ambient `declare module "*.mx"`: one would give every component the same `any` props and hide every error.
