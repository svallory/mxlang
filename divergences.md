# Divergences from Marko

Decision 72: MX 1.0 is a strict subset of Marko syntax. Every MX 1.0 file is
a valid Marko file with the same meaning for the structural core, and
hosts may only *forbid* a tag they cannot honor, never add syntax, attribute
forms, or file conventions Marko's parser and language server would reject
(decision 71). Divergence from Marko is permitted only from MX 2 on, and only
deliberately: each divergence gets a line below (what, why, test), and a
divergence that changes syntax lands only together with the tooling it
breaks (grammar, Prettier, language server) — until then MX stays a subset.
The real-Marko oracle (`bun run oracle:marko`) remains a regression guard for
the structural core, no longer a contract in itself.

## Recorded divergences

| Divergence | Since | Reason | Test |
|---|---|---|---|
| A dynamic tag whose resolved value is a **plain function** is called and its return value kept. Marko's own `_dynamic_tag` discards a plain function's return value (only a value carrying Marko's internal template marker is invoked as a component); every other value kind (string, `undefined`, `null`, a plain object) matches Marko byte-for-byte. | decision 116 | An imported `.tsx` component on react/preact/hono, or an MX component on html, *is* a plain function — matching Marko here would silently drop the render of every ordinary imported component, breaking the host-interop case decision 116 exists to support in the first place. | `packages/hosts/html/src/translate.test.ts` ("a plain function value import is called as a host component"); `packages/hosts/preact/src/index.test.ts` (same, executed); `packages/hosts/solid/src/ssr-render.test.ts` (same, executed) |
| On Angular, an element event handler's **`this` is the component** (a bare name, or `this.m`) or **the object of the member** (`svc.m` binds `svc`, `a().b` binds the once-evaluated `a()`). Marko calls `target[key](event, target)`, so `this` is the DOM element the handler is bound to. | decision 117 | An Angular handler is a component method; a template `(f)($event)` already ran with the component as `this`, and there is no sensible way to make it the element without breaking every method that uses component state. | `packages/hosts/angular/test/event-handler.test.ts` ("handler semantics": `this` for a bare ref, `svc.m`, `this.m`, `a().b`, `a[i].b`, `a!.b`) |
| On Angular, an element event handler's second argument (Marko's `target`) is **`$event.currentTarget`, typed `EventTarget \| null`**, and `null` for a payload with no `currentTarget` (a directive output). Marko passes and types the element itself (`HTMLButtonElement` for a `<button>`). | decision 117 | Angular's template type-checker types `$event.currentTarget` as `EventTarget \| null`; typing the element exactly would need MX to add a template reference to every element that has a handler, which was ruled out. | `packages/hosts/angular/test/event-handler.test.ts` ("passes null as the element…", the 2-arg `strictTemplates` cases) |
| On Angular `.ng.mx`, an authored `.mx` tag import must be a **sole default import**: `import A, { b } from "./x.mx"` used as `<A/>` is a positioned compile error at the import. Marko 6.3.51 compiles that form (probed: `A({})` plus the named binding). | decision 72 | A `.ng.mx` calls the tag through the generated component module, `./x`; the `.mx` specifier is not importable from TypeScript, so `{ b }` from it would remain broken in the emitted module, and MX cannot honor the form. The error tells the author to import the tag alone and other names separately, or use the discovered `<kebab-name/>` spelling. | `packages/hosts/angular/test/ng-mx-authored-import.test.ts` ("rejects a mixed default + named .mx import used as a tag, at the import") |
| A same-name `tags/x.mx` and `tags/x.marko` resolve to the **`.mx` tag, regardless of which `tags/` directory is nearer**. Marko resolves by nearest `tags/` directory, but has no `.mx`, so it has no answer for the mixed case. | mx-only (html-tags-marko-import) | The custom-tag scan indexes only `.mx`/`.tag.ts`, and registered custom tags are consulted before the taglib lookup, so the `.mx` tag wins. Nearest-wins across both kinds would need the scan to index `.marko` too; filed as a follow-up. `.marko`-vs-`.marko` precedence matches Marko (nearest wins, `tags/x/index.marko` beats `tags/x.marko`). | `packages/hosts/html/src/marko-tags.bun.test.ts` ("same name as a tags/*.mx tag in the same directory: the .mx tag wins") |
| Host resolution counts **`dependencies` and `devDependencies` only; `peerDependencies` are ignored**. Marko 6.3.51 (`@marko/compiler` 5.42.5) counts `peerDependencies` when it finds taglibs/hosts (`chunk-src.js:2793`, `chunk-config.js:121` in the compiler). | decision 124 | Counting peers could silently flip a package's host (one host in dependencies, another in peers → `html`); the current rule is predictable, and #190's warnings cover the broken-input cases. | `packages/core/src/host-policy.test.ts` ("ignores a host listed only in peerDependencies", "takes the host from dependencies when another host is only a peer") |
| On the JSX hosts (preact, react, hono) and on Solid, **`<if=input.content>` with a present-but-empty body** (`${""}`, `${null}`, `${false}`, `${undefined}`) takes the **else** branch. Marko takes the **true** branch, because an empty body is still a renderer function. | mx-only (jsx-dynamic-body-text) | JSX children carry no "body present" marker: an empty body and no body are both `undefined`/falsy, so the callee cannot tell them apart. Same behaviour before this change. On Solid the empty-string body is normalized to `undefined` by the callee view. | `packages/hosts/preact/src/dynamic-body.test.ts` ("a sole placeholder body of … renders as Marko does" covers the rendered output, not the `<if>` branch) |
| On Angular, **literal `{{ x }}` and `@if (x) {`-style block text** in a template is a positioned **warning** with an MX-form hint. Marko 6.3.51 treats both as plain text with no diagnostic (probed: the html host emits `@if (title) { … } {{ title }}` verbatim). | decision 126 | The text compiles and renders literally, so an author who writes Angular syntax gets a template that silently does nothing. An mx-only lint beyond Marko, implemented in `packages/hosts/angular` only (core is untouched); warning, not error, because the text is valid. Never fires in attribute values, `${…}` placeholders, comments, or `<script>`/`<style>`/`<html-script>`/`<html-style>` bodies. | `packages/hosts/angular/test/literal-syntax-hint.test.ts` (shapes a15/a17/a25 at exact positions; attribute values, `${"{{"}` escape, comments, script/style, prose, emails stay silent); `test/cli.test.ts` (`build()` surfaces it) |

