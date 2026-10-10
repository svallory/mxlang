# @mxlang/target-html

MX (Markup eXtended) is a template language born from Marko: it takes
Marko's syntax and brings it to wherever JSX lives today. Marko's syntax is the
default where MX has no ruling of its own, and MX does not promise to be a
superset or a subset of it. `.mx` is MX's only extension: a `.marko` file is
not an input (a `.marko` file found where a tag is looked up is a positioned
error telling you to convert it), and porting a Marko component is a rename
plus the differences listed in `divergences.md`.

`@mxlang/target-html` is **the vanilla host on `@mxlang/core`**: it compiles an
MX (`.mx`) template to a pure function — a JS/TS module
whose default export is `(input) => string`, with no runtime beyond an `escape`
helper. No scheduler, no signals, no hydration, no resume markers.

Project [custom tags](../../../apps/docs/docs/custom-tags/index.md) are
discovered and expanded to ordinary IR before this host emits, so the same tag
definition works here and on every other host.

The generic half lives in [`@mxlang/core`](../core/README.md): the MX front end
and lowerer, the structural tag lowerings, the `config.translator` seam and the
string-emit model. This package supplies the *policy* — which tags are inert
and which are errors, component-versus-element resolution, Marko's structured
`class`/`style` values and attribute order — plus its own integrations: the Bun
loader, the `escape` runtime the emitted modules import, and the taglib.

```ts
import { compile } from "@mxlang/target-html";

const { code } = compile(source, "greeting.mx");
```

```marko
// greeting.mx
<h1 class={greeting: true}>Hello, ${input.name}!</h1>
```

```ts
import { escape as __mxEscape, createOut as __mxCreateOut, type Out as __MxOut } from "@mxlang/target-html";

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

(Helpers such as `__mxClassValue` are omitted.) The default export is `(input) => string`. `render(input, out)` is the sink entry: it writes into `out` and returns the template's `<return>` value. The sink comes from `@mxlang/target-html/runtime` (decision 155).

Marko's syntax is the default: MX parses `.mx` with its own front end, and
where MX has no ruling of its own the answer is Marko's. Its element knowledge
(HTML, SVG, MathML) is MX's own element table, `@mxlang/web-elements`, built to match Marko's;
attribute tags and component calls follow Marko's conventions; and the oracle
compares this target's output with Marko's own server render, so the bytes
agree wherever the two languages overlap. What is different is listed in `divergences.md` in the
repository, and `.marko` files are not an input: a tag is an `.mx` template in a
`tags/` directory (or a sidecar), never a `.marko` file.

## Install

```
bun add @mxlang/target-html
```

Published from `dist/` (ESM + `.d.ts`); see `CHANGELOG.md` for release notes.
Will publish as `@mxlang/target-html` once the org rename (decision 74) lands
across the workspace; this package's own name, its `escapeFrom` import
string, and every in-repo consumer specifier stay `@mxlang/target-html` until
then, so the two never drift out of sync.

## Usage

`compile` is the supported entry; it drives the compiler for you:

```ts
import { compile } from "@mxlang/target-html";

const { code, map } = compile("<p>${input.name}</p>", "/views/page.mx");
```

The package also exports a named `translator`, but it works only inside
`compile`, `compileFile` and `build`; passing it to `@marko/compiler`'s
`compileSync` directly throws "no compile in flight".

The wrappers:

- `compile(source, filename)` → `{ code, map }`
- `compileFile(filename)` → `{ code, map }`
- `build(filenames)` → `Map<filename, { code, map }>`, a CLI-free build step
- `escape(value)` — the entire runtime
- `TranslateError` — thrown for a construct with no lowering, carrying
  `line`/`column`

Try it:

```
bun run example                  # renders the `class-object` fixture
bun run example nested-layout    # or any other fixture name
```

### `mx(source)`/`loadMx(path)`: no bundler, no manual caching

For a bundler-free consumer (Express, Hono, a plain Bun server) that wants
Pug's `compile`/`renderFile` ergonomics rather than driving `compile`/
`compileFile` and executing/caching the result by hand:

```ts
import { loadMx, mx } from "@mxlang/target-html";

// From a file already on disk, cached by resolved path + every transitive
// dependency's mtime:
const page = loadMx<{ name: string }>("./views/page.mx");
page({ name: "Ada" }); // -> "<p>Ada</p>"

