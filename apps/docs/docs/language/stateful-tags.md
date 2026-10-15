---
title: "Stateful tags"
description: "Why <let>, <lifecycle>, and friends mean whatever the host says."
---

# Stateful tags

`<let>`, `<lifecycle>`, `<script>`, `client` blocks, `<id>`, and the `:=` assignment operator are **not** part of the portable structural core. They're framework territory: MX's core provides three hooks a host can use to give these tags real meaning, and each host's `Policy` decides what happens.

`<effect>` is not an MX tag. On a target (`lowerSource` and the html targets) every form of it is a compile error, and the fix is `<script>`. The default policy and `lowerSource` say:

> `<effect>` is not an MX tag. Use `<script>`: its body runs after render and again when a value it reads changes.

The error is a target rule. On a host (embedded MX in Preact, React, Hono, Solid, Angular or Astro) `<effect>` stays one more unsupported tag, worded like every other: "`<effect>` is not supported in embedded MX on Preact." Under `{ strict: true }` the html target words it like its other reactive rows: "`<effect>` is a reactive effect and requires a runtime; this strict policy has no reactive target". A dialect that states the `none` tag rules keeps `effect` as an ordinary tag name.

A template using `<let>` means something different depending on which host compiles it — the same way a piece of JSX means something different depending on which framework's compiler processes it. The structural tags in [Structural tags](/language/structural-tags/) are portable across hosts; stateful tags are not.

A `<let>` is written in an event handler or a `<script>` body, never while the template renders: `${count++}`, `<p class=(count = 1)/>` or `<const/next=(count += 1)/>` is a compile error (`MX_LET_WRITE_IN_RENDER`), on the html default policy, with the fix in the message. Derive a value with `<const>` instead. A write inside a function that the template calls while it renders is not detected. A `<let>` is also written only below its declaration (`MX_LET_WRITE_BEFORE_DECLARATION`) and never by a `for...of` or `for...in` head (`MX_LET_LOOP_ASSIGNMENT`), and a `<const>`, a `<for>` parameter or a `<define>` parameter is not written while the template renders (`MX_READONLY_BINDING_WRITE`; bound as a plain name, it is not written in a handler or a `<script>` body either). See [Errors](/language/errors/).

Inside a handler, a `<const>` that derives from a `<let>` the handler already wrote is stale on some targets and fresh on others, so reading it there is a compile error too (`MX_STALE_DERIVED_READ`): `items = [...items, x]; if (total > 100) …` with `<const/total=…items…/>`. Compute from `items` directly, or move the check into a `<script>`, which runs after the write settles on every target. The same holds inside a `<script>` body or a `<lifecycle>` hook that writes the `<let>` and then reads the `<const>`; there the fix is to compute from `items`. A read before the write is fine, and so is a read in a nested callback, or a read in a `<script>` of a `<const>` that a handler wrote. See [Errors](/language/errors/).

## The html target's policy

The html target has no reactive runtime — it compiles a template to a plain `(input) => string` function — so its default policy treats stateful tags as **inert**: they're accepted, produce no output, and are verified to behave exactly like Marko's own server render (which also strips these to nothing once its resume markers are removed).