## Fixed: undocumented divergence in the bare `${expr}` line

A standalone concise-position `${expr}` line (no attributes, no body) used to
lower to an escaped interpolation whenever no host claimed `DYNAMIC_TAG` —
treating Marko's placeholder-shaped `MarkoTag` as though it always meant a
text placeholder. Real Marko does not: Marko's own fixture
`error-dynamic-tag-name`
(`packages/hosts/html/fixtures-marko/error-dynamic-tag-name/`,
`static const tagName = "hello world"` then `${tagName}` at column 0) fails at
render with `"Invalid tag name"`, because it compiled to a dynamic tag, not a
placeholder. A bare `${expr}` line and `<${expr}/>` parse to the identical
Marko node (see the "four Marko facts" in `AGENTS.md`); MX 1.0's bare-is-text
special case was an undocumented divergence from that, never a recorded one.
Fixed: `@mxlang/core`'s `lowerTag` now treats both shapes as the dynamic-tag
construct — a claiming host still gets its `DelegatedTag`, and an unclaiming host
gets a `Component` with a dynamic target instead of a silent `Interpolation`.
Text on its own line is written `-- ${x}`, and a placeholder inside an
HTML-syntax body (`<div>${x}</div>`) is unaffected — it parses as
`MarkoPlaceholder`, never `MarkoTag`, and never reaches `lowerTag`. Test:
`packages/core/src/lower.test.ts`, "a dynamic tag's bare shape".