// From source text directly, cached by a hash of source + filename:
const greet = mx<{ name: string }>("<p>${input.name}</p>");
greet({ name: "Ada" });
```

Both compile once, resolve every import in the compiled output to a real
absolute target, and evaluate the result **synchronously, in memory, with
zero disk writes** — on Bun (a `require` of a `data:` URL) and on Node ≥22.15
(`node:module`'s `registerHooks`, plus its `stripTypeScriptTypes` to erase
the compiled output's own type annotations before Node's ESM loader sees
it). A relative or bare import in `mx(source)`'s output needs an anchor to
resolve against — pass `filename` (the real path the source *would* live at)
whenever the template has a custom tag or any import of its own; `loadMx`
never needs this, since its own `path` argument already is that anchor. A
discovered custom tag's own `.mx` import is compiled recursively through the
same cache and pointed at that nested module's in-memory form, so a page
that calls a tag which itself imports another `.mx` file invalidates
correctly when the deepest file changes, not only when the page's own direct
import does. An import cycle across `.mx` files is a compile-time error
naming the cycle.

**Node-only caveat**: `stripTypeScriptTypes` is an experimental Node API and
prints exactly one `ExperimentalWarning` to stderr per process (not per
call) the first time either helper compiles anything on Node — harmless,
and suppressible with Node's own `--disable-warning=ExperimentalWarning` if
it's unwanted in a log stream. Also Node-only: each recompiled module gets a
fresh internal URL (Node's own `require` cache is keyed by URL, so a
recompiled module needs a new one to actually invalidate), and Node has no
API to evict an already-`require`d ESM module — a long-lived dev process
that edits templates over and over grows this internal cache without bound.
An unchanged file is a cache hit and mints nothing new, so this only grows
at the rate templates are actually edited.

## `.mx` is official, not a retired dialect (decision 72)

Decision 68 retired the old `.mx` dialect (required explicit imports,
`<fragment>`, required `export interface Input`, lowercase-by-scope) — that
dialect stays dead. Decision 72 re-establishes `.mx` as MX's own *identity*,
not a revival of the dialect. Under decision 172 Marko's syntax is the default
where MX has no ruling of its own, and MX makes no subset or superset promise:
the differences are listed in `divergences.md`, and some `.mx` files are not
valid `.marko`. This package accepts only `.mx`: a `.marko` file is not an
MX input (decision 172), and treating one as MX would silently claim support
it does not have. `packages/mx-html` no longer exists. Its lowering core and its
`escape` runtime passed through this package and now live in
[`@mxlang/core`](../core/README.md), which every MX host shares; this package
is the policy plus the HTML integrations.

## Loaders

Two loaders make `import page from "./page.mx"` resolve, one per runtime:

- **Bun**: `@mxlang/target-html/bun` is a `BunPlugin` that intercepts `.mx`
  imports and compiles them on the fly (`.solid.mx` is excluded
  — a different file kind, handled by `@mxlang/vite-plugin`). Register it
  once via `bunfig.toml`:

  ```toml
  preload = ["@mxlang/target-html/bun"]
  ```

  or at runtime with `Bun.plugin`:

  ```ts
  import markoPlugin from "@mxlang/target-html/bun";
  Bun.plugin(markoPlugin);
  ```

  See `examples/mx-site` for a full app built this way.

  `@mxlang/target-html/bun` imports its types from `bun`, so a TypeScript consumer of
  this subpath needs `@types/bun` (an optional peer dependency: nothing else in
  the package needs it):

  ```sh
  bun add -d @types/bun
  ```

- **Typing `*.mx` imports**: `@mxlang/target-html/types/marko` is an ambient
  `declare module "*.mx"` (`(input: unknown) => string`). Load it once from any
  file in your program:

  ```ts
  import "@mxlang/target-html/types/marko";
  ```

- **Vite**: `@mxlang/vite-plugin`'s `mx()` plugin handles `.mx`
  alongside `.solid.mx` (which keeps precedence regardless of extension
  order) — add it to `plugins` and import `.mx` files as usual. See
  `examples/mx-vite`.

`import page from "./x.mx"` typechecks against the
ambient declaration in `types/marko.d.ts` (`declare module "*.mx"`, typed
`(input: any) => string` — per-file `Input` typing needs a virtual-file
projection, the phase-3 language server's job, not something this ambient
declaration can derive).
Reference the file from a consumer's `tsconfig.json` `include` (both
loaders' example apps do this).

## Editor and formatter support for `.mx`

No packages ship for these. Marko's syntax is MX's default (decision 172), so
Marko's own tooling works on most `.mx` files by aliasing the extension; a
construct that only MX has (see `divergences.md`) is not understood by it:

- **VS Code**: map `.mx` to the Marko language so the official Marko
  extension's syntax highlighting and language server apply:

  ```json
  {
    "files.associations": { "*.mx": "marko" }
  }
  ```

- **Prettier**: format `.mx` with `prettier-plugin-marko`'s Marko parser:

  ```json
  {
    "overrides": [
      { "files": "*.mx", "options": { "parser": "marko" } }
    ]
  }
  ```

  Verified manually (2026-09-11, scratch dir, `prettier@3.6.2` +
  `prettier-plugin-marko@4.1.0`): copied
  `packages/targets/html/fixtures-marko/attributes/input.marko` to a scratch
  `input.mx` and ran

  ```
  bunx prettier --plugin=prettier-plugin-marko --parser=marko input.mx
  ```

  Output:

  ```
  <input type="text" value=input.value disabled>
  <a href=input.url target="_blank">link</a>
  ```

  Formatted cleanly with no errors — Prettier's `--parser` flag bypasses its
  own extension-based parser inference entirely, so this proves the
  `overrides` config above works without needing `prettier`/
  `prettier-plugin-marko` as devDependencies of this package. No test
  depends on this, so no dependency was added.

  **Warning (decision 151, ruling 4): do not run it on a file that uses the
  `:name`/`#id`/`.class` sugar after an attribute value.** `prettier-plugin-marko`
  bundles a stock `htmljs-parser`, which does not know the sugar, and rewrites
  `<a x=a .b/>` to `<a x=a.b/>`: a class becomes member access, with no error.
  Tag-adjacent sugar (`<input:email>`) and a sugar in the first attribute
  position are not affected. Exclude such files from the `overrides` above until
  the parser change lands upstream or MX ships its own.

