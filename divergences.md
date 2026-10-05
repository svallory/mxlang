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

## Fixed: whitespace-only component bodies (decision 141)

Core previously treated an already-normalized one-space body as absent by
trimming it a second time. Imported components and discovered `tags/*.mx`
now retain that space, matching Marko 6.3.51 on all seven hosts. Tabs, CRLF,
comments beside whitespace and mixed bodies are pinned by the rendered
`test-fixtures/body-whitespace/cases.json` matrix. This fixes an undocumented bug,
not a new divergence. The present-but-empty **placeholder** body / `<if>`
divergence below is unchanged.

## Native attribute object values: Angular gap

Html, Preact, React, Hono, Astro and Solid now match Marko 6.3.51's debug render-time
error for unrenderable object-valued ordinary native attributes, including
final merged spreads. The guard is always on and stricter than optimized
Marko output, which renders ordinary plain objects as `[object Object]`
without the debug assertion. Functions and symbols receive Marko's exact
debug errors too. Arrays, Dates and custom `toString` remain valid;
structured class/style and controlled writers retain their existing behavior.
Real-render regression coverage: `packages/{targets/html,hosts/preact,hosts/react,hosts/hono,hosts/astro}/src/attribute-value.test.ts`.

**Solid** (decision 149) throws at render like the other hosts, with the same
text, on both SSR and DOM output. Dynamic native attributes of unknown type
compile to `name={__mxAttrValue("name", expr, "tag")}` and spreads on native
elements to `{...__mxAttrSpread(expr, "tag")}`; string-valued dynamic tags
(`<${tag} .../>`, including attribute tags and the args spread) are guarded
when the target resolves to a string and pass through for a component target.
Only names with genuine non-attribute semantics on Solid are exempt: `class`,
`style`, `ref`, `children`, event handlers (Marko's `/^on[A-Z-]/` in a spread,
plus Solid's `on:`/`oncapture:`) and `prop:`, a real property write. `attr:`,
`bool:` and `use:` lower to `setAttribute` on Solid 2, so they validate, as do
`innerHTML`, `textContent`, `classList` and `:foo` (`value:foo`); Marko
exempts no name. String-shaped
values and component props are not wrapped. The spread helper is a Proxy that
validates each key as Solid reads it, so reactivity is preserved and an
attribute or spread key that a later source overwrites is never validated,
which matches Marko. The wrapper cannot byte-match a hand-written twin, so the
oracle rows `attrs` and `todos` (dom, ssr-hydratable; both backends) are
recorded in `fixtures/divergences.md`. Coverage:
`packages/hosts/solid/src/attribute-value.test.ts` (shared real-render probe)
and `attr-guard.test.ts`.

**On Solid, `prop:name` is Solid's own opt-in, and MX emits the name
verbatim (lead ruling 47).** `<div prop:foo=y/>` compiles to
`prop:foo={y}`, which Solid 2 treats as a **DOM property write** of `foo` — it
does not serialize as an attribute and is not the `value:foo` attribute that
MX's `:foo` sugar produces. Every other host keeps the same authored name as
an ordinary attribute/prop (`prop:foo` on html, preact, react, hono, `.astro.mx`
and Angular). MX makes no cross-host promise for the `prop:` prefix: it never
rewrites or refuses the name, so the meaning is whatever the host runtime does
with it. Not an approved language divergence from Marko — Solid simply owns
that spelling.

**Angular is unchanged on every host path**, including `.ng.mx` and generated
tag classes: ordinary attribute bindings stringify plain objects to
`[object Object]`, and null-prototype values raise a framework coercion error
instead of Marko's diagnostic. Real TestBed probing confirmed both results.
Closing this gap would require a runtime helper in Angular's template scope;
requiring a new instance member on author-owned page classes is a compatibility
change and awaits a lead ruling. This is an open implementation gap, not an
approved language divergence or a new required authoring pattern.

## Recorded divergences

### Character references split across placeholders (JSX hosts)

Preact/React/Hono decode authored text nodes independently. Marko's
concatenated HTML can complete a reference across a placeholder:
`<p>&am${"p;"}</p>` renders `&`, and `<p>&${"copy;"}</p>` renders `©` after
browser parsing. Those hosts instead show literal `&amp;` and `&copy;` text.
Solid's intrinsic templates match these constant-placeholder examples, but
its independently decoded component/flow text has the same limitation.
This is a known concatenation-boundary divergence, not a new syntax rule;
keep a reference in one text node or interpolate the decoded character.
Recorded by jsx-text-entities round-2 review (2026-10-04; decision 72).
No cross-node decoding is introduced. See the specification's authored
character references section.

| Divergence | Since | Reason | Test |
|---|---|---|---|
| Authored bindings starting with **`__mx`** are rejected at the binding, on every target and in host code MX parses. Property names and references remain legal; type-only names (type parameters, `declare function` parameters) are legal too, since nothing is emitted under them. Marko 6.3.51 accepts `__mxX`, `_x`, `__x`, `$x` and `$mxX` tag bindings and `static` declarations; it has no comparable blanket `$`/`_` reservation in these probes. | reserve-mx-identifiers | Prevent authored declarations from shadowing generated helpers or duplicating hoisted declarations. Public runtime exports keep their names; generated imports use private aliases. MX is stricter here. **Not full hygiene:** names outside `__mx` are still allocated, and Solid's whole-unit `$mxProps`/`$mxBody`/`$mxValue`/`$mx_Define*` plus the JSX/Solid range mapper's `_`/`mxIndex` are known to still collide with an authored binding (tracked follow-ups). | `packages/core/src/reserved-bindings.test.ts`; host/parser reservation tests and executed collision regressions |
| Native attribute validation on html, Preact, React, Hono and Astro is always on: same errors as Marko debug, stricter than optimized Marko output, which serializes plain objects as `[object Object]`. | attr-value-parity | Fail loud instead of producing unintended markup; no null/false serialization change. | Per-host `attribute-value.test.ts`; live Marko debug render in oracle tests. |
| **React boolean properties** render **presence only**: `disabled=""` where Marko prints the value text (`disabled="0"`, `disabled="x"`). Covered names: the properties React's server renderer prints as bare attributes under the lowercase name MX emits (`async`, `controls`, `credentialless`, `default`, `defer`, `disabled`, `hidden`, `inert`, `loop`, `multiple`, `muted`, `open`, `required`, `reversed`, `scoped`, `seamless`, and `checked` on `<input>`). Presence (null/undefined/false omit, everything else present) matches Marko. Every other name passes through raw, so `readonly`, `autofocus`, `selected`, `checked` off `<input>` and the other camelCase-in-React booleans print Marko's value text for `0`/`""`/`"x"`. A bare `true` on such a name prints `name=""` (Marko: bare). **React string `style`**: `style` as a string or `true` cannot render; a literal in a spread object (`...{style: "x"}`) is a positioned compile error naming the fix (use an object), a value known only at run time keeps React's own render error (`The \`style\` prop expects a mapping from style properties to values, not a string.`). Marko renders `style=x`. | jsx-primitive-attr-parity (decision 149) | React exposes no way to emit those properties' text or a string style. Loud, never silent. Measured against Marko 6.3.51 as parsed DOM on preact, react and hono: `title`, `data-x`, `aria-x`, `class`, `style` (spread/merged), `disabled`, `checked` (input and div), `value`, `autofocus`, `readonly`, `selected`, `required`, `open`, `allowfullscreen` match, except the rows named above. | `packages/oracle/src/primitive-attributes.test.ts` (presence comparison for React's names, pinned style error); `packages/hosts/react/src/primitive-attributes.test.ts` |
| In the **data target**, the core structural names **`if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static` and `try`** cannot name a data tag: `else`, `else-if` and `try` get the reserved-name error (`` `<try>` cannot name a data tag: it is reserved … ``), `define` and `return` get their own rejects, and the other six are the structural construct or its own parse error (`` `import` is a statement, not an html tag… ``). `try` is the one that surprises, because only core's built-in `<try>` uses that name. Marko 6.3.51 reserves the same names, so no name a Marko user tag could take is withheld; what differs is that a data file cannot reclaim them as vocabulary the way a host-owned name (`let`, `id`, `log`, `class`) is reclaimed. | decisions 131 (addendum item 2), 132 | A static tree has no way to express a tag named like a construct core has already consumed: `else`/`else-if` belong to the `<if>` walk and `try` to core's built-in tag, all before any target sees them. Naming them in the error beats a silent drop or an unrelated parse error. Data-target rule; core names no target (decision 126). | `packages/targets/data/src/parse.test.ts` (reserved-name cases); `packages/targets/data/src/descriptor.test.ts` |
| A tag named after an **`Object.prototype` member** (`<toString/>`, `<constructor/>`, `<hasOwnProperty/>`, `<valueOf/>`, `<__proto__/>`) is an **ordinary tag name on every target**. Marko 6.3.51 (`@marko/compiler` 5.42.5) crashes with a raw `TypeError: undefined is not an object (evaluating 'filePath.length')` on any of them, bare or with a body, for both outputs (its taglib `getTag(name)` is `merged.tags[name]` on a plain object, so the name resolves to the prototype member). | mx-only (proto-names) | The crash is an implementation accident, not a language rule: no tag name should break the compiler, and a data dialect may well want `constructor` or `valueOf` as vocabulary. Core strips the prototype from the lookup's tag map (`lookup-safety.ts`, used by `compileSource` and `parseFragment`) and guards its own plain-object lookups. Widening only: it changes no file Marko accepts. A declared `customTags` entry of that name is a contract. | `packages/targets/data/src/prototype-names.test.ts` (`parseData`, both `unknownTags` modes, declared contract); `packages/targets/html/src/prototype-names.test.ts`; the same file in `hosts/react`, `hosts/preact`, `hosts/solid`, `hosts/angular/test` |
| A **data file** (`mx.target: "data"`, `parseData`) accepts files Marko rejects: the data taglib switches off Marko's HTML parse rules (`openTagOnly`, `text`, `preserveWhitespace`) on the 19 names that have them, so `<source>\n  <input/>\n</source>` parses with `input` as a child of `source` (Marko parse-only, measured in the data-target design note, probe P1: `Line has extra indentation…`, because `source` and `input` are void tags there; the one-line form `<source><input/></source>` fails with `The closing "source" tag was not expected`). The cost: a tag-like `<name` in a `script`, `style`, `textarea` or `title` body parses as a tag, not text. | decision 131 (addendum item 1) | A data tag named `source`, `input`, `title` or `script` is vocabulary, not HTML; the HTML rules would make a resource dialect unwritable. It breaks "every MX file is a valid Marko file" for data files only, by widening, never by changing the meaning of a file both accept. Data-target taglib, no core change (decision 126). | `packages/targets/data/src/taglib.test.ts` (the 19 names, a child tag under each, no whitespace text under `pre`/`script`) |
| **`mx.contracts`** names package-level modules default-exporting declarations plus `analyze`, with whole-entry precedence and shadow/duplicate warnings. Marko's `marko.json` declares package-level tags but enforces none of their declared attributes or nesting. | decision 142 | One mx-only declaration surface for packages with many contract-only tags; synchronous shared discovery, no host-specific core rule. Syntax is unchanged. | `packages/core/src/contracts.test.ts` (entry forms, resolution, positioned failures, precedence, warnings, filtering, both walks, cache, parser options, analyze) |
| Declared attribute tags accept recursive **`attributes`, `attributeTags` and `children`** contracts, including E1 types and E2 authored children / `#text` / control-flow cardinality. Violations name the owner chain and stop at the first; defaults on attribute-tag attributes are not applied. Marko 6.3.51 allows attributes and nesting on attribute tags but enforces no declarative contract. | decision 138 E4 (16:50 ruling) | Opt-in, mx-only validation shared at every depth in core, with no host branch (decision 126). No-map declarations keep the prior no-template rejection. | `packages/core/src/attribute-tag-contracts.test.ts` (step-0 ranges, attributes, children, nesting, registration and discovery); `packages/core/src/custom-tags.test.ts` (legacy rejection); `packages/targets/data/src/attribute-tag-contracts.test.ts` (`parseData`, first error, no partial tree) |
| A declared **`parents`** list restricts authored direct parents, with transparent control flow and reserved `#root` for each file/template's own top level; an attribute-tag body has parent `@name`. Registration cross-checks `children` against `parents`. Marko 6.3.51 has no enforced declarative parent contract. | decision 138 E3 | Opt-in, mx-only placement validation in core for transform, template-sidecar and contract-only tags, with no host-specific branch (decision 126). | `packages/core/src/parents.test.ts` (authored-tree measurement, registration, discovery, templates and recursion); `packages/targets/data/src/parents.test.ts` (`parseData`, first positioned error, no partial tree) |
| A declared **`children`** contract is closed and enforces authored plain child names, required/repeatable cardinality through `<if>`/`<for>`, and the reserved `#text` class; dynamic children are errors. Marko 6.3.51 loads `nested-tags` metadata but does not enforce it (probed: `<card><span/></card>` compiles regardless of its declared nested tags). | decision 138 E2 | Opt-in, mx-only language-level validation before child transforms or host lowering; covers transform, template-sidecar and contract-only tags without a host branch (decision 126). | `packages/core/src/children.test.ts`; `packages/core/src/scan.test.ts` (discovered declaration-only sidecar); `packages/targets/data/src/children.test.ts` (`parseData` with delegate-everything declarations) |
| A dynamic tag whose resolved value is a **plain function** is called and its return value kept. Marko's own `_dynamic_tag` discards a plain function's return value (only a value carrying Marko's internal template marker is invoked as a component); every other value kind (string, `undefined`, `null`, a plain object) matches Marko byte-for-byte. | decision 116 | An imported `.tsx` component on react/preact/hono, or an MX component on html, *is* a plain function — matching Marko here would silently drop the render of every ordinary imported component, breaking the host-interop case decision 116 exists to support in the first place. | `packages/targets/html/src/translate.test.ts` ("a plain function value import is called as a host component"); `packages/hosts/preact/src/index.test.ts` (same, executed); `packages/hosts/solid/src/ssr-render.test.ts` (same, executed) |
| On Angular, an element event handler's **`this` is the component** (a bare name, or `this.m`) or **the object of the member** (`svc.m` binds `svc`, `a().b` binds the once-evaluated `a()`). Marko calls `target[key](event, target)`, so `this` is the DOM element the handler is bound to. | decision 117 | An Angular handler is a component method; a template `(f)($event)` already ran with the component as `this`, and there is no sensible way to make it the element without breaking every method that uses component state. | `packages/hosts/angular/test/event-handler.test.ts` ("handler semantics": `this` for a bare ref, `svc.m`, `this.m`, `a().b`, `a[i].b`, `a!.b`) |
| On Angular, an element event handler's second argument (Marko's `target`) is **`$event.currentTarget`, typed `EventTarget \| null`**, and `null` for a payload with no `currentTarget` (a directive output). Marko passes and types the element itself (`HTMLButtonElement` for a `<button>`). | decision 117 | Angular's template type-checker types `$event.currentTarget` as `EventTarget \| null`; typing the element exactly would need MX to add a template reference to every element that has a handler, which was ruled out. | `packages/hosts/angular/test/event-handler.test.ts` ("passes null as the element…", the 2-arg `strictTemplates` cases) |
| On Angular `.ng.mx`, an authored `.mx` tag import must be a **sole default import**: `import A, { b } from "./x.mx"` used as `<A/>` is a positioned compile error at the import. Marko 6.3.51 compiles that form (probed: `A({})` plus the named binding). | decision 72 | A `.ng.mx` calls the tag through the generated component module, `./x`; the `.mx` specifier is not importable from TypeScript, so `{ b }` from it would remain broken in the emitted module, and MX cannot honor the form. The error tells the author to import the tag alone and other names separately, or use the discovered `<kebab-name/>` spelling. | `packages/hosts/angular/test/ng-mx-authored-import.test.ts` ("rejects a mixed default + named .mx import used as a tag, at the import") |
| A same-name `tags/x.mx` and `tags/x.marko` resolve to the **`.mx` tag, regardless of which `tags/` directory is nearer**. Marko resolves by nearest `tags/` directory, but has no `.mx`, so it has no answer for the mixed case. | mx-only (html-tags-marko-import) | The custom-tag scan indexes only `.mx`/`.tag.ts`, and registered custom tags are consulted before the taglib lookup, so the `.mx` tag wins. Nearest-wins across both kinds would need the scan to index `.marko` too; filed as a follow-up. `.marko`-vs-`.marko` precedence matches Marko (nearest wins, `tags/x/index.marko` beats `tags/x.marko`). | `packages/targets/html/src/marko-tags.bun.test.ts` ("same name as a tags/*.mx tag in the same directory: the .mx tag wins") |
| Host resolution counts **`dependencies` and `devDependencies` only; `peerDependencies` are ignored**. Marko 6.3.51 (`@marko/compiler` 5.42.5) counts `peerDependencies` when it finds taglibs/hosts (`chunk-src.js:2793`, `chunk-config.js:121` in the compiler). | decision 124 | Counting peers could silently flip a package's host (one host in dependencies, another in peers → `html`); the current rule is predictable, and #190's warnings cover the broken-input cases. | `packages/core/src/host-policy.test.ts` ("ignores a host listed only in peerDependencies", "takes the host from dependencies when another host is only a peer") |
| On the JSX hosts (preact, react, hono) and on Solid, **`<if=input.content>` with a present-but-empty body** (`${""}`, `${null}`, `${false}`, `${undefined}`) takes the **else** branch. Marko takes the **true** branch, because an empty body is still a renderer function. | mx-only (jsx-dynamic-body-text) | JSX children carry no "body present" marker: an empty body and no body are both `undefined`/falsy, so the callee cannot tell them apart. Same behaviour before this change. On Solid the empty-string body is normalized to `undefined` by the callee view. | `packages/hosts/preact/src/dynamic-body.test.ts` ("a sole placeholder body of … renders as Marko does" covers the rendered output, not the `<if>` branch) |
| On Angular, **literal `{{ x }}` and `@if (x) {`-style block text** in a template is a positioned **warning** with an MX-form hint. Marko 6.3.51 treats both as plain text with no diagnostic (probed: the html target emits `@if (title) { … } {{ title }}` verbatim). | decision 126 | The text compiles and renders literally, so an author who writes Angular syntax gets a template that silently does nothing. An mx-only lint beyond Marko, implemented in `packages/hosts/angular` only (core is untouched); warning, not error, because the text is valid. Never fires in attribute values, `${…}` placeholders, comments, or `<script>`/`<style>`/`<html-script>`/`<html-style>` bodies. | `packages/hosts/angular/test/literal-syntax-hint.test.ts` (shapes a15/a17/a25 at exact positions; attribute values, `${"{{"}` escape, comments, script/style, prose, emails stay silent); `test/cli.test.ts` (`build()` surfaces it) |
| A **dotted tag file name** under `tags/` or an `mx.tags` directory (`tags/icon.small.mx`) is **rejected** with a positioned diagnostic and never indexed. Marko 6.3.51 indexes it silently under the dotted name (`scanTagsDir.js:165-170`), which no syntax can call. | decision 137 | `<icon.small/>` and concise `icon.small` both parse as tag `icon` with shorthand class `small` (measured on Marko 6.3.51: a live probe compiles `tags/my.icon.marko` only through an import binding; the tag form raises `Unable to find entry point for custom tag <my>`). Indexing the file would create a tag nobody can call, with no word to the author. An mx-only lint beyond Marko, implemented in `@mxlang/core`'s scan; the rule names no host or target, so core holds no reserved-segment list. | `packages/core/src/scan.test.ts` ("excludes a dotted tag name no file kind claims, with the reason", "excludes a foreign file-kind segment as an uncallable name, not a host module"); `packages/targets/html/src/bun.test.ts` and `packages/hosts/hono/src/bun.test.ts` (the same two files through a Bun loader that knows only its own target) |
| A **duplicate attribute** on one tag (`<div class="a" class="b">`, `on-click` twice) emits a positioned **warning** on every host, on each dropped occurrence and naming the surviving later one with a 1-based `line:column`; never an error, `mx.strict` included. Marko 6.3.51 accepts duplicates silently (probed: `<div class="a" class="b">` compiles to `<div class=b>`, last wins, `class`/`style` not merged, the dropped value never evaluated). | decisions 133, 135 | The output matches Marko on every host (core resolves last-wins once, and html and astro apply Marko's spread precedence), so the only divergence left is the warning itself: an mx-only lint beyond Marko, a silent surprise otherwise. Implemented in `@mxlang/core`'s attribute lowering with no host branch. Names compare case-sensitively on the resolved name; a spread and `onClick` next to `on-click` do not count. | `packages/core/src/lower.test.ts` (decision 135 block); `packages/hosts/*/src/dup-attr.test.ts` (html, preact, react, hono, solid, astro) and `packages/hosts/angular/test/dup-attr.test.ts`; `packages/tooling/vite-plugin/src/duplicate-attr-build.test.ts`; `packages/tooling/tsc/src/duplicate-attr.test.ts` |
| An attribute declared **`type: "array"` or `"function"`** (with an optional `items` for the literal element type) is checked at the call site: a literal array, an arrow function, a function expression or the method shorthand `value({ post }) { … }` has a shape, a wrong shape is a positioned error (`attribute \`values\` must be array, got string`, `… item 2 must be string, got number`), and an identifier, call, member or conditional is accepted. Marko 6.3.51 enforces no declared attribute type: its taglib `type` is editor metadata that the compiler never reads (probed: `<card title=1/>` against a `title {type: string}` declaration compiles). | decisions 130, 138 | An mx-only feature beyond Marko, as `attributes` itself already is. It checks what is written and accepts what is unknowable, the rule `string` and `number` already follow, so a valid Marko file stays valid; a tag opts in by declaring the type. Language-level, in `@mxlang/core`, with no host branch (decision 126). | `packages/core/src/custom-tags.test.ts` (decision 138, E1 block) |
| On Solid, a **raw `$!{}` as the sole body of a tag with params** (`<Row\|item\|>$!{item}</Row>`, a `<define>` call, a `<${x}\|item\|>` dynamic tag, `<for\|item\|>`) is a **positioned compile error at the `$!{`**. Marko 6.3.51 accepts it and emits the raw HTML inside the children callback (probed: `_html(_html_resume(..., item))`). Solid has no wrapper-free raw-HTML form: raw HTML rides an element's `innerHTML`, and a bare string is only trusted in the SSR build, escaped on the client. Wrap it: `<div innerHTML=item/>`. | solid-raw-body-tag-params-unbound | Hoisting onto `innerHTML` left the params unbound (`ReferenceError` at render). | `packages/hosts/solid/src/raw-params.test.ts` |
| The **unnamed tag** (`<#id>`, `<.class>`, concise `#id`/`.class`) resolves through the target's **`defaultTag`** (decision 145), not always to `div`. Marko always resolves the shorthand to `div` (`@marko/compiler` 5.42.5 `chunk-src.js:6014`, `tagName.value ||= "div"`, probed on 6.3.51). Every HTML-emitting target's built-in is `div`, so every existing file is unchanged and the oracle is unchanged; the data target's built-in is `object`; a package may set `mx.<target>.defaultTag` (a tag reachable from the package that parses as a plain tag), and an invalid value is one error at the `package.json` value. | decision 145 | In MX the construct is an unnamed tag with an id/class shorthand; `div` is HTML's answer, not the language's. Core recognises the unnamed tag by its empty name span and asks a generic `resolveDefaultTag` hook; `#x` stays `id="x"`, `.a.b` stays `class="a b"`. Without the hook, using the shorthand is a positioned error. | `packages/core/src/default-tag.test.ts` |
| A static **tag name may not contain `:`**: `<tag:rest>` is the tag `tag` plus `name="rest"`, and `<:rest>` is the unnamed tag (decision 145) with `name="rest"`. Marko (`@marko/compiler` 5.42.5, parsed on 6.3.51) reads `a:b` as one tag name. Not split: a dynamic name (`<${x}:b>`) and an attribute tag's name (`<@svg:rect>`, a property key, not an element; attribute-position sugar on an attribute tag does apply: `<@z .b>` is `class="b"`). **Every host applies it, Angular included** (decision 146, addendum 3): `<svg:rect>` is the tag `svg` plus `name="rect"` on every target, and Angular's `svg:`-prefixed element form is not available in MX (wrap in `<svg>`). A second `:` in the tag head (`<a:b.c:d>`) is a positioned error: a tag takes one name. The split is post-parse, so the parser still sees `tag:rest` as the name: in HTML mode a void element needs its `/>` (`<input:email type="email"/>`; Marko says `Missing ending "input:email" tag`) and the closing tag repeats the written name (`</div:x>`) or is `</>`. Concise mode is unaffected. | decisions 146, 151 | In MX `:val` sets `name="val"` as `#val` sets `id` and `.val` sets `class`; no HTML element has a colon in its name, and the split is post-parse so it needs no parser change. Core rewrites the parsed tree once per tag, before the tag name is read, so the default-tag resolver and every contract see the tag the author meant. | `packages/core/src/name-sugar.test.ts` (tag-adjacent block); one compile row per html-family host in each `attr-name.test.ts` |
| **Bare `:x` is `name="x"`**, not Marko's `value:x`. Marko's parser fills the empty head of `:x` with `value` (an undocumented fall-out of the empty-head rule, used nowhere but the oracle fixture `attr-value-modifier`), so `<div :foo="y"/>` is `value:foo="y"` there. MX reads `:x` as sugar in every position, so `:x=1` (a value on the sugar) is a positioned error. Attribute-position `#x` is the one host-owned exception: Angular keeps it as its template reference (`<div #ref>`), while tag-adjacent `<div#x>` is the id sugar there too. The named forms are untouched: `class:x`, `style:x`, `value:fn:=x` and the explicit `value:x` keep Marko's meaning, and so does a bare `:` (`value:`). The oracle fixture `fixtures-marko/attr-value-modifier` is rewritten to the explicit `value:foo` spelling, so its Marko `expected.html` stays valid. | decisions 146, 151 | One spelling for one idea: `#id`, `.class` and `:name` read alike in every position, and the Mesh data dialect wants `name`, not `id`. The explicit `value:x` still reaches Marko's attribute. | `packages/core/src/name-sugar.test.ts` (attribute-position block); `packages/core/src/lower.test.ts` (`value:modifier` rows); the oracle fixture `packages/targets/html/fixtures-marko/attr-value-modifier` |
| **The parser after-value rule.** After whitespace inside an attribute value, a `:` followed by an identifier with no open `?` in the value, and a `.` followed by an identifier, start a new attribute instead of continuing the value (HTML and concise mode, and across a newline). The `.` half changes valid Marko: `x=a.b .c` (member access across whitespace), multi-line chains such as `x=foo\n  .bar()`, and `x=fn(a) .b` now split, so a chain is written without the space or in parentheses. The `:` half changes one valid spelling: a TS return type with a space before the colon and none after, `x=(a) :T => a` (accepted; Prettier prints `(a): T`). **The default attribute is exempt**: `<if=a\n .b>`, `<const/x=items\n  .filter()/>` and `<let/x=a .b/>` keep Marko's meaning, and sugar right after a default value is not supported. Delivered as a bun `patchedDependencies` entry on `htmljs-parser@5.15.0` (`patches/htmljs-parser@5.15.0.patch`); the `:` half is drafted as an upstream PR. **Consumers of the published packages resolve a stock `htmljs-parser`**: there `:name` after a value fails with a positioned MX error that names the rule and points at the tag-adjacent form (`<input:email type="email">`); `x=a.b .c` is silently member access on a stock parser and is not detected (a known limit). Tag-adjacent and first-position sugars work everywhere. `prettier-plugin-marko` bundles a stock parser and rewrites `<a x=a .b/>` to `<a x=a.b/>`: do not run it on MX files that use after-value sugar. | decisions 146, 151 | Sugar after an attribute value is what lets `<input type="email" :email>` read like `<input type="email" id="x">`; the parser cannot tell it from the end of the value otherwise. The `:` half breaks nothing but one valid TS spelling; the `.` half is breaking and stays an MX patch. Long-term delivery (upstream or forks) is the operator's call (decision 151, ruling 5). | `patches/htmljs-parser.test.ts` (both dist builds); `packages/core/src/name-sugar.test.ts`; `packages/core/src/stock-parser.test.ts` and `packages/targets/html/src/stock-parser.test.ts` (stock parser rebuilt in a `mktemp` copy) |
| A **shorthand class or id cannot contain `:`**: `<a.hover:x>` is class `hover` plus `name="x"` (Marko: the class `hover:x`). Core splits the static part of each shorthand `class`/`id` value at its first `:`; write a Tailwind-style class as `class="hover:x"`, which is untouched. A `:` before a `${…}` (`<a.c:b${x}>`) is a positioned error, so the rule has no exception; only the static tail after the last `${…}` splits. Same on every host. | decisions 146 (23:23 addendum), 151 | Tag-adjacent sugars compose in any order (`<a.c:b#d>`, `<a#d:b.c>`), and Marko's parser puts a `:b` that follows `.c` or `#d` inside that shorthand's value, so the split has to happen in the shorthand too. | `packages/core/src/name-sugar.test.ts` (`<a.hover:x>`, `class="hover:x"` untouched) |

**MX-only warning policy (registration PR 3 round-2 ruling).** Only full-registry tooling validates `mx.tags[].hosts` names. Own-only HTML/Hono Bun loaders, Astro templates, and Angular build/watch/discover leave peer restrictions unresolved without an unknown-name warning. An incomplete lookup cannot establish absence; registry wrappers call the name validator, while direct loaders do not. Shared Angular discovery has an explicit internal `validateHostNames` option, false by default and true only for full-registry callers. Core's public lookup contract is unchanged. Filtering and shape errors remain unchanged, and full-registry unknown bare words still warn. Pins: `packages/hosts/{html,hono,astro}/src/own-host-restrictions.test.ts` and `packages/hosts/angular/test/host-restrictions-r2.test.ts` (`hosts: ["solid"]`, plus registry-backed unknown-name discovery/build/watch with zero files). This policy concerns an MX-only config key, not a change to Marko syntax or render semantics.

### A `<return>` tag reached through a dynamic tag or a `.ts` barrel (known gap)

A `.mx` unit that declares `<return>` returns `{ value, output }`. A direct
default import (`import Counter from "./counter.mx"`, `<Counter/>`) and a
discovered tag unwrap it; Marko 6.3.51 renders the body and drops the value in
every form. A dynamic tag (`<${x}/>`) and a `.ts` barrel re-export
(`export { default as Counter } from "./counter.mx"`) go through the host's
runtime dispatch, which does not unwrap, so on `@mxlang/html` the call renders
`[object Object]`. The shape is not knowable at compile time there, so there is
no compile-time refusal. Not even a dynamic tag whose expression is a plain
identifier bound by an import of such a unit can be refused in core: whether
the dispatch unwraps is a host fact (Solid and Astro render it correctly, the
html and JSX hosts do not), and core holds nothing host-specific. Use a direct
`.mx` import or a discovered tag. Runtime fix: TODO `dynamic-tag-return-unit-object-object`.

## Fixed: undocumented divergence in the bare `${expr}` line

A standalone concise-position `${expr}` line (no attributes, no body) used to
lower to an escaped interpolation whenever no host claimed `DYNAMIC_TAG` —
treating Marko's placeholder-shaped `MarkoTag` as though it always meant a
text placeholder. Real Marko does not: Marko's own fixture
`error-dynamic-tag-name`
(`packages/targets/html/fixtures-marko/error-dynamic-tag-name/`,
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
fixed, and each fixture under `packages/targets/html/fixtures-marko/` asserts
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