## Host syntax: `<>…</>` in an Angular region

| Construct | Why it was wanted | Marko verdict | Test |
|---|---|---|---|
| `<>…</>` as a fragment region in `.ng.mx` | An Angular template may have several roots, and a region is one expression with one root. | Marko has no expression-position templates: a template or tag body has many root nodes natively, and `<fragment>` is rejected (above). `<>` is host syntax here, as TSX `<>` is in `.solid.mx`; decision 72 lets a host add no syntax to a *file*, and a region is the host's own expression grammar. Output is the plain sibling nodes Marko would produce for several roots. | `packages/hosts/angular/test/ng-mx.test.ts` — `compileNgMx: fragment regions (G9)` |

## Deferred to MX 2

| Construct | Why it was wanted | Marko verdict | Test |
|---|---|---|---|
| Tag params on `<if>` (`<if\|u\|=cond>`) | Solid's `<Show>` callback form narrows the condition value for the branch body. | Rejected: `Tag does not support parameters.` | `packages/parser/src/mx/control.test.ts` — `uses the callback child form for tag params on if` |
| Tag params on native elements (`<div\|x\|>`) | A uniform “tag params make children a render prop” rule for every tag. | Rejected: `Tag does not support parameters.` | `packages/parser/src/mx/render-props.test.ts` — `lowers params on an HTML element the same way` |
| Attribute tags on native elements (`<div><@head>…</@head></div>`) | A uniform “attribute tags become props” rule for every tag. | Rejected: `Tag does not support nested attribute tags.` | `packages/core/src/resolve.test.ts` — `rejects an attribute tag outside a component` |
| `<fragment>` wrapper | An explicit wrapper for multiple Solid JSX children (in `.solid.mx`, use a TSX fragment `<>…</>`). | Rejected: `Unable to find entry point for custom tag <fragment>. Marko templates and tag bodies may have multiple root nodes; no fragment wrapper is needed.` | `packages/parser/src/mx/control.test.ts` — `lowers <fragment> to a JSXFragment` |

## Fixed: former `@mxlang/html` bugs

Two `@mxlang/html` implementation bugs against decision 67's rule ("the
translator should follow Marko") were recorded here as open. Both are now
fixed, and each fixture under `packages/hosts/html/fixtures-marko/` asserts
Marko's own error instead of carrying a `translator-bug` reason. No fixture
records a translator bug today, and `bun run oracle:marko` reports **0
translator bug** over 43 stock fixtures.

- **`unknown-element`**: real Marko treats an unresolved hyphenated tag as a
  failed custom-element lookup and refuses to compile ("Unable to find entry
  point for custom tag `<my-widget>`", verified against `@marko/compiler`
  5.42.5 / `marko@6.3.51`). `@mxlang/html` used to render it as literal HTML
  unconditionally. Fixed: `rejectUnknownTag` (`translate.ts`, called at resolve
  time) now rejects an unresolved hyphenated name with Marko's own wording.
- **`lowercase-component`**: real Marko rejects a lowercase local-variable tag
  reference outright ("Local variables must be in a dynamic tag unless they
  are PascalCase. Use `<${layout}/>` or rename to `Layout`.", same versions).
  `@mxlang/html` was binding-based regardless of case, so it called the import
  instead of erroring — strictly *more permissive* than Marko. Fixed:
  `rejectComponentTag` (`translate.ts`, called at resolve time) now rejects the
  same reference with Marko's own wording. The
  two forms that do work are covered by the `dynamic-tag-lowercase-import` and
  `nested-layout` fixtures.

## Candidates for MX 2

Not divergences today, and not bugs — behaviour MX could deliberately choose
to diverge on from MX 2 on, each still needing its own recorded row and the
tooling that goes with it before it ships.

- **Unknown custom elements in the vanilla host.** MX 1 follows Marko and
  refuses to compile an unresolved hyphenated tag (above). A future MX could
  instead let it through as a literal custom element, which is what a plain
  HTML author would expect from `<my-widget>`.
