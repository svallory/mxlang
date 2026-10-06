---
title: "Astro: what MX compiles to"
description: "Each MX construct in an .astro.mx template and the Astro template syntax it becomes, with the constructs a static host cannot express."
---

# Astro: what MX compiles to

The `---` fence passes through byte for byte. The template under it compiles to Astro's own template syntax, and `static` statements from the template are hoisted into the fence.

| Written | Emitted |
|---|---|
| `${expr}` | `{expr}` |
| `$!{expr}` | `<Fragment set:html={expr} />` |
| `attr=expr`, `...obj` | `attr={expr}`, `{...obj}` |
| `class={ a: true }`, `class=[…]` | `class:list={…}` |
| `<if>` / `<else if>` / `<else>` | a ternary chain |
| `<for\|x\| of=xs>` | `{[...xs].map((x) => (…))}` |
| `<for\|k, v\| in=obj>` | `{Object.entries(obj).map(([k, v]) => (…))}` |
| `<for\|n\| from=a to=b>` | an `Array.from` range map |
| `<@name>` on a component | `<Fragment slot="name">…</Fragment>` |
| ordinary children of a component | the default slot |
| text containing `{` or `}` | escaped to `&#123;` / `&#125;` |
| `<!-- … -->` | kept as written |
| `<html-comment>text ${expr}</html-comment>` | a `<!-- -->` built at render time |
| `<textarea value=expr/>` | `<textarea>{expr}</textarea>`, escaped |
| several root elements | several root elements |

`<html-comment>` and `<textarea value>` follow Marko: the comment escapes `>` so a value cannot close it early, and the textarea renders its value as content, never as an attribute. A `value` together with a body is a build error.

## Not supported

Every construct the target cannot express is a build error that names the construct and the line.

| Construct | Why | Instead |
|---|---|---|
| `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `<id>`, `:=` | No reactive runtime: the page renders once, at build time | An island in the framework of your choice |
| `onClick=fn`, `onClick() { … }` | A handler needs a runtime | A `<script>` in an `.astro` file, or an island. A string, `onclick="…"`, passes through |
| `<const>` | The fence is where values live | `const x = …` in the fence |
| `<define>` | Astro has no local component | Its own `.astro.mx` file |
| Tag params, `<@name\|p\|>` | Slots pass markup, not functions | Render in the component that has the data |
| `<@name>` on an HTML element | Named slots exist only on components | |
| `<${expr}>` | Astro resolves component names statically | An `<if>` chain |
| `<await>`, `<try>`, `<return>` | No suspense, error boundary or caller to hand a value to | |

## Attribute tags and slots

An attribute tag is a projection into a named slot, so it is singular and carries only a body: arrays, loops, attributes on the tag, params, nesting and a bodiless `<@name/>` are positioned errors. `<if>` branches that each give the same tag are fine, since one is rendered. For a plain `.mx` component the slot arrives as a `() => string` function; see [`.mx` components](/hosts/astro/mx-files/) and [AttrTag](/language/attr-tag/).