- **Zed**: `packages/editors/zed` ships an `MX` language on Marko's own
  unmodified tree-sitter grammar (`path_suffixes = ["mx"]`), queries copied
  verbatim from the official `marko-js/zed` extension. See that package's
  README for install steps and what you get (no language server of our own —
  see that README's "What you get in Zed today").

## The `strict` policy

Decision 68's policy fold: `.mx`'s reactive-constructs-are-errors stance is
folded in as an opt-in `strict` policy, rather than the default. The default
`policy` renders what Marko's own server render would emit (`<let>`'s initial
value, `<effect>`/`<lifecycle>`/`<script>`/`client`/`<id>` as inert) — see the
policy table below. `strictPolicy` instead rejects those same constructs by
name, for an author who wants "this needs a reactive runtime" to be a compile
error rather than silently accepted:

```ts
import { compile } from "@mxlang/target-html";

const { code } = compile(source, "greeting.mx", { strict: true });
```

`compileFile` and `build` take the same `{ strict?: boolean }` option.

Kept from `.mx`'s dialect: the reactive-tags-as-errors stance above, and the
`input`-shadowing check (`checkBinding`) — already the default in both
policies, not `strict`-only, since a `<let>`/`<const>` binding named `input`
silently breaking the template's own input is a bug in either policy, not a
stricter preference. Dropped, per decision 65 (these were conventions of the
old `.mx` walk, not capabilities the target lacks, so they do not survive as
a policy — stock Marko's own conventions replace them unconditionally, not
just outside `strict`): the explicit-import requirement (Marko's taglib +
`tags/` discovery works in both policies), the `export interface Input`
requirement (already optional — Marko allows arbitrary TS), `<fragment>`
(Marko templates and bodies are multi-root already), and lowercase-by-scope
tag resolution (replaced by MX's own element table, `@mxlang/web-elements`).

## What this proves

`notes/marko-runtime-modes.md` proposes an **expressions-only** output mode for
Marko: `runtime: "none"`, where a template compiles to a plain string function
and the reactive tags become compile-time errors. The argument for it is that
Marko's `html` output *minus the runtime* is already a precompiled template
language with typed TypeScript expressions and a language server — something
Pug, Jinja, Handlebars and EJS never had.

This package is that mode, working, on `.mx` templates written in Marko's
syntax, without forking the compiler. The seam is `config.translator`: a
translator that supplies only `translate` and its taglibs injects nothing else, so the emitted module's
runtime surface is one `escape` import (plus, only when a template calls for
it, an inlined `classValue`/`styleValue`/`renderDynamic` helper).

The evidence is `bun run oracle:marko`'s table: every stock `.marko` fixture
under `fixtures-marko/` rendered both through the real Marko 6 toolchain and
through this translator (the oracle compiles each fixture's source as `.mx`),
compared for semantic HTML equality.

### Proposal draft

> **Expressions-only output for Marko (`runtime: "none"`).** Marko's `html`
> output minus the runtime is a complete precompiled template language: typed
> `${}` expressions, real components, the language server, and a compiled
> artifact that is readable JavaScript rather than `_scope`/`_marker` calls. A
> template using only `<if>`, `<for>`, `<let>`, `<const>`, `<define>`,
> attribute tags, `static` and `import` needs nothing at run time but an HTML
> escape helper — roughly 200 bytes — and compiles to
> `(input: Input) => string`, usable from Express, Hono, Workers, email
> pipelines, or a static site generator with zero bundle cost and no render
> API. The reactive constructs (`<effect>`, `<lifecycle>`, `<script>`, `<await>`,
> `:=` as a two-way binding) either become inert or fail at compile time with a
> message naming them, so the boundary is visible to the author rather than
> silent. We have implemented this as a translator against `@marko/compiler`
> 5.42.5 with no compiler changes, and verified it against Marko's own server
> render on 30 stock templates covering components, `tags/` discovery,
> attribute tags, control flow, `class`/`style` object forms, spread, dynamic
> tags and doctype documents: all 30 produce byte-equivalent HTML. The
> implementation is ~700 lines and the runtime is one function. We would like
> to contribute it upstream as an output mode.

## Policy table (decision 65)

The target renders **what Marko's server render would emit, minus resume
markers**. Every construct is classified by one test: does it contribute to the
emitted bytes, or does it only configure behaviour after the first render?

"My code cannot lower this" is never a row in this table. Only "this target
cannot express it" is.

### Inert — accepted, contributes no output

Each was verified against Marko's own server render: the emitted HTML is
byte-identical with and without the construct.

| Construct | Why it emits nothing |
|---|---|
| `<effect>` | Runs after render, on the client. |
| `<lifecycle>` | Client-side lifecycle hook. |
| `<script>` (the core tag) | Client behaviour, not markup. `<html-script>` emits a literal `<script>` element. |
| `<id>` | Allocates an identifier for the reactive runtime. |
| `<log>`, `<debug>` | Write to the console / attach a debugger hook. |
| `client` blocks | Evaluated only on the client. |
| `by=` on `<for>` | Reconciler input: which item a DOM node belongs to across re-renders. A one-shot render performs no reconciliation. |
| `key=` on `<for>` | An error, not a silent drop: Marko's translator refuses it before it reaches any taglib ("The `<for>` tag keys items with the `by=` attribute, not `key=`…"), so MX refuses it the same way, at the attribute, with the fix-it for that loop's form. It is the **translator** that rejects it, not the parser — the front end hands lowering both spellings. |

### Evaluate initial value

| Construct | Lowering |
|---|---|
| `<let/x=expr/>` | `const x = expr` — reactive state has an initial value, and a one-shot render has no update path. Marko's own server render emits that value. |
| `<const/x=expr/>` | `const x = expr` |
| `attr:=expr` | The initial value renders; there is no write-back path. |
| `<define>`, `static`, `import`, `export interface Input` | Bound / hoisted to module scope. |
| a `server` block | **Runs.** This *is* the server render, so its statements execute and its bindings are readable from the template — verified against Marko, where `server const S = 41 + 1` then `${S}` renders `42`. Hoisted exactly as `static` is. (Its counterpart, a `client` block, is inert.) |
| `<return>` | **Not** an error. Under the unit model a tag compiles to its own module and its caller invokes it, so a returning unit's `render(input, out)` writes into the caller's sink and returns the value (decision 155). `/var` is supported in any scope, dynamic tags included. |

### Lowered — everything with output bytes

Elements, text, `${}` (escaped) and `$!{}` (raw), attributes including spread
and the `class`/`style` object and array forms, `.class#id` shorthand,
`<if>`/`<else if>`/`<else>`, every `<for>` form, `<html-comment>`, doctype,
`<style>`/`<html-script>`/`<html-style>` blocks, dynamic tags `<${expr}/>`,
components resolved by an `import`, a `<define>` or `tags/` discovery, and
attribute tags.

Plain `<!-- -->` comments are **stripped**, because Marko strips them.

### Error — the target genuinely cannot

| Construct | Why |
|---|---|
| `<await>` | Suspends on a promise. This target is a synchronous `(input) => string`. Marko itself refuses to render one to a string: *"Cannot consume asynchronous render with 'toString'"*. |
| `<try>` with `<@placeholder>` | Needs a second render pass over suspended content, with nowhere to schedule it. A `<try>` **without** a placeholder lowers to a plain `try`/`catch`, with `<@catch>` as the catch block. |
| `<let/input=…>`, `<const/input=…>` | Declares `input` at render scope, where the emitted `function (input: Input)` already binds it — the template's own input would become unreachable. Marko rejects the same thing: *"Duplicate declaration of `input`"*. A tag *param* (`<for|input|>`) is a nested scope and is fine; see below. |
| A lowercase tag naming a local binding (`import layout from "./layout.mx"` then `<layout>`) | Marko itself refuses this: *"Local variables must be in a dynamic tag unless they are PascalCase. Use `<${layout}/>` or rename to `Layout`."* — a lowercase name is only ever resolved through taglib/`tags/` discovery, never a local variable. Since decision 164 addendum 1 every target raises one positioned error in core instead (*"`<layout>` is not a tag here: `layout` is imported from ./layout.mx, and a lowercase tag never calls a binding. Write `<Layout>` (rename the import) or `<${layout}/>`"*); a name that is also a native element stays native with a warning. `<${layout}/>` (dynamic tag) and `<Layout/>` (PascalCase) both still work — see fixtures `dynamic-tag-lowercase-import` and `nested-layout`. |
| An unresolved hyphenated tag (`<my-widget>` with no taglib entry) | Marko's own failed custom-element lookup: *"Unable to find entry point for custom tag `<my-widget>`."* An unresolved hyphenated name is not literal HTML — matching Marko means erroring, not rendering it as-is. A candidate for a later, deliberate MX 2 divergence; see `divergences.md`. |

A valueless `<const/x/>` is an error, as it is in Marko (*"the `<const>` tag
requires a value"*). A valueless `<let/x/>` is fine and renders empty, also
matching Marko.

### Deliberately not byte-matched

| Choice | Reason |
|---|---|
| Attribute values are always double-quoted | Marko elides quotes when a value needs none (`<div id=x>` → `id=x`, unquoted). This translator always emits `id="x"`. Chasing Marko's quote-minimizer byte-for-byte would trade readability and defense-in-depth (an unquoted attribute is one stray space away from becoming a second attribute) for a spelling difference `oracle:marko` cannot even see: `htmlEquals` compares parsed, decoded attribute values, not source bytes, so both spellings already parse identically. Decision 67. |

### Not Marko syntax

Distinct from the table above. These are not constructs the target cannot
express — they are spellings **Marko itself does not have**, so there is no
behaviour to reproduce and no fixture to write (no `.marko` file using them
compiles at all).

| Construct | Marko's own answer |
|---|---|
| `class:foo` / `style:foo` | *"`class:active` is not a valid attribute, did you mean `class={ active: condition }`?"* — verified for every form: static, dynamic, alone, and beside a plain `class`. The translator errors with Marko's own fix-it rather than inventing a lowering for markup the target does not have. Use the object form, which **is** supported: `class={ active: condition }`. |

### Rejected before this translator runs

Some constructs need no row of their own, because the MX front end or core
refuses them before a host emits anything. Recorded so their absence from the
table above is not mistaken for silent tolerance:

- `$!{…}` in an attribute value (`<div title=$!{x}>`) — a raw placeholder is
  not valid in attribute position; `compile()` throws a positioned
  `TranslateError` (``Expected a single expression, but found `{` after it.``).
- A `.marko` file where a tag is looked up (`tags/`, an import used as a tag) —
  a positioned error telling you to convert it to `.mx` (decision 172).

`key=` on an element is not among them: it is an ordinary attribute and is
emitted as written. Only `key=` on `<for>` is refused (see the inert table).

## Attribute tags follow Marko's own convention

`<@header>x</@header>` becomes a **renderable** — `input.header`, rendered
with `<${input.header}/>` — and a *repeated* `<@item>` becomes an **array**
of renderables, matching Marko's own server render (verified against Marko
5.42.5, not assumed). Ordinary children become `input.content`. Component
resolution goes through core's tag table and its own `tags/` discovery: an
`import`, a `<define>`, or a `tags/`-discovered `.mx` template. A
`marko.json` / `marko-tag.json` is not read (decision 197): a tag only it maps
is an unknown tag. An unknown lowercase tag resolves through MX's own element
table (`@mxlang/web-elements`: HTML, SVG, MathML), and a plain `<!-- -->`
comment is stripped, because Marko strips it.

The retired `.mx` dialect (decision 68) made different choices here —
callable function props instead of renderables, `input.children` instead of
`input.content`, explicit imports only, no `tags/` discovery, an error for an
unhyphenated unknown tag, and preserved `<!-- -->` comments. Those were
recorded conventions of MX's own walk, not capabilities Marko's target
lacks (decision 65), so they did not survive the fold into this package.

## Why third-party translators are hard to write correctly

A tag node carries more than any one lowering path reads (the field names
below are those of the Marko-shaped node host hooks receive), and the fields it
fills in are *not* in `body.body`. A translator that walks only
the body renders none of them — and reports nothing, because from the walker's
point of view there was nothing there.

That is not hypothetical. An early audit of this problem found eight such
fields, each silently dropped by a translator that looked correct and passed
its fixtures:

| Field | What a naive walk does | What it should do |
|---|---|---|
| `attributeTags` | drops the content of every `<@name>` | lower them, or name the tag and its parent |
| `body.params` | binds the body to a name the author never wrote | error, or lower |
| `arguments` | drops `<Row(x)/>`'s arguments; the call gets `undefined` | pass them |
| `var` | drops `<div/ref>` | error, or lower |
| `typeArguments` | drops `<Card<string>>` | error |
| `attributes` on a no-output tag | drops them | error |
| `modifier` | emits `class="x"` for `class:foo="x"` — **different markup**, not a drop | error: not Marko syntax, repeating Marko's own fix-it |
| `bound` | drops `value:=v` | lower the initial value |

The modifier row is the worst kind: the output is not missing, it is *wrong*,
and it looks fine. The `by=` case is how the whole class was found — a fixture
cited `by=`, passed, and proved nothing, because the emitter read four
attributes and discarded the fifth.

Every emission path therefore runs one shared guard (`rejectUnsupportedFields`,
in `@mxlang/core`) rather than a check per path. Every caller **declares** the
fields it genuinely lowers; anything else present on the node is an error
naming it. Seven scattered copies would drift, and the next field Marko adds
would be dropped by whichever copy was forgotten.

Inert constructs are declared to the same guard rather than skipped, so
"accepted with no output" and "silently swallowed" cannot be confused. Each
inert row declares the **shape it is inert in** — the body and attributes its
own Marko tag definition allows — and anything else is an error naming the tag
and what was found:

```marko
<effect() { go() }><div>inside</div></effect>
```
> `` `<effect>` does not support body content; it emits nothing, so the body
> would be silently discarded ``

That matches Marko, which rejects the same template with *"The `<effect>` tag
does not support body content"*. `<script>` is the one inert tag that **does**
take a body — its definition declares a raw-text one — and it is declared that
way rather than special-cased.

## Fixtures

`fixtures-marko/<name>/` holds `input.marko`, `input.json` and
`expected.html`, plus any sibling component or `tags/` directory the fixture
needs. `expected.html` is what **real Marko** renders, generated by running the
Marko 6 toolchain, not written by hand.

`bun run oracle:marko` renders every fixture both ways and compares them
semantically (parse5, decoded content, resume markers stripped). The run fails
if the glob is empty, a fixture is missing one of its three files, or fewer
than 40 fixtures were processed — a gate must assert it did work, not merely
that nothing failed.

## Pins

No Marko tag lookup runs in a compile (decision 197). Core's tag table reads
the core taglib (`CORE_TAGLIB`, `@mxlang/core`'s `taglib/core-tags.json`),
which declares the core tags' parse options (statement tags, control flow,
`openTagOnly`, raw-text bodies), and the HTML, SVG and MathML elements of
`@mxlang/web-elements`, which this target hands core as its `nativeTags`; core
hands the MX front end each tag's shape from that table.