| Tag | Default behavior |
|---|---|
| `<lifecycle>`, `<script>`, `<id>`, `<log>`, `<debug>` | Inert — accepted, no output |
| `client` block | Runs nothing, but declares the names it declares at its own top level (including a non-block `client import` or `client export` declaration's) as `var name;`, so a template that reads one sees `undefined` |
| `<let>`, `<const>`, `:=` | Evaluated for their initial value only |
| `server` block | **Not** inert — this is the server render, so it runs like `static` and its bindings are readable in the template |
| `<await>` | Error — the host genuinely can't render a pending value to a string |
| `<try>` with `<@placeholder>` | Error — needs a second render pass the host doesn't have |
| `<try>` with only `<@catch>` | Lowers to an ordinary `try`/`catch` |
| `<return>` | Not an error — a tag is its own compiled module under the unit model, so its caller invokes it. The module's `render(input, out)` entry writes the output to the caller's sink and returns the value, which never travels in the output (decision 155). `/var` is supported in any scope, dynamic tags included. See [Returning a value](/custom-tags/templates/#template-tags-returning-a-value) for the full grammar, `/var` scoping per host, and the JSX-hooks restriction. |

"Inert" is a shape, not a license to silently drop content: an inert tag's own attributes and body are validated against what Marko's own tag definition allows, and anything unexpected is a compile error naming the tag — not silently discarded.

For `<script>` that means its body is script text and its only attribute is its value: `<script async>`, `<script src="/x.js">`, `<script#id>` and `<script ...attrs>` are compile errors (`MX_INERT_TAG_SHAPE`), as is a `${…}` placeholder in its body (a `${…}` inside a template literal is the script's own). In a body, write the value directly (`const a = x;`, not `${x}`); for a native html `<script>` element use `<html-script>`, which keeps its attributes and interpolates its body.

`<html-script>` writes a real `<script>` element on every target but one, and its body is script text, not markup: each `${…}` is stringified as in any text and the whole body is then escaped for script context (`<script`, `</script` and `<!--` become `\u003C…`, so a value cannot close the element), never HTML-escaped (`a && b` stays `a && b`). Per target:

| Target | Output |
|---|---|
| html | `<script …attrs>body</script>`, as Marko writes it |
| Preact, React, Hono | `<script …attrs dangerouslySetInnerHTML={{ __html: … }} />`: a JSX renderer HTML-escapes a text child, which would turn `&&` into an entity the browser never decodes. React 19 also hoists a `<script async src>` ahead of the markup around it, where Marko writes it in place |
| Solid | `<script …attrs innerHTML={…} />`, for the same reason |
| Astro | `<script is:inline …attrs set:html={…} />`: `is:inline` keeps the element where it is instead of bundling it |
| Angular | a compile error at the tag: Angular's template compiler removes every `<script>` element. Load the script from `index.html` or the `scripts` array of `angular.json`, or create it in the component with the DOM API |

Marko also adds a `nonce` from the render's `$global.cspNonce`. MX does not read `$global.cspNonce` and no target writes a `nonce` for you: the way to set one is an explicit `nonce=` attribute on the tag (a spread that carries `nonce` works too), which is kept as any attribute is. On Preact, React and Hono the body is read as markup: an element, an `<if>` or a comment in it is refused with an error, because it would otherwise be dropped from the script (put markup-like text inside a string placeholder, `${"<b>hi</b>"}`), and a body loses its leading and trailing whitespace. The html target, Solid and Astro read the body as raw text, as Marko does.

### Opting into `strict`

Pass `{ strict: true }` to reject eight constructs (`<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client` blocks, `<id>`, `<log>`, `<debug>`) as compile errors instead of treating them as inert, for an author who wants "this template needs a reactive runtime" enforced at compile time rather than silently accepted and ignored. `<log>`/`<debug>` are debug-only tooling rather than reactive constructs, but get the same named-construct-error treatment under `strict` (decision 111).

The one check that applies regardless of `strict` is the `input`-shadowing guard: a `<let>` or `<const>` binding named `input` is always rejected, since it would silently break the template's own input parameter either way.

## How other hosts differ

A host that does not support a tag says so in one shape: core writes "`<let>` is not supported in embedded MX on Preact." and the host may add a second sentence naming what to write instead ("Use Preact's `useState` via `<const/x=useState(0)/>` or in the surrounding module."). The same applies to `<effect>` (without the second sentence), `<lifecycle>`, `<script>`, `<id>`, `<await>`, `<try>` and the other tags a host lists, on every host, in a whole file and in a region.

A reactive host — Solid, Preact, React, Hono, Astro, or Angular — implements the same six constructs against its own framework's primitives instead of treating them as inert — `<let>` becomes real state, `<effect>` becomes a real side effect. Parity with Marko's server render doesn't apply here, because there is no server render to match: the host is tested against its own framework's behavior.

Mechanically, a host reaches this behavior through three hooks the core exposes: a handler for the stateful tag itself, a way to hoist a statement to the enclosing function's head, and a registry for rewriting identifier references (so, for example, a getter-based state primitive can emit `count()` everywhere `${count}` appears). See [Policy and hooks](/architecture/policy-and-hooks/) for how these fit together.
