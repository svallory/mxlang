---
title: "Specification"
description: "The normative MX language specification — what every construct means, its syntax, its semantics per host, and the errors core owns."
---

# The MX language

**Status: normative.** This is the reference for what an MX construct *means*.
Where this document and the code disagree, that is a bug in one of them and the
disagreement gets filed, not resolved silently by a reader.

Written 2026-09-17 by backfilling the code, `notes/decisions-2026-09-10.md`
(entries 1–99), `worktrees/main/divergences.md`, `notes/specs/custom-tags.md`,
`notes/solidmx-spec.md`, and the six docs-site language pages. Where the docs
site and the code disagreed, **the code won** and the docs claim is recorded in
[§16 Docs to fix](#16-docs-to-fix) rather than repeated here.

**This file lives in the repo at `apps/docs/docs/specification.md` and is served
on the docs site at [`/specification/`](https://mxlang.dev/specification/).** The
process rule that keeps it current is in the repo's `AGENTS.md` under "Language
spec": a PR that changes syntax or semantics updates this file in the same
change, citing the decision number; a decision entry that changes the language
names the section it updates.

## How to read this

Three documents, three questions:

| Document | Question |
|---|---|
| `apps/docs/docs/` (the docs site) | How do I use it? |
| `notes/decisions-2026-09-10.md` | When and why did we choose it? |
| **this file** | What does it mean? |

Each section carries **syntax** (as Marko's, with MX 1's subset stated),
**semantics** (portable, or per host), **errors** (exact strings where the core
owns them), the **decisions** that fixed it, and **open questions** where the
answer genuinely is not settled.

### Conventions

- A message in `code font` is the **exact** string the compiler produces.
  `${…}` inside one is a template placeholder, shown as it appears in source.
- **Core-owned** means `@mxlang/core` raises it for every host. **Host-defined**
  means the host's `HostDeclarations` decides, and the host table says what each
  one chose.
- "MX 1" is the current language. "MX 2" is the next major, where deliberate
  divergence from Marko becomes permissible (decision 72).
- Citations are decision numbers from `notes/decisions-2026-09-10.md`. That log
  is **not monotonic** and has **two entries numbered 33**; this file cites them
  as *33 (retarget finding)* and *33 (lead ruling)*.

### Reserved generated identifiers

Identifiers beginning with `__mx` are reserved for generated code. Authors
must not declare bindings with that prefix, including tag variables, imports,
module statements, surrounding TypeScript bindings and Astro frontmatter.
For example, `__mxAttrValue` and `__mxAttrSpread` name generated runtime helpers.

Core rejects these bindings before host lowering, including destructured tag
variables and parameters, scriptlet declarations, imports and module statements.
Host code that MX parses (the Astro fence and surrounding `.solid.mx`/`.ng.mx`
TypeScript) uses the same check. The error points at the binding:
`Identifiers starting with "__mx" are reserved for generated code; rename "__mxX".`
Property names, strings and references are not declarations. Public helper
exports retain their names; generated imports use private aliases.

This is stricter than Marko 6.3.51, which accepts `__mxX`, `_x`, `__x`, `$x`
and `$mxX` bindings (tag variables and `static` declarations). It is an
MX-only safety restriction (reserve-mx-identifiers; decision 72's explicit
stricter-validation policy), not a `$`- or `_`-prefix reservation.

Type-only names stay legal: a type parameter (`infer __mxU`, `[__mxK in keyof
T]`) and a `declare function`'s parameters cannot collide with an emitted
binding, so they are not rejected.

**Known gaps.** The reservation protects the `__mx` prefix only. Some generated
names outside it are still source-allocated rather than reserved, and two
families are known to still collide with an authored name: the Solid
whole-unit `$mxProps`/`$mxBody`/`$mxValue` helpers and hoisted `$mx_Define*`
tags, and the range mapper's `_` and `mxIndex` temporaries in the JSX and Solid
hosts (`<const/_=5/>` with `<for|i| from=_ to=_+2>` renders wrong today).
Those are tracked as follow-ups; reserving `__mx` does not claim to fix them.

### The governing rule

> **MX 1.0 is a strict subset of Marko syntax.** Every MX 1.0 file is a valid
> Marko file with the same meaning for the structural core. Hosts may only
> *forbid* a tag they cannot honor — never add syntax, attribute forms, or file
> conventions Marko's parser and language server would reject.
> — decisions 71, 72; `divergences.md`

Two consequences that settle most "is this legal" questions without a new
ruling:

1. **Syntax MX never decided is Marko's.** Boolean attributes, spread
   attributes, `--` text lines, concise mode: MX inherits them by being a
   subset. Their absence from the decision log is not a gap in the language.
2. **`divergences.md` records zero deliberate divergences today.** Anything MX
   rejects that Marko accepts is either a host forbidding what it cannot honor,
   or a construct deferred to MX 2 with a row in that file.

---

## 1. File kinds

MX compiles four file kinds. They are **different kinds, not variants**: the
extension selects a compilation model, not a flavour of one language.

| Extension | What it is | Compiles to | Status |
|---|---|---|---|
| `.mx` | A whole-file MX template | The host's module (`(input) => string`, a JSX component, an Angular template) | Shipped |
| `.solid.mx` | A TypeScript module with **MX regions** in expression position | Solid 2 JSX text | Shipped |
| `.astro.mx` | An Astro component whose template is MX | An `.astro` module | Shipped |
| `.ng.mx` | An Angular region file | `.ts` with an inline `template` | **Not built** (decisions 96, 99) |

### Whole files vs region files

A **whole file** (`.mx`, `.astro.mx`) is parsed by `@marko/compiler` from the first
byte. Its module level is real module scope, so `import`/`static`/`export`
place statements there (§2).

A **region file** (`.solid.mx`, and `.ng.mx` when built) is a TypeScript module
in which `<` in expression position opens an MX region. The region is an
*expression*, so it has **no module scope of its own**. This is the single fact
that makes region files behave differently everywhere it matters:

- An authored `import`/`static`/`export` inside a region is an error — the
  author has a real module to put it in (§2).
- A discovered tag's *synthesized* import cannot go in the region, so it is
  handed to the caller on `CompileSolidMxResult.hoistedImports` and placed in
  the surrounding module (§9.6).
- A region cannot call a tag defined in its own file, because it exports
  nothing to call (§9.6).

### Extension policy

**`.mx` is the only template extension.** No product path accepts or advertises
`.marko` (decision 86, superseding decision 72's alias). Every loader — the Bun
loaders, `@mxlang/vite-plugin`, the language server, the TypeScript plugin,
`mx-tsc`, the editor extensions — accepts `.mx`, `.solid.mx` and `.astro.mx` only,
and `mx()`/`mxAstro()` **reject** `.marko` in their `extensions` option.

Porting a Marko component that stays inside the MX 1 subset is therefore a
rename. The reason the alias died: MX supports only the subset, so treating an
arbitrary `.marko` file as MX would silently claim support MX does not have.

Two narrow exceptions, both outside the product path:

- **The oracle** keeps 43 stock fixtures as real `.marko` files, because Marko's
  own compiler requires that extension. It feeds them to MX by *content*, under
  a virtual sibling `.mx` filename in the same directory.
- **`tags/` discovery under `@marko/compiler`.** Its `scanTagsDir` discovers only
  files whose actual extension is `.marko` (measured in 5.42.5). A `.mx` file in
  such a directory is not discovered at all. This is Marko's own behavior during
  a whole-file compile, not an MX entry point.

### Why an `.astro.mx` file cannot be a page

Decision 134 spells the Astro template kind `.astro.mx`, like `.solid.mx`
(`<name>.<host>.mx`); it replaces the single-dot `.amx` of decisions 76c and 78.
It is for components and layouts. Astro's route collection keys on
`path.extname(basename)` — the **last** extension segment only. Measured
against astro@7.3.2: a `page.astro.mx` under `src/pages` routes to
`/page.astro`, with a literal `.astro` in the URL, and `injectRoute` cannot
repair it. Per the decision 134 addendum, an `.astro.mx` file under the pages
directory is an error from the Astro integration, in `astro dev` and
`astro build`. The message names every offending file and gives the fix: write
`about.astro` and import the `.astro.mx` component from it, or write the page
as `about.mx`. Pages written as `.mx` are unaffected. When Astro matches the
longest registered page extension, pages follow with no language change.

> **Open question.** `.solid.mx` was left "for now" by decisions 69, 70 and 72;
> no ruling ever finalized it. It is shipped and stable in practice.

**Decisions:** 72, 78, 86, 96, 99; region-file consequences 95, 97.

---

## 2. Module level

### Syntax

`import`, `static` and `export` parse as **tags**, not statements — their
attributes are the remaining words. This is Marko's grammar, and it has a
consequence that costs real debugging time: `start` and `end` are `undefined`
on these nodes, so the statement text is recovered by slicing on
`loc` line/column.

```mx
import { formatDate } from "./util.ts"

static const GREETING = "Welcome"

export interface Input { name: string }

<h1>${GREETING}, ${formatDate(input.date)}</h1>
```

### Semantics

Portable on every whole-file host.

| Construct | Meaning |
|---|---|
| `import` | Reaches module scope **verbatim**. Bindings register into `ctx.imports` immediately, so a later tag can resolve against them. |
| `static` | Runs **once at module load**, not per render. The leading `static\s+` is stripped; the rest hoists verbatim. |
| `export interface Input` | Hoisted verbatim; becomes the render function's input type. |
| any other `export` | Hoisted verbatim to real module scope. |

That last row is load-bearing and recent: an MX file's TypeScript section used
to be allowed to export *only* `interface Input`, and any other top-level
`export` was a hard error. Lifting it is what lets an `.mx` **page** export
`getStaticPaths` and `prerender` as real named exports for Astro's router.

Import binding names are recovered by **parsing** the hoisted line with Babel —
default, namespace, named, aliased and combined forms — never by regex.

**Neither explicit imports nor `export interface Input` are required.** Both
were conventions of the retired `.mx` dialect, killed by decisions 65 and 68 and
kept dead by 72. Marko allows arbitrary TypeScript in a `static` block
regardless.

### Region files

An **authored** `import`/`static`/`export`/`export interface` inside a
`.solid.mx` region is a positioned error: the region is an expression inside a
module that already has module scope, so the author has somewhere correct to put
it. A **synthesized** import (one MX injected for a discovered tag) is not an
error — it is handed back for the caller to place. The split is by *origin*,
carried on `Import.synthesized`; every whole-file host emits both kinds
identically and ignores the flag.

**A region has exactly one root; a fragment region has several.** A region is
one expression, so a second root directly after it (`<a/><b/>`) is a positioned
error naming the rule and the way out, on every region file. Wrapping the
siblings in `<>…</>` is that way out, and what it means depends on the host:

- In `.solid.mx` `<>…</>` is a TSX fragment (the output is JSX, so there is
  nothing to lower); each MX child is its own region.
- In `.ng.mx` it is a **fragment region** (the parser's `mxRegionFragment`
  option, on for this host only): the host lowers its children as siblings,
  exactly as it lowers a page template with several roots, and no wrapper
  element or comment node reaches the Angular template. `<></>` and `<>text</>`
  are regions too. A fragment cannot contain a fragment, and must be closed with
  `</>`.

Marko has no expression-position templates, so this is a host decision, not a
Marko semantic (decision 120).

### Errors

Core-owned:

| Message | When |
|---|---|
| `unrecognized statement tag \`${name}\`; expected \`import\`, \`static\`, or \`export\`` | A statement tag reached the statement lowerer under another name. A guard, unreachable through the normal tag switch. |

### `server` and `client` blocks

A `server` block is **not** inert on the html target — that target *is* the server
render, so it runs and hoists like `static`, and its bindings are readable from
the template (decision 67a; verified: `server const S = 41 + 1` then `${S}`
renders `42`). A `client` block is client-only and is inert or an error per host
(§14).

**Decisions:** 65, 67a, 68, 70, 71, 72, 95(3), 97(d), 97(j).

---

## 3. Text and interpolation

### Interpolation

| Syntax | Meaning |
|---|---|
| `${expr}` | Interpolate, **escaped** |
| `$!{expr}` | Interpolate **raw**, no escaping |

`escape(value)` escapes `& < > " '`; `null` and `undefined` render as the empty
string, not their names. It treats its input as **literal text**, so `&` becomes
`&amp;` and `&amp;` becomes `&amp;amp;` — pinned by test (decision 45).

`$!{…}` is **not accepted inside an attribute value**; Marko's parser rejects it
there before any host runs. Host handling of `$!{}` in content position varies
(§13): the Solid host lowers a lone `$!{html}` child to `innerHTML` and errors on
a mixed body or a body with tag params (`<Row|item|>$!{item}</Row>`, `<for|item|>`: Marko renders it in the callback, Solid has no wrapper-free raw form; wrap in `<div innerHTML=item/>`); the Angular host emits `[innerHTML]` with a warning.

Core raises no dedicated interpolation diagnostic — a `MarkoPlaceholder` lowers
unconditionally with `escaped` taken from the node, so `$!{}` is simply
`escaped: false`.

### Whitespace

**MX follows Marko's rule, not JSX's, and does not implement it.** Marko's own
`onText` has already applied it before `@mxlang/core` sees a text node. There is
no `normalizeText` in core, and **a second normalization pass on any host's path
would collapse whitespace twice** — this is the same single rule on every host,
SolidMX included.

Marko's parser owns boundary trimming and collapses remaining whitespace
runs with `value.replace(/\s+/g, " ")` (decisions 33 and 141). It ignores
comments when finding adjacent content. At a body's beginning/end it removes
leading/trailing CR/LF plus indentation; a whitespace-only run beginning with
CR/LF is dropped by `onText` before a node is created. `preserveWhitespace`
parse options bypass that normalization.

Consequences, measured against Marko 6.3.51:

- A whitespace-only body **beginning with a newline**, such as `"\n  "` or
  `"\r\n\t  "`, is dropped — ordinary indentation contributes nothing.
- Same-line spaces, tabs, or a mixture collapse to one space.
- `" \n "` retains one space: the initial space precedes the newline.
  “Contains a newline” alone is not Marko's drop test.
- `"\n  static\n  "` before `<span>` is `"static"` with **no** trailing space.
- `"a\n  b"` is `"a b"`.
- `${" "}` is the escape hatch for a literal space the newline rule would drop.
- **Comments are not content** and do not count when trimming.

**Body presence (decision 141).** Core tests the already-normalized text for
nonemptiness, never `.trim()`s it. `<Wrap> </Wrap>` and `<wrap>\t  </wrap>`
therefore supply one-space content, through both imports and discovered
`tags/*.mx`; `<Wrap>\n  </Wrap>` supplies no content. A comment alone supplies
none, while `<!--note--> ` supplies a space. All seven hosts preserve that
text when forwarding the body; Angular uses `&ngsp;` so its own template
whitespace removal cannot discard the space. The data target's pass-through
tree carries the same normalized text, and `structural: "reject"` rejects a
retained space as text. The rendered parity matrix is
`test-fixtures/body-whitespace/cases.json`.

```mx
<p>
  Hello
</p>
```

renders `<p>Hello</p>`.

### Text lines (`--`)

Concise mode's delimited text block. Inherited from Marko under the subset rule;
no MX decision fixes it and **no MX fixture exercises it**. The parser's own
constraint, verbatim from htmljs-parser's `CONCISE_HTML_CONTENT`:

> `A line in concise mode cannot start with a single hyphen. Use "--" instead.`

A concise line starting with `/` that is not `//` or `/*` is likewise an error:

> `A line in concise mode cannot start with "/" unless it starts a "//" or "/*" comment`

> **Open question.** `--` text lines are legal MX by inheritance but untested.
> Before relying on them, add a fixture.

### A bare `${expr}` line

**Corrected 2026-09-17 (core PR #103, main `50877ea8`), superseding the rule
this section stated before.** In concise mode a bare `${expr}` on its own line
parses as a **`MarkoTag` whose `name` is the expression**, with no attributes
and no body — the grammar has no other shape for it. Real Marko does not treat
that as a text placeholder: a bare `${expr}` line and the tagged `<${expr}
.../>` form parse to the identical node and are **the same dynamic-tag
construct** (§11/§7). Marko's own fixture
(`packages/targets/html/fixtures-marko/error-dynamic-tag-name/`) proves it: a
bare `${tagName}` at column 0 fails at render with "Invalid tag name" — it
compiled to a dynamic tag, not a placeholder.

Both shapes now lower alike (`lowerTag`, decision — a `DelegatedTag` for a host
claiming `DYNAMIC_TAG` with `shape` `"bare"`/`"tagged"`, or, unclaimed, a
`Component` with a dynamic target):

- A host that claims `DYNAMIC_TAG` gets the identical `DelegatedTag` for either
  shape (`isDelegatedTag(name, ctx, shape)` can inspect `shape` to opt a *new* host
  out of the bare form, but every existing host ignores it and claims both).
- A host that does not claim `DYNAMIC_TAG` gets a dynamic-target `Component`
  for either shape — no compile error, no silent `Interpolation`.

Text on its own line needs the escape hatch, `-- ${expr}`. A placeholder
inside an HTML-syntax body (`<div>${expr}</div>`) is unrelated: it parses as a
real `MarkoPlaceholder`, never a `MarkoTag`, and never reaches this rule at
all — `${expr}` there is always an ordinary interpolation.

The superseded rule (MX 1.0 through 2026-09-17) treated an unclaimed bare
shape as a silent `Interpolation` — an undocumented divergence from Marko with
no fixture proving it, recorded in `divergences.md`'s "Fixed: undocumented
divergence in the bare `${expr}` line."

### HTML comments

`<!doctype html>` arrives as a `MarkoDocumentType` whose `value` is
`doctype html` with delimiters stripped, re-emitted as `<!${value}>`. Marko
strips comment delimiters too, so an HTML comment and a `//` line comment are
told apart by re-reading the source at the node's `loc`.

`<html-comment>` renders a literal HTML comment and **lowers placeholders inside
it**, through a comment-safe escape that escapes **only `>`** — `<`, `&` and
quotes pass through raw, matching Marko's `_escape_comment`. Filtering the
placeholders out instead (an early bug) turned
`<html-comment>build ${input.sha}</html-comment>` into `<!--build -->`.

### Scriptlets

`$ statement` is **rejected on every host**:

| Message | When |
|---|---|
| `scriptlets (\`$ statement\`) are not supported in MX (decision 54)` | A `MarkoScriptlet` appears in any child list. |

Decision 54's reasoning: Marko 6's reactive compiler cannot assign a bare
statement re-run, dependency, server/client or serialization semantics.
Template mode's output *is* linear, so scriptlets would be sound there — but
admitting them only there would fork the language. Revisit when the reactive
mode is built or killed.

### CDATA sections and XML declarations

`<![CDATA[…]]>` and `<?…?>` are **rejected on every host**:

| Message | When |
|---|---|
| `` `<![CDATA[…]]>` is not supported: write the text inline, as `${"…"}` when it must stay raw, or in an attribute value `` | A `MarkoCDATA` appears in any child list. |
| `` `<?…?>` (an XML declaration or processing instruction) is not supported: remove it `` | A `MarkoDeclaration` appears in any child list. |

Marko 6.3.51 rejects both (`runtime-tags/src/translator/visitors/cdata.ts`,
`visitors/declaration.ts`); its `__tests__/fixtures/cdata` snapshot puts the
error on the `<` of the construct, which is where MX puts it too. MX keeps
Marko's meaning and names the fix in the message.

The IR has no node for either construct, so this is a rejection in lowering
rather than a pass-through kind — the alternative would be two new IR node
types that every host would then have to decide what to emit.

One exception, and it is the parser's, not lowering's: a **raw-text** body
(`<script>`, `<style>`, `<textarea>`, `<title>`) is read by Marko's parser as a
single `MarkoText`, so the construct there is ordinary text: it stays text, as the
body's other text does (the html target does not emit a `<script>` body). `<style>a <![CDATA[ b < c ]]></style>` is a stylesheet holding
the literal text `<![CDATA[ b < c ]]>`, not a CDATA section.

**Decisions:** 12 (superseded), 33 (both entries), 45, 54, 14, 96, 139.

---

## 4. Elements and attributes

### Element resolution

MX decides element-vs-component by **in-scope binding and case**, which is
Marko's own rule, not JSX's. The full precedence chain is in §11.

### Void elements

The HTML void elements —
`area base br col embed hr img input link meta param source track wbr` — parse
**without a slash**: `<input value=x>` is legal. A void tag written with a
closing tag is a parse error (decision 13).

### Attribute forms

| Form | Syntax | Notes |
|---|---|---|
| Static | `class="card"` | |
| Dynamic | `value=expr` | |
| Boolean | `disabled` | Inherited from Marko; no MX decision |
| Spread | `...props` | Accepted on elements without diagnostic |
| Bound (`:=`) | `value:=count` | **Stateful** — host-defined (§14) |
| Modifier | `class:active=on` | **Not Marko syntax** — see below |
| Namespaced name | `:foo=y`, `value:foo=y` | Marko's own attribute named `value:foo` — see below |
| Method | `onClick() { … }` | Event handler — host-defined, see below |

On Preact, React and Hono, tooling checks named, non-event native-element
props against the host's own JSX types and reports a mismatch at the authored
attribute name (decision 140 (b)). This includes renamed `class`/`for` props
and `key`/`ref`; event handlers use their separate type-check projection.
Spreads have no authored prop name, default attributes have a zero-width name
span, and custom elements do not acquire native-prop name diagnostics from
this rule. Runtime output is unchanged.

### Native attribute value rendering

On the html target, native `null`, `undefined` and `false` values omit the
attribute; `true` emits an empty attribute, and `0`, `""` and `NaN` are
retained. This applies to direct expressions, colon names, bindings, merged
spreads, computed spread keys and string-valued dynamic tags, including
`aria-*` and `data-*` (Marko 6.3.51 omits `aria-hidden=false` too).
`class`/`style` omit falsy primitive values and stringify `true` as `"true"`.
A direct or bound `<input checked=…>` emits presence for any value other
than `null`, `undefined` or `false`; with spreads or a dynamic tag, `checked`
uses the ordinary value writer. Dynamic native void tags emit no closing tag.
Expressions are evaluated exactly once.
These are measured Marko parity rules (decisions 65 and 67), not changes to
core's host-independent attribute IR. Other hosts retain their native
framework serializers; boolean, class/style and controlled-value differences
remain host-specific compatibility gaps.

On html, Preact, React, Hono and Astro, an ordinary native attribute
whose object value cannot be coerced to a useful string fails **at render
time**, matching Marko 6.3.51's debug-runtime assertion. This always-on guard
is stricter than optimized Marko output, which renders plain objects as
`[object Object]` rather than running the debug assertion:

> The `data-x` attribute cannot be a plain object (it would render as `[object Object]`).

Functions and symbols fail with `The `data-x` attribute cannot be a function.`
and the corresponding `cannot be a symbol.` text. This includes
null-prototype objects and failed object coercion, not just an
`Object.prototype` check. Arrays with renderable members, meaningful custom
`toString` values and Dates remain valid. `class` and `style` retain their
host's structured writers; controlled `input.checked` / `checkedValue`,
`details.open` / `dialog.open` and `select.value` / `textarea.value` are not
ordinary attribute writers. Component props are not native attributes.
Host-only `ref`, `key` and raw-HTML props retain their framework contracts.

Spreads are merged before validation: only the final surviving value is
checked. A superseded object value does not cause an error, and authored
expressions are evaluated once, retaining the host's existing evaluation order. String-valued dynamic tags use the
native rule; component-valued dynamic tags still forward props unchanged.

**Known gaps:** Solid's native attribute rendering remains unchanged: its
candidate failed the compiler byte-parity oracle and was left out rather
than weakening that gate. It still accepts plain objects or raises its own
coercion error. Angular's existing attribute bindings still stringify plain
objects or raise Angular's own coercion error. All Angular host paths,
including `.ng.mx` and generated tag classes, remain unchanged pending a
lead ruling on the compatibility of requiring runtime helpers on authored
page classes. No new instance member is required by this change.

**Decisions:** 67 (Marko parity), 135 (last-wins spread precedence).

### Duplicate attributes

Within one tag, the **last** occurrence of an attribute name wins, on every
host and target (decision 135). `@mxlang/core` resolves it during lowering: the
IR carries one attribute per resolved name, the last one with its own spans, so
no host emitter or delegated-tag consumer ever sees a duplicate. This is
stock Marko 6.3.51's behavior, probed: `<div class="a" id="x" class="b">`
compiles to `<div id=x class=b>` (the survivor keeps **its own** position),
the dropped value is never evaluated (`<div title=f() title=g()>` calls only
`g`), and `class`/`style` are not merged.

Each dropped occurrence is a **positioned warning**, never an error (`mx.strict`
included), and the build and `mx-tsc` exit codes are unchanged. The warning sits
at the dropped attribute's name and names the surviving later one by
`line:column` (1-based line and column in the text, like `mx-tsc` and editors;
UTF-16 code units). Three occurrences give two warnings, each naming the last:

> `duplicate attribute \`class\`: the later one at 1:16 wins, so this one is dropped`

| Case | Result |
|---|---|
| Same name, case-sensitive (`class` twice, `on-click` twice) | last wins; one warning per dropped occurrence |
| `<input="a" value="b">` (a default attribute is named `value`) | `value="b"` wins; warns |
| `<div a=1 ...x a=2>` | `a=2`, as `a=2` already won over `x.a`; warns |
| `<div a=1 ...x>`, `<div ...x a=1>` | no duplicate; a spread has no static name; silent |
| `class` and `Class`, `data-a` and `data-A` | distinct names, as in Marko; silent |
| `onClick` next to `on-click` | distinct names (Marko registers both handlers); silent |
| Angular `x`, `[x]`, `(x)`, `#x` | distinct names; silent |
| The same name on different tags | silent |
| `<Card a=1 a=2/>`, `<@x a=1 a=2/>` | the callee receives one `a`, the last |

Spreads follow the same rule on a string-concatenating target: `@mxlang/html`
and `@mxlang/astro` make the object-merge precedence explicit (an explicit
attribute written after a spread suppresses the spread's key, and a spread
written after an explicit attribute suppresses that attribute), so a browser,
which keeps the first duplicate, sees the survivor. This is tested by rendering.

The warning is an mx-only lint beyond Marko (which accepts ordinary duplicate
attributes silently), recorded in `divergences.md`; decisions 133 and 135.

Builtin value syntax is different: duplicate shorthand/named/bound `value`
spellings on `<let>` and `<return>` fail with Marko's
`Invalid duplicate value attribute.` at the second value's authored name.
The equivalent `<const>` / `<id>` duplicates retain their tag-specific linked
“only supports the `value=` attribute” diagnostic at the tag name, matching
live Marko 6.3.51 rather than ordinary last-wins normalization. Delegated
vocabulary names such as a data tag named `id` are not compiler builtins and
retain ordinary attribute normalization.

### `class` and `style`

Both take **structured values**, lowered by the host:

- `class={a: true, b: false}` → `class="a"`
- `class=["x", {y: true}]` → `class="x y"`
- `style={color: "red", top: 0}` → `style="color:red;top:0"`

Shorthand merging (decision 9, positional fix in decision 30):

| Written | Result |
|---|---|
| shorthand `.card` + `class="x"` | `class="card x"` (shorthand first) |
| shorthand `.card` + `class={…}` object | Solid 2's array form, `class={["card", {…}]}` |
| shorthand + static `class="x"` + object | folds into the string entry: `class={["card x", {…}]}` |
| shorthand + any **other** dynamic `class=` (identifier, call, ternary) | **parse error** |
| `#id` shorthand + explicit `id=` | **parse error** |

The merge is emitted **at the explicit attribute's position**, not pushed to the
front — otherwise the attribute is emitted twice and the second wins
(decision 30).

`style=` accepts an **object literal only**: `style={color: c()}` →
`style={{color: c()}}`. Any other `style=` expression is a parse error in MX 1.

### `class:foo` / `style:foo` modifiers

**Reserved on native elements** — not "something MX cannot express" (decision 67b,
measured against 5.42.5). Marko's native-element *taglib* rejects every form of them with its
own fix-it (the parser itself parses them; the translator's taglib lookup is
what refuses):

> `class:active` is not a valid attribute, did you mean `class={ active: condition }`?

Native-element uses therefore fail rather than becoming class/style toggles.
Component props have no such reservation: `<Card class:active=c/>` forwards
`class:active` unchanged. Where a native modifier reaches a host, core raises:

| Message | When |
|---|---|
| `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in a standalone template` | A modifier survived to the lowerer and the host's `resolveModifier` declined it. |

### `:modifier` — ordinary `value:` attribute names

Marko's parser splits an attribute name at its **last** `:` and fills an empty
head with `value` (`babel-plugin/parser.js`, `onAttrName`). So `<div :foo="y"/>`
is not a modifier at all: it is one attribute literally named `value:foo`,
which Marko compiles and renders as `<div value:foo=y>`. The long spelling
(`<div value:foo="y"/>`) is the same attribute, and `<div :foo:a="y"/>` is a
parse error in both. An empty modifier still contributes its colon: `<div :/>`
means an attribute named `value:` with an empty value. The same preservation
applies to any ordinary name: `<div x:/>` means `x:` with an empty value,
`<div x: = "s"/>` means `x:` with value `"s"`, and `<div x: = expr/>`
means `x:` with the expression's value (decision 65, Marko parity). The space
before `=` matters: `x:=expr` is a binding, not an empty-modifier attribute.
Every `name:mod` is an ordinary complete name, including `x:foo`, `data:x`
and names with multiple colons. Only native-element `class:`, `style:` and
`on:` prefixes are reserved, including empty suffixes and additional colons
(decision 67b); component props have no such reservation, so both
`<Card class: = expr/>` and `<Card class:active=expr/>` forward the complete name.
An expression-valued native event such as `onClick: = fn` keeps its event name
`click:`, not an ordinary spread key (decision 101). Authored spread expressions
and their keys are not rewritten. An explicit head can
already contain colons: `<div value:foo:bar="y"/>` splits into the head
`value:foo` and modifier `bar`, then emits the complete name `value:foo:bar`.
JSX cannot spell an empty namespace suffix or multiple colons as an attribute;
preact/react/hono and Solid carry these names through string-keyed object
spreads instead, without changing the prop name or value. Angular's template
parser cannot tokenize a literal attribute with an empty namespace suffix;
`<div :/>` and `<div x:/>` therefore give a positioned error at the authored
attribute name on Angular (printed 1:6), as do static and dynamic values of
`x:`, rather than emitting an unparseable template.
Explicit multi-colon names such as `value:foo:bar` remain supported there.
Angular also forbids dynamic bindings to ordinary names beginning with `on`
for security reasons: `oncapture:click=expr` gives a positioned Angular-specific
refusal, not a Marko-syntax error; the static string form remains supported.

Function values on ordinary, non-event native colon names (method syntax,
function expressions or arrows) report `The \`name:mod\` attribute cannot be a function.`
Calls with attribute arguments report `Unsupported arguments on the \`name:mod\` attribute.`
Both errors point at the authored attribute name: `<div x:() {}/>` reports
`The \`x:\` attribute cannot be a function.` and `<div x:foo()="y"/>` reports
`Unsupported arguments on the \`x:foo\` attribute.`, both at printed 1:6
(structured line 1, column 5). A function value takes precedence over arguments.
Event attributes and component props retain their host's callable-prop policy.
A binding (`:=`) is a different form and keeps the base name. On native
elements, dynamic tags, ordinary component calls and built-in control tags,
its target must be an identifier or a member expression (including optional
members, excluding private members); otherwise core reports Marko's
`Attributes may only be bound to identifiers or member expressions` at the
value. For example, `<div :="x"/>` errors at structured line 1, column 7
(printed 1:8), rather than silently rendering `value="x"`. Host-specific binding
support is unchanged. Validation precedes control-flow lowering, including
controls containing attribute tags, so an invalid binding cannot be discarded.
Uncontracted attribute tags follow the same binding-reference rule. Calls
resolved through registered custom-tag contracts, including their recursive
attribute-tag contracts, retain their own bound-value shape/item checks
(decision 138, E1/E4), including literal arrays. A local binding shadowing a registered tag is an
ordinary component call, not a contract-backed exemption.

| Authored | Meaning | html | preact/react/hono | solid | `.astro.mx` | angular |
|---|---|---|---|---|---|---|
| `<div :foo="x"/>` | attribute `value:foo` = `"x"` | `value:foo="x"` | `value:foo="x"` | `value:foo="x"` | `value:foo="x"` | `value:foo="x"` |
| `<div :foo=y/>` | attribute `value:foo` = `y` | `value:foo="y"` | `value:foo={y}` | `value:foo={y}` | `value:foo={y}` | `[attr.value:foo]="y"` |
| `<div :foo/>` | attribute `value:foo` = `""` | `value:foo=""` | `value:foo=""` | `value:foo=""` | `value:foo=""` | `value:foo=""` |

The valueless form is HTML's *empty* attribute — `<div value:foo>` and
`<div value:foo="">` are one thing to every HTML parser — so it lowers to the
empty string rather than to `true`: a host handed `true` renders React's
non-boolean-attribute warning and drops the attribute, and renders
`value:foo="true"` on Hono. On Angular a dynamic name cannot be a property
binding (`[value:foo]` binds a property no element has, NG8002), so it takes
the same `[attr.name]` route as a dynamic `data-*`/`aria-*` attribute; a static
one is carried through verbatim.

Core does not treat `prop:`, `oncapture:`, `attr:`, `bool:` or `use:` names as
modifiers: they preserve their complete names instead of being refused as
invalid Marko syntax. This corrects decision 10's namespace-removal policy
against live Marko 6.3.51; a host runtime/compiler still owns how an emitted
name is interpreted (for example Solid's own `prop:` namespace and Astro's
`set:`/`is:` directives).

On `.astro.mx`, authored native `define:`, `is:`, `transition:`, `client:` and
`server:` names, plus the exact `slot` attribute, use computed string-keyed
spreads to render escaped **plain attributes**, not Astro directives or implicit
named-slot projections (decisions 65 and 67b, Marko parity). Their dynamic values
are evaluated once; `true` writes an empty attribute and `false` omits it, as in
Marko. String-typed computed keys avoid Astro's directive-specific JSX types
without suppressing errors in the authored value expression. Directive-shaped
props on component calls and attributes on special `style`/`script`/`slot`
elements are refused at the authored name where plain-attribute semantics cannot
be guaranteed. Authored `set:html`/`set:text` names are refused because Astro's
native runtime filters them even through a spread; other `set:` names use the
plain-attribute spread form. Component `class:list` props
are refused because Astro normalizes them into `class`. Native `class:` remains
reserved as above. Ordinary `slot:foo` is not Astro's exact `slot` directive.
MX-generated directives for structured `class`, unescaped interpolation and
explicit attribute-tag slot projection are unchanged; authored spreads are not
rewritten.

HTML's reserved-prefix diagnostics use the first head and the entire remaining
suffix, matching Marko's text: `class:foo:bar` suggests
`class={ foo:bar: condition }`, `style:foo:bar` suggests
`style={ foo:bar: value }`, and `on:foo:bar` suggests `onFoo:bar`.

### Event attributes

An attribute on an **element** whose name matches `/^on[A-Z-]/` is an event
handler. Its value is the handler expression; its **DOM event name** is derived
as:

- `on<Name>` → everything after `on`, **lowercased**: `onClick` → `click`,
  `onDblClick` → `dblclick`, `onPointerDown` → `pointerdown`.
- `on-<exact>` → the text after `on-`, **verbatim**. Use it for a custom event,
  or any name the camelCase form cannot spell (capitals, dashes, dots, colons):
  `on-my-event`, `on-DOMContentLoaded`, `on-update:modelValue`.

The rule is Marko's own, so an MX template and the equivalent Marko template
bind the same event. Core lowers the attribute to an `Attr` of kind `event`
carrying both the source spelling (`name`) and the resolved DOM name (`event`);
each host recomposes its own form from `event`, so `onDblClick` and
`on-dblclick` are two spellings that produce identical output on every host —
on Solid, Preact and hono that emission is `onDblclick` (capitalize-first of
the DOM name; those runtimes lowercase the prop at bind time). One host
recomposes by **lookup, not by rule**: React's prop names are camelCase data
from react-dom's own registration table (`simpleEventPluginEvents`), which no
derivation can reverse (`keydown` → React's `onKeyDown`, never `onKeydown`), so
the React target vendors React's list and looks the spelling up. The DOM name
from `on<Name>`/`on-<exact>` is the input; the React spelling is a lookup in
React's table.

A name that is **not** event-shaped — `onclick`, `once`, `on` — is an ordinary
attribute. `<div on="x">` is data.

**The kind is derived only for an expression value.** A bare `<div onClick>` is
HTML's spelling of `true` and stays `boolean`; `<button onClick="alert(1)">` is
an ordinary attribute string and stays `static`. MX does not invent a policy
against inline handler strings — it only stops *creating* one from a function.

**Only on an element.** An `on*` attribute on a **component call**, a
`<define>` call, a custom tag, a host tag (`<try onClick=…>`) or an attribute
tag is an ordinary prop, not an event: `<Row onSelect=pick/>` passes the
callback `onSelect`. Components have props; elements have events — the same
reason `class` is not renamed on a component call.

**No aliases.** MX never rewrites one spelling into another, because a name
that silently means something else is the failure this rule exists to prevent.
`onDoubleClick` lowercases to `doubleclick`, which is not a DOM event and which
no element fires; core emits it as written and raises a **non-rewriting
warning** positioned at the attribute name:

> `` `onDoubleClick` is not a DOM event; did you mean `onDblclick` ``

**The rule:** a warning is emitted when the lowercased `on<Name>` is not a DOM
event name. A suggestion is included when a corresponding DOM event exists.
The warning never changes the emitted event name.

The set of spellings this catches is therefore a consequence of the rule, not
its definition, and it is small: checked against the event names in
TypeScript's `lib.dom.d.ts`, only three React spellings lowercase to a
non-event — `onDoubleClick` (suggesting `onDblclick`), plus `onDragExit` and
`onEncrypted`, which are React-only synthetic events with no DOM counterpart
and so carry no suggestion. Every other React camelCase spelling —
`onKeyDown`, `onMouseEnter`, `onFocusIn`, `onPointerDown`, `onTimeUpdate` and
the rest — already lowercases to the real DOM name and is correct MX. That
list is an illustration of where the rule currently bites; it is not the rule.

`on-<exact>` is never checked: its whole purpose is to name an event MX cannot
know about. `on-` with no name after the dash is an error.

**Native `on:*` is reserved; lowercase `oncapture:*` is an ordinary attribute.**
Only `on:*` reaches the host's modifier hook for a positioned refusal/fix-it
(decision 101b, corrected against live Marko 6.3.51). `oncapture:click` retains
its complete name and is neither an event nor a capture-mode alias. Core does
not rewrite either spelling or warn.

#### Gotcha: the handler signature and `onChange` are the host's, not MX's

Host differences here are **documented, not shimmed**:

- The handler's parameters are whatever the host runtime passes — the DOM event
  on every current host. (Marko's own runtime would pass `(event, target)`.)
- **Angular calls the handler as Marko does, `(event, element)`, through a
  typed invoker on the component** (decision 117), so a 0-arg, 1-arg, 2-arg or
  inline-arrow handler all pass `strictTemplates` and the handler's return
  value reaches Angular (`false` still calls `preventDefault()`). Two recorded
  divergences from Marko (`divergences.md`): `this` is **the component** (Marko:
  the element the handler is bound to), and `element` is `$event.currentTarget`,
  typed `EventTarget | null` (Angular types no element without a template
  reference; Marko types it as the element).
- **hono's `onChange` binds the `input` event**, for React compatibility, while
  every other host binds `change`. The same MX source therefore fires on every
  keystroke on hono and on commit elsewhere. If you need one specific
  behaviour, say so explicitly: `onInput` for per-keystroke, or handle
  `change`'s timing in the handler.

What is settled: an **attribute method** is an event handler and requires a
runtime, so a host with no runtime rejects it:

| Message | When |
|---|---|
| `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; standalone MX renders once to a string` | The attribute has `arguments` or a `FunctionExpression` value and the host's `resolveAttributeMethod` declined it. |

An attribute method can arrive in **two shapes** and both must be detected:
`<button onClick() { … }>` has `arguments` falsy and the method body as the
attribute's *value* (measured against 5.42.5). Attribute methods lower to
block-body arrows, never unwrapped (decision 11); a bare arrow is written
`onClick=(() => f())`.

### Attribute order

**Marko hoists `value` first on `<input>`**, so `<input type="text" value=x>`
emits `<input value=… type=text>`. A browser applies `type` before `value`, and
some types reinterpret a later `value`. The html target reproduces this, and the
oracle compares attribute order, so getting it wrong fails the gate.

### Spread and trust

Spreading an attacker-controlled object whose key is a legitimate handler name
(`onload`) renders a live handler. Decision 44 records this as a **residual
trust boundary, documented not closed**: do not spread untrusted objects.
Spread attribute *names* are pattern-validated, not merely escaped (decision 42).

### Tag fields rejected by default

Core rejects these on any construct that does not explicitly allow them. `${what}`
is the construct label, always backticked (`` `<if>` ``, `` `<for>` ``, …):

| Message |
|---|
| `tag arguments \`(...)\` on ${what} are not supported in a standalone template` |
| `tag variable \`/${…}\` on ${what} is not supported in a standalone template` |
| `type arguments on ${what} are not supported in a standalone template` |
| `tag params \`\|...\|\` on ${what} are not supported in a standalone template` |

**Decisions:** 9, 10, 11, 13, 30, 42, 44, 65, 67b; events **open**.

---

## 5. Structural tags

The structural core renders **the same way on every host**. A host may forbid one
of these outright; it may never change what one means (decision 71).

### 5.1 `<if>` / `<else if>` / `<else>`

```mx
<if=user.loggedIn>
  <p>Welcome back, ${user.name}.</p>
</if>
<else if=user.isGuest>
  <p>Browsing as a guest.</p>
</else>
<else>
  <p>Please sign in.</p>
</else>
```

Chain rules: comments and whitespace-only text between branches are skipped;
`<else if=cond>` reads its condition from the `if` attribute while
`<else-if=cond>` reads it from the value position; the chain stops after a
conditionless `<else>`. Each branch is its own binding scope.

**Tag params on `<if>` (`<if|u|=cond>`) are not MX 1** — Marko rejects them
(`Tag does not support parameters.`), so they are deferred to MX 2. Decision 19
fixed the *word order* of params generally (params come before `=value`); it did
not make `<if|u|>` legal.

| Message | When |
|---|---|
| `\`<if>\` without a condition` | No value attribute and no first positional attribute with a value. |
| `\`<${label}>\` without a preceding \`<if>\`` | An `<else>`/`<else-if>` not consumed by a preceding chain. `label` is `else if` when an `if` attribute is present, else `else`. |

### 5.2 `<for>`

Four iteration shapes, chosen by attribute.

```mx
<for|item, i| of=items>        <li>${i}: ${item.name}</li>   </for>
<for|item| of=items by="id">   <li>${item.name}</li>         </for>
<for|key, value| in=config>    <dt>${key}</dt><dd>${value}</dd> </for>
<for|i| from=0 to=9>           <span>${i}</span>             </for>
```

- `of=` iterates a list. `in=` iterates an object's entries.
- `from=`/`to=`/`until=`/`step=` iterate a numeric range: **`to=` is inclusive,
  `until=` is exclusive**. `step=` lowers to a per-row callback binding
  `i = from + k * step`; a **negative step is allowed**, and a literal `step=0`
  is a parse error (decision 51, superseding decision 7's blanket `step=` error).
  A `step` that evaluates to `0` at runtime clamps to zero rows rather than
  looping forever.
- `by=` keys rows for reconciliation. It is **reconciler input**: on a
  string-rendering host it is **inert** — accepted, contributing nothing to the
  output (decision 65, reclassifying S8). Caveat carried from that decision: if
  hydration markers are ever emitted, `by=` stops being inert.
- A **string** `by=` is the property-name shorthand and only `of=` has one:
  `in=`/`to=`/`until=` *call* `by` as a function, so Marko refuses the string at
  compile time — reported at the quoted key — instead of letting it fail at
  render. `by=(k, v) => …` is the form for those three.
- **`key=` is an error on `<for>`**: it is the React/Vue habit and a `<for>` reads
  nothing by that name, so accepting it would drop the author's intent silently.
  Marko redirects it to `by=` before anything else, with the fix-it for the loop's
  own form (`by="propName"`, `by=(key, value) => key`, `by=(num) => key`), and MX
  refuses it at the attribute with the same wording.

**Params come before `=value`** — `<for|item, i| of=xs>`, and by the same rule
`<if|u|=cond>` would be the spelling were it legal. `notes/solidmx-spec.md` §5.1
writes `<if=user()|u|>`; that prose is wrong, and the real grammar is
params-first (decision 19).

**Every `<for>` binds its iterable to a temporary before the loop opens.** This
is not an optimization: `<for|input| of=input.items>` is legal Marko and must
shadow, and without the temporary the emitted `for (const input of input.items)`
hits the temporal dead zone and throws at render time (decision 67c).

| Message | When |
|---|---|
| `` `<for>` needs tag params: `<for\|item\| of=…>` `` | No params. |
| `` `<for>` with more than one of `of=`, `in=`, `from=`/`to=`/`until=` `` | More than one source form. |
| `` `<for>` with both `to=` and `until=` `` | Both present. |
| `` `<for step=...>` is only valid on a range `` | `step` without `to`/`until`. |
| `` `<for ${label}=...>` requires an expression value `` | The attribute has no value, has arguments, or is a function expression. `label` ∈ `of in from to until step by`. |
| `` `<for>` requires `of=`, `in=`, or `from=`/`to=`/`until=` `` | No source form at all. |

### 5.3 `<const>`

A non-reactive local binding, computed fresh each render and never re-run within
one.

```mx
<const/total=items.reduce((sum, i) => sum + i.price, 0)/>
```

The initializer is lowered **before** shadowing applies, so `<const/count=count + 1/>`
reads the outer binding.

| Message | When |
|---|---|
| `` `<const>` without a variable name (write `<const/name=value/>`) `` | No `/var`. |
| `` `<const>` without a value `` | No value. |

### 5.4 `<define>`

A named, reusable fragment, callable like any tag, taking the same params and
attribute tags as any other call. Hoists from inside a `<define>` land on the
define's own head, not the enclosing render function's.

| Message | When |
|---|---|
| `` `<define>` without a name (write `<define/name>`) `` | No `/var`. |

**On Solid, a `<define>` inside a `.solid.mx` region is hoisted to module
scope (decision 110b).** A region is a JSX expression spliced into someone
else's module, so it has no statement position for `const Row = (...) =>
...;` the way html/preact's in-place `const` does — the same wall
`hoistedImports` already hits for a discovered tag's synthesized import. The
compiler resolves it the same way: `@mxlang/solid`'s emitter mints a
gensym'd module-scope function (`$mx_DefineRowN`, never the author's own
name — see `packages/hosts/solid/AGENTS.md`), and `@mxlang/parser`'s bridge
writes it into the surrounding module alongside any hoisted imports.
A hoisted `<define>` must be a **direct top-level child of its region**
(not nested inside `<if>`/`<for>`/an attribute tag/another `<define>`) and
may not read a value the region itself introduced — its own params, another
top-level `<define>`'s name, and the surrounding module's own imports are
fine; anything else free in its body is a positioned error naming the
captured identifier, not silently wrong code. Both are hard limits, not
`<define>`'s own rule: real module scope has no closure over the region's
enclosing render function, and no per-row/per-branch scope for a nested one
to close over either. On Solid, a `<define>` call is a plain function-call
expression (`{$mx_DefineRowN(...)}`), not a JSX tag — JSX has no
positional-call syntax — using the identical named-param binding closed item
9 below describes for html/preact.

### 5.5 `<let>`

**Not core-owned.** There is no `let` case in the lowerer; it routes entirely
through host declarations. See §11 and the per-host row in §13.3. Do not
attribute a `<let>` message to `@mxlang/core`.

Note that Angular rejects `<let>` only *incidentally*, through the generic
`tag variable` field guard rather than a stateful-tag policy — so `<let x=1/>`
with no `/var` is not rejected at all (bug 1, §13.6).

### 5.6 A binding named `input`

A **render-scope** binding named `input` (`<let/input=…>`, `<const/input=…>`) is
rejected on every host: it would shadow the emitted render function's own
parameter and make the template's input unreachable. Marko refuses it too, as a
duplicate declaration. Core calls the host's `checkBinding` hook, passing the
construct label verbatim (`` "`<const>`" ``).

A **tag param** named `input` (`<for|input|>`, `<define/R|input|>`) is
**accepted**, because it opens a genuinely nested scope where an ordinary
JavaScript shadow is correct — and Marko renders those. Rejecting them would be
an implementation limit stated as a language rule, which decision 65 forbids.

This check is **not** `strict`-only: a silently-broken input is a bug under
either policy.

**Decisions:** 19, 51, 7 (partly superseded), 65, 67c, 70, 71, 79; `<if|u|>`
deferred per `divergences.md`.

---

## 6. `<try>`

`<try>` is a **core-owned custom tag** (decision 91), not per-host code and not a
structural tag. Core validates one portable call shape, then asks the active
host for its `try` primitive via `ctx.build.delegatedTag("try", …)`.

```mx
<try>
  <@placeholder>Loading…</@placeholder>
  <RiskyThing/>
  <@catch|error, reset|>Failed: ${error.message}</@catch>
</try>
```

**Its name cannot be shadowed**, at either of two points: a registered
`customTags` entry named `try` is rejected at *registration*, before any parsing;
and the call site consults the builtin table before a caller's own map. The
registration check exists because a shadowing registration's own `parseOptions`
would change how the parser reads `<try>`, surfacing as an unrelated parser error
instead of the shadow diagnostic.

`<try>` declares `attributes: {}` — deliberately empty rather than omitted, so
`<try foo=1>` fails the generic unknown-attribute check with
`` `<try>`: accepts no attributes ``. Its declared attribute tags are `catch` and
`placeholder`; unknown or repeated ones are caught by the generic custom-tag
validator (§13.3).

`<try>` is lowered with `isBuiltin`, which exempts it from the `hasContent`
gate ordinary custom tags get: it is a structural pass-through wrapper and
must reproduce the caller's body unchanged. `<try>  </try>` keeps its normalized
space; decision 141 also retains that space on ordinary component/custom-tag
calls, rather than treating it as an absent body.

Errors, all carrying the `` `<try>`:  `` prefix:

| Rendered | When |
|---|---|
| `` `<try>`: tag params (`\|a, b\|`) on `<try>` `` | Params on `<try>` itself. |
| `` `<try>`: tag variable (`/name`) on `<try>` `` | A `/var` on `<try>`. |
| `` `<try>`: tag params (`\|a, b\|`) on `<@placeholder>` `` | `<@placeholder>` declared its own params. |

And from the host-primitive request:

| Message | When |
|---|---|
| `this host does not claim \`<${name}>\`, so a custom tag cannot emit one` | The host does not claim `try`. |

Per-host lowering is in §15. Notably `<try>` with `<@placeholder>` is an error on
the html target (it needs a second render pass), while `<try>` with only `<@catch>`
lowers to an ordinary `try`/`catch`.

**Decisions:** 8, 28, 51, 65, 85, 91, 93.

---

## 7. Components and dynamic tags

### Resolution precedence

The **normative** order, as shipped (decisions 93, 113):

1. Host tag disposition (`declarations.tags[name]` — error or inert)
2. Core structural tags: `import`, `static`, `export`, `for`, `const`,
   `define`, `return`, `else`, `else-if` — **never shadowable**
3. `@`-prefixed names → attribute-tag error
4. **Built-in custom tags (`try`)** — wins unconditionally
5. **A file-local binding**, **gated on PascalCase**: an `import`, a
   `<define>` name, a `<const>` binding, or a `<for>`/`<define>` tag param —
   each in effect only within its own lexical scope
6. A registered custom tag
7. A host claim (`isDelegatedTag`)
8. `declarations.isComponent`
9. PascalCase with nothing matching → error; else an element if
   `isElement` accepts it; else error

**The PascalCase gate at step 5 is load-bearing.** Marko's own rule is that a
*lowercase* local variable is never resolved as a component:
`import panel from "./panel.mx"` then `<panel/>` is a Marko parse error, not a
component reference. An earlier fix checked local bindings with no casing gate
and regressed every lowercase custom tag or host claim (e.g. `<style>`) that
shared a name with an unrelated lowercase import in the same file.

**Decision 113: a `<const>` binding and a `<for>`/`<define>` tag param also
shadow a registered custom tag of the same name, scoped exactly to where the
binding is in effect** (decision 113, `custom-tags-local-bindings`). Measured
against Marko 6.3.51's own translator (`normalizeTag`,
`@marko/runtime-tags/dist/translator/index.js:5852-5860`): Marko rewrites a
capitalized tag name to a local-variable reference whenever
`tag.scope.getBinding(tagName)` finds a binding in scope — a single,
unconditional check that treats `const`, `for`-params, and `define`-params
identically, run before any taglib/custom-tag lookup, and gated on the same
`TAG_NAME_IDENTIFIER_REG` (capitalized) rule. MX matches this: the check now
also consults `ctx.tagVarShadowed`, the scope-tracking set already maintained
by `shadowBindings`/`scopeBindings` around every `<const>`, `<for|p|>`, and
`<define|p|>` body, so scoping is correct by construction — a name shadowed
inside an `<if>` branch or a `<for>` body reverts to the registered custom tag
immediately outside it. This closes the gap `custom-tags-import-precedence`
(decision 93) left open.

The html target's rule is stated by case only in the sense above: a tag matching an
import, a `<define>`, or a taglib/`tags/` discovery is a component call; anything
else is an HTML element whatever its case, hyphenated custom elements included.
SolidMX keeps JSX's PascalCase-means-component convention, on a separate lowering
path.

| Message | When |
|---|---|
| `` `<${name}>` has no matching import or `<define>` in scope; a capitalized tag is always a component call `` | PascalCase, nothing matched, and the host supplies no `rejectUnknownTag` (the fallback wording). |
| `unknown tag \`<${name}>\`: not an HTML element, and no matching import or \`<define>\` is in scope` | Lowercase, the host's `isElement` rejected it, and the host supplies no `rejectUnknownTag`. |

An unresolved **hyphenated** tag refuses to compile, matching Marko
(`Unable to find entry point for custom tag <my-widget>`, measured against
5.42.5). `divergences.md` lists letting it through as a literal custom element
as an MX 2 candidate.

**Decision 114: an unresolved PascalCase tag is Marko's own compile error too,
on every host, including Solid.** Verified against `@marko/compiler` 5.42.5 /
`marko@6.3.51`, by source (`tag-name-type.ts`'s `analyzeTagNameType`: a
PascalCase name with no scope binding and no resolvable child file sets
`tagNameUnresolved = true`; `dynamic-tag.ts:135` throws `tagNotFoundError`,
`custom-tag.ts:398-429`'s positioned `` Unable to find entry point for custom
tag `<Name>`. ``) and by live compile — identical wording for a self-closing
tag, a tag with a body, and a tag with an attribute. `lower.ts`'s step 5/9
guards (above) now call `ctx.declarations.rejectUnknownTag?.(name, node, ctx)`
before their own fallback message, for **both** the PascalCase (step 9) and
the lowercase-unresolved-element (existing) case — one hook, reported before
either fallback, so a Marko-parity host gets Marko's exact wording either way
and a host with none keeps the messages in the table above unchanged.

Before this, `@mxlang/solid`'s `isComponent` was a bare `/^[A-Z]/` test with
no resolvability check (`solid-attr-tag-resolvability` — filed from a code
review, TODO `solid-unresolved-component-tag`): an unresolvable PascalCase tag
silently lowered as an ordinary component call and printed a bare JSX
reference to a binding nothing declares — a runtime `ReferenceError` on
Solid's target, not a compile error. `@mxlang/solid`'s `isComponent` now
returns `true` only when the name resolves, and the operator's ruling
(2026-09-28) extends what "resolves" means for a `.solid.mx` region beyond
what Marko itself has a concept for, since Marko has neither a host-native-
JSX-passthrough construct nor a "spliced into someone else's module"
construct:

- A capitalized tag bound in the **surrounding TypeScript module** as a value
  — an import or a top-level `const`/`function`/`class`, type-only bindings
  excluded — resolves, even though the region itself has no module scope of
  its own to hold such a binding. `@mxlang/parser`'s `programBindings`/
  `sourceBindings` (shared with `@mxlang/typescript-plugin`'s
  `appendSolidBuiltinImport`) reads this from a declaration-only pre-parse of
  the whole file, region bodies replaced with `null`; the parser bridge
  passes it to the region compiler as `moduleBindings`, unfiltered by local
  shadowing (unlike `importSpecifiers`) — Marko's own rule
  (`tag.scope.hasBinding(tagName)`) is that any in-scope binding, shadowing
  included, resolves a capitalized tag as a *reference to whichever binding
  is actually in scope*, never as unresolved.
- One of Solid's own JSX built-ins (`Show`, `For`, `Switch`, `Match`,
  `Repeat`, `Errored`, `Loading`, `Dynamic` — `SOLID_BUILTIN_TAGS`,
  `@mxlang/parser`) resolves unconditionally: `@mxlang/solid`'s emitter
  prints these as a bare tag with no import of its own, because the real
  Solid build pipeline (`@solidjs/vite-plugin`'s compiler stage) auto-imports
  every one it sees — a stage this compiler never runs through.

Everything else reaches Marko's own error. Solid has no taglib-backed
`tags/`-discovery channel the way `@mxlang/html`/`@mxlang/preact` do (a
`.solid.mx` region is a fragment compile, not a whole-Marko-file parse), so
that route never applies here.

**Extended to Preact, React, Hono and Astro (`unresolved-tag-jsx-astro-angular`,
firstmate scope: preact/react/hono/astro, Angular out).** Before this, the
shared JSX emitter's (`@mxlang/preact`, reused by `@mxlang/react`/
`@mxlang/hono`) `isComponent` fell back to a bare `isComponentName`
(`/^[A-Z]/`) test whenever the taglib lookup found nothing, and `@mxlang/astro`'s
`isComponent` was that bare test outright — so `<TotallyUndefined/>` (no
import, binding, or taglib entry) silently emitted a JSX component reference
to nothing on all four hosts, a runtime error rather than Marko's compile
error. Both now resolve a capitalized tag only when it genuinely resolves,
each supplying `rejectUnknownTag` (Marko's own wording) for the fallthrough:

- **Preact/React/Hono** (whole-file `.mx`, real MX-level `import`/`<define>`/
  `<const>` statements): `ctx.imports`/`ctx.defines` — already populated by
  `lower.ts`'s own `lowerStatement`/`fileLocalBinding` for an MX-level
  binding — or a taglib entry. No new binding source; the fallback simply
  changed from `isComponentName(name)` to `false`.
- **Astro** (`.astro.mx`): a `.astro.mx` template body has no MX-level
  `import`/`<define>`/`<const>` of its own — Astro's local-component form
  *is* a `---` fence import — so `lowerAstroMx` now parses the fence's own
  top-level value bindings (`@mxlang/parser`'s `sourceBindings`, the same
  reader `.solid.mx`'s `moduleBindings` extension above uses) and feeds them
  into `ctx.imports` before lowering, the operator-ruling extension pattern
  decision 114 already established for `.solid.mx`'s larger scope. A `.astro.mx`
  file previously had no way to resolve a component at all through core's
  precedence order (no taglib, no MX-level binding), so every capitalized tag
  used to resolve purely by casing; a discovered/registered custom tag is
  unaffected (checked earlier in `lower.ts`'s precedence order, before
  `isComponent` is ever asked).

Type-only fence imports are excluded the same way `sourceBindings`/
`importBindings` already exclude a type-only value import everywhere else
(decision 114/115, above): `import type Widget from "./widget.mx"` binds no
runtime value, so `<Widget/>` on any of these four hosts is Marko's unresolved-
tag error, not a silent reference.

**Extended to Angular** (the `angular-host` follow-up decision 114 always
named, PR #113's branch). `@mxlang/angular`'s `isComponent` was a bare
`/^[A-Z]/` test too, but its fallthrough was softer than a bare reference:
an unresolved capitalized tag emitted `<mx-totally-undefined>` plus the
step-1 "add this import yourself" warning, which told the author a tag
nothing resolves was one import away from working. It now resolves a
capitalized tag only through `ctx.imports`/`ctx.defines` or a non-element
taglib entry, and supplies `rejectUnknownTag` with Marko's wording, so
`<TotallyUndefined/>` is the same positioned compile error as on every
other host, in a page `.mx` and in a `.ng.mx` region alike. Two consequences
worth recording:

- Decision 116's routing landed while this host's component dispatch still
  called `Component.target.kind === "dynamic"` unreachable. A capitalized
  tag bound to a value import that is not a `.mx` default import, or to a
  local whose value core cannot statically prove (a `<for>` tag param), now
  lowers there on Angular too, and emits `ngComponentOutlet` — the same
  lowering an authored `<${expr}/>` already had. The `valueImportBinding`
  provenance other hosts spend on typing has no consumer on this one.
- The step-1 used-tag import warning is unchanged in kind: it only ever
  applies to a *resolved* tag (a `.mx` import, a discovered `tags/` unit),
  telling the author which Angular-side `import`/`imports:` entry that tag's
  emitted module needs.

**A type-only import never resolves a tag, in a whole-file `.mx` on any
host either** (decision 114/115). `@mxlang/core`'s `importBindings` used to
return every specifier of an `import` statement with no check of
`importKind`, so `import type Widget from "./widget.mx"` bound `Widget` the
same as a value import and `<Widget/>` silently lowered to a component call
— a runtime `ReferenceError`, not Marko's compile error, on every host. Fixed
at the shared root: `Ctx.imports` (what every host's `isComponent` and
core's own file-local-binding check consult) now holds value bindings only;
a new `Ctx.importedNames` (every binding, type or value) serves the two
readers that need the older, unfiltered meaning — `needsAttrTagImport`'s "is
`AttrTag` already imported" check and the self-export collision check. The
import statement is still emitted verbatim either way. Mirrors
`@mxlang/parser`'s `programBindings` above, which already excluded the same
two shapes for the `.solid.mx` *region* path.

### Dynamic tags

`<${expr}>` — with or without attributes or a body — is a dynamic tag, and so
is a **bare** `${expr}` line (**corrected 2026-09-17, core PR #103** —
see §3): both parse to the identical node, and Marko itself treats them
alike. At the *lowering* stage (`lowerTag`), a host that claims `DYNAMIC_TAG`
gets a `DelegatedTag` for either shape; a host that does not claim it gets a
`Component` with a dynamic target for either shape instead of the previous
unconditional `fail()` — what a given host's *emitter* then does with that
`Component` (render it, as Preact/Solid do through their own dynamic-target
handling, or reject it) is unchanged by this correction and is each host's own
row in §13.1's dynamic-tag entry.

| Message | When |
|---|---|
| `dynamic tag name is not supported in a standalone template` | Superseded — this fired at the `lowerTag` stage for a tagged dynamic tag no host claimed; core no longer produces it there. A host's own emitter may still reject a dynamic-target `Component` in its own words (§13.1). |

> **Open question.** No decision fixes dynamic-tag behavior; the decision log
> lists `<${x}>` only as a known gap. A host may claim it, and the lowercase-
> import form `<${layout}/>` is Marko's own prescribed workaround for the
> PascalCase rule.

**Decision 116: a capitalized value import that isn't a `.marko`/`.mx`
default import lowers as a dynamic tag, not a direct call.** Measured (TODO
`value-import-as-tag-parity`): Marko 6.3.51 compiles *every* capitalized
local-import tag to `_dynamic_tag`, regardless of source. At runtime, a
string renders as an element and a real Marko-template value is invoked as a
component; anything else — a plain function, a plain object, `undefined`,
`null` — renders only the tag's own body content. MX previously routed
*every* capitalized value import straight to a direct call (§7's step 5, a
`Component` with `kind: "name"`), so a string, `undefined`, `null`, or a
plain object threw `"X is not a function"` on every host instead.

The routing in step 5 is refined, and scoped to **import bindings only**:
only a *default* import whose specifier ends in `.marko`/`.mx` — Marko's own
statically-resolved component case (`tag-name-type.ts:174-196`) — still
routes to a direct `kind: "name"` call. Every other capitalized value
*import* (named, namespace, or a default from any other extension) now
routes to `kind: "dynamic"` instead — the identical lowering an authored
`<${expr}/>` already produces above, so every host's existing dynamic-tag
emitter handles it with no host-side routing change (decision 79). Gated
specifically on `ctx.importSpecifiers` (populated only by an authored
`import` statement or, on Solid, the `importSpecifiers` a real
`.solid.mx` caller's surrounding module supplies), not on `ctx.imports` —
the broader set step 5 already used, which also holds a module-scope
`const`/`function`/`class`, a `<const>` binding, and a `<for>`/`<define>` tag
param. **None of those route dynamic**: a locally declared component — the
most common Solid authoring pattern — keeps its pre-existing direct call on
every host, unchanged by this decision. The resolved target carries
`valueImportBinding`, the binding's own name, so `readCalleeInput` can still
resolve the callee's declared `Input` for typed attribute-tag checking even
though the call now lowers dynamically, and a diagnostic on the call still
names the tag the author wrote rather than "dynamic tag".

**Local extension of decision 116 (firstmate's ruling, recorded under this
same decision number in `notes/decisions-2026-09-10.md`; TODO
`local-value-as-tag-parity`):** the gap above is closed for every
*non-import* PascalCase local too — a `static`/module-scope declaration, a
`<const>` binding, a `<for>`/`<define>` tag param. Rather than mirror
decision 116's own import-only rule (routing *every* local dynamic would
change the most common Solid module-scope-component pattern), core instead
classifies each local's value:

- **Statically provable function/arrow/class** — a plain `function Foo(){}`,
  `class Foo{}`, or a `const`/`static const` bound directly to a function
  expression, arrow function, or class expression — stays a direct
  `kind: "name"` call, unchanged.
- **Everything else is "unknown"** and routes `kind: "dynamic"` the same way
  an import routes under decision 116 proper: a string literal
  (`static const Tag = "div"`), a conditional (`const Tag = cond ? A : B`),
  or any other expression core cannot inspect at lowering time — including a
  call result (`const Tag = lazy(...)`/`createComponent(...)`), since core
  never evaluates an expression, only recognizes a small closed set of AST
  shapes. A tag param (`<for|Row|>`, `<define/Wrapper|Row|>`) is *always*
  "unknown": its runtime value can never be inspected at lowering time,
  whatever it turns out to hold when the template actually renders.

`ctx.unknownLocalValue` (`@mxlang/core`) carries the classified set;
`isFunctionLikeValue` (also exported) is the shared AST-shape check. On
Solid, where a `.solid.mx` region's module scope arrives as a pre-computed
name set rather than real AST nodes, `@mxlang/parser`'s
`unknownProgramBindings`/`unknownSourceBindings` perform the identical
classification at the parser boundary (over the surrounding module's own
`programBindings` pre-parse) and thread it through as
`unknownModuleBindings`. A routed-dynamic local carries `valueImportBinding`
exactly as decision 116's import case does, so typed attribute-tag checking
and diagnostics are unaffected.

**Astro host-cannot divergence: an "unknown" fence binding cannot render as a
dynamic tag at all (decision 65's "target cannot" class, unrelated to this
decision's own classification).** `@mxlang/astro`'s `---` fence resolves a
capitalized tag through its own top-level value bindings the same way
`.solid.mx`'s `moduleBindings` does (decision 114's astro extension), and now
classifies them the same way too — but Astro's emitter (`component()`)
unconditionally rejects every non-`"name"` `Component` target, because Astro
resolves component names statically and has no dynamic-tag construct at all,
unlike every other host. An "unknown" fence binding therefore cannot fall
back to a working `<Dynamic>`-style render the way it does on html/preact/
react/hono/solid: it fails at MX compile time instead, with its own message
naming the tag (`` `<Tag>` is bound in the frontmatter to a value MX can't
prove is a component, and @mxlang/astro can't render a tag name decided at
runtime. Bind it to a component (an import, function or class), or use a
lowercase element. ``) — distinct from the generic `<${expr}>` dynamic-tag
message, since the author wrote an ordinary tag name, not a dynamic-tag
expression. This is a strict improvement over the pre-existing behavior,
which silently compiled `const Tag = "div"; <Tag/>` to a literal `<Tag>` JSX
reference that failed only at Astro's own render time with an opaque
`NoMatchingRenderer`-class error. A function-like fence binding (the common
case — a locally declared component) and a fence import are both entirely
unaffected, and stay a direct call as before.

**Fix: a host-recognized component object (React's `memo`/`forwardRef`/
`lazy`) reaching the dynamic path is treated as a component, not a plain
data object.** Firstmate's follow-up: React's own `memo(Foo)`/`forwardRef(...)`
return plain *objects* (`{ $$typeof: Symbol(react.memo), ... }`), not
functions — measured, and unlike `preact/compat`'s and `hono/jsx`'s own
`memo`/`forwardRef` (both real functions) and Solid's `lazy` (also a real
function). Before this fix, `mxDynamic` (the shared Preact/React/Hono JSX
emitter's dynamic-tag helper) had no branch recognizing such an object: it
fell through to the final `return props.content ? props.content() : target;`
line and handed the bare object back as a JSX child, which React rejects
("Objects are not valid as a React child"). Reachable both as a local
(`static const Comp = memo(Foo)`, already "unknown" under this decision's own
classification — a `CallExpression` is never statically function-like) and,
since decision 116's own import routing (#155), as a value import
(`import Card from "./Card.tsx"` where `Card` is `export default memo(Foo)`).

Fixed by widening `mxDynamic`'s "is this component-like" check with a new
`mxIsHostComponentObject(value)` helper — **allowlisted by the marker
symbol's `description`** (`"react.memo"`/`"react.forward_ref"`/
`"react.lazy"`), not merely "carries a `$$typeof` symbol": every React
*element* (an ordinary already-rendered `<em/>`, not just a `memo`/
`forwardRef` wrapper) also carries a `$$typeof` symbol
(`Symbol(react.transitional.element)`/`Symbol(react.element)` depending on
the React version) — a broader "any `$$typeof` symbol" check, tried first
and caught by the executed suite before landing, misclassified an ordinary
rendered element as a component and broke pre-existing dynamic-tag/
attribute-tag tests (an already-rendered `<@head>H</@head>` body passed as
`<${head}/>` is exactly such an element). React's `memo`/`forwardRef`/`lazy`
markers are plain `Symbol()`s, not `Symbol.for(...)`, so identity cannot be
compared across a second React copy — the description string is the only
stable cross-copy signal. Checked *before* decision 106's `.content`-guard,
so a recognized object never reaches that guard (a plain data object never
carries `$$typeof` at all). **This fix is React-specific in practice**: measured directly, neither
Preact's own renderer (`preact-render-to-string`'s dispatcher, `typeof type
== "function"` only) nor `hono/jsx`'s own `jsx()` runtime has any
object-based component dispatch at all — a bare `<Comp/>` where `Comp` is
React's raw `memo` object fails identically on both hosts whether or not it
passes through `mxDynamic`, with no MX layer involved (confirmed by
hand-written JSX with no dynamic-tag routing at all). This is a genuine
Preact/Hono-vs-React incompatibility, not something `mxDynamic` could ever
paper over; the widened check is simply inert (never taken in a way that
changes the outcome) on those two hosts, and is what makes React's own case
work. Solid needed no change: its `<Dynamic component={...}>` dispatches on
any callable component reference generically, with no `typeof` gate of its
own to widen, and `lazy(...)` is a real function regardless.

**Intentional divergence from literal Marko parity:** a plain function is
still called and its return kept, matching MX's pre-116 behavior for that
one case rather than Marko's, since an imported `.tsx` component on
react/preact/hono, or an MX component on html, *is* a plain function —
matching Marko byte-for-byte here (discarding the function's return value)
would break ordinary host interop. Decision 106's data-attribute-tag guard
(a plain object with an own `content` property throws, naming the
`<${x.content}/>` route) is unaffected and still fires for a value import
reaching it this way — consistent with, not a new divergence from, decision
106, since Marko itself would silently unwrap `.content` and then find no
real renderer there either.

Two per-host consequences, both fixed in the same task: html's
`renderDynamic` returned `""` outright for a falsy target, discarding the
tag's body content — now returns `props.content?.() ?? ""`, matching Marko.
Solid's `#dynamicComponent` had the identical bug in its own falsy-target
branch, additionally exposed a pre-existing gap where a region whose entire
content is one dynamic tag failed to re-parse (its compiled JSX
child-expression-container braces are not a standalone expression on their
own) — the parser bridge now retries with those braces stripped on a parse
failure. `@mxlang/parser`'s module-scope scan gained a parallel
`importDefaultFromMarkoOrMx` set (§7's precedence text above), threaded the
same way `moduleBindings`/`importSpecifiers` already are, so a real
`.solid.mx` file's routing matches a unit test's.

> **Bug, measured 2026-09-17 — an attribute tag on a dynamic tag is silently
> dropped.** On the html target (which claims `DYNAMIC_TAG`),
> `<${T}><@head>x</@head>y</${T}>` compiles clean and emits
> `renderDynamic(T, { content: … })` — **no `head` prop, and no diagnostic**.
> The identical call on a named component emits the `head` prop correctly.
> This is the S8 silent-drop class the project otherwise refuses. The docs
> claim the combination "is reported as such"; it is not reported at all.
> Either the attribute tags reach `renderDynamic`, or the combination is a
> positioned error — silence is the one option the capability test (§11)
> forbids. Filed in §13.6.

> **A string-target dynamic tag called with arguments uses `args[0]` as its
> input, not the call's own attributes (decision 112).** `<${expr}(a, b)/>`
> where `expr` resolves to a tag-name string at run time renders with `a`
> (`args[0]`, or `{}` if it is null/undefined) spread as attributes; `b` and
> any further arguments are ignored; decision 109's trailing content/
> attribute-tag props object (appended *after* the positional args) is not
> `args[0]` either, so it is not read as input — content still renders,
> since Marko threads it independently. Applies on every host, including
> Solid (decisions 109 and 112 are disjoint — 109 governs a function/
> component target, 112 only a string target). See §15 item 11 for the
> full detail.

**Decisions:** 47/S11 (superseded by 65, swept by 68), 51, 79, 93, 94c, 112.

---

## 8. Attribute tags and tag params

Two **generic** rules applying to every tag Marko accepts them on — not
control-tag special cases (decision 51). Decision 72's subset rule then removed
the cases real Marko rejects.

### Tag params: `<Tag|a, b|>`

Params between pipes turn the tag's children into a **function**:

```mx
<Show|user| when=currentUser>${user.name}</Show>
```

lowers to `<Show when={currentUser}>{(user) => …}</Show>`. This is what lets MX
call a framework's own render-prop components with ordinary markup. Params parse
exactly like `<for>`'s: destructuring and type annotations included; empty pipes
(`||`) lower to a no-argument function.

**Params come before `=value`** (§5.2).

### Attribute tags: `<@name>`

A child written `<@name>…</@name>` becomes a **named prop** on the parent instead
of ordinary children. With params, `<@name|p|>` becomes a **function** prop.
Ordinary children stay the child callback. Props are emitted in a fixed order:
the parent's own attributes in source order, then attribute tags in source order.

The callee's `Input` declares whether an attribute-tag value is `data` (the
default) or `renderable`, and whether the prop is singular or an array
(decision 106): `x?: AttrTag<C>` is 0..1, `x: AttrTag<C>` is exactly one on
every path, and `x: AttrTag<C>[]` is 0..n and always receives a real array.
`C` conforms to `AttrTagConfig` —
`{ as?: "data" | "renderable"; attrs?: object; params?: readonly unknown[] }`.
`attrs` may recursively contain `AttrTag` declarations. On the html target a
renderable is `(...params) => string`, read with `<${input.head}/>`; data is
the declared attributes and nested tag props plus
`content?: (...params) => string`, read with
`<${input.head.content}/>`.

When the callee has no resolvable exported `Input` — including a dynamic
callee — core infers the fallback shape from the whole control-flow tree
(decision 108). The prop is `renderable` when none of its occurrences has
attributes or nested attribute tags. If any occurrence has either, every
occurrence for that prop is `data`, so branches and loop iterations never
change its value shape. Fallback cardinality remains singular when at most one
occurrence can be taken on a path and becomes an array for repeats or loops.
An explicit `Input` is unchanged: its `as` still defaults to `data`.

Core reads `Input` syntactically from the same file or imported `.mx`, `.ts`,
`.tsx`, and `.solid.mx` files. Script callees must export the name `Input`;
`Props`, parameter annotations, and unexported declarations do not count.
Literal aliases are followed recursively. Tools may provide synchronous
`resolveImport`; an unresolved import warns and uses the fallback. A resolved
unknown extension is also an untyped fallback and is never guessed to be MX or
TypeScript.

On the Solid host both forms are reusable accessors. Data tags are read with
`<${input.head.content}/>` and renderable tags with `<${input.head}/>`;
parameterized forms pass arguments at that same dynamic call site, for example
`<${input.head.content("Ada")}/>` or `<${input.head("Ada")}/>` respectively.
Omitting those arguments is a positioned compile error. Escaped interpolation
inside the accessor remains escaped during SSR and stays reactive text in the
browser.

Astro and Angular are projection hosts rather than value hosts. A singular
attribute tag becomes an Astro named slot or Angular `ngProjectAs` projection;
`data` and `renderable` declarations select that same named content. Astro's
`.mx` renderer exposes the slot thunk both directly and as `.content`;
Angular exposes no class value at all and rewrites the callee's
`${input.x()}`, `${input.x.content()}`, `<${input.x.content}/>` and renderable
`<${input.x}/>` idioms (including optional chains) directly to `<ng-content>`.
Any other Angular read of a declared projection is a positioned error. Both
hosts reject arrays, authored attributes, params, nested attribute tags, and
bodiless `<@name/>` tags with positioned host errors. Mutually exclusive
conditional occurrences are supported and render only the taken projection.
Attribute-tag names are stored with the leading `@` stripped, and their name span
starts one character in so the `@` is excluded from diagnostics.

### Collisions and placement

| Message | When |
|---|---|
| `attribute tag \`@${name}\` collides with attribute \`${name}\`` | Name equals a non-spread attribute on the same parent. |
| `attribute tag \`@children\` collides with the parent's ordinary children` | `<@children>` beside any ordinary child. |
| `` `content` is reserved on an attribute tag; it names the body `` | An attribute tag authors `content=`, which is reserved for its body. |
| `` `<@${name}>` may appear at most once (`${name}` is declared `AttrTag`, not `AttrTag[]`) `` | A declared singular occurs more than once on one path. |
| `` `<@${name}>` may not appear inside `<for>` (`${name}` is declared `AttrTag`, not `AttrTag[]`) `` | A declared singular occurs in a loop. |
| `` missing required attribute tag `<@${name}>` `` | A required singular is absent. |
| `` `<@${name}>` is required but not provided on every `<if>` path `` | A required singular is conditional without coverage of every path. |
| `` `<@${name}>` declares params in `<${owner}>`; add `|…|` `` | The declaration has a params tuple and the call omits tag params. |
| `` `<@${name}>` declares no params in `<${owner}>`; remove `|…|` `` | The call authors tag params but the declaration has none. |
| `` `<@${name}>` is renderable in `<${owner}>`; it can't take attributes or nested attribute tags `` | A renderable occurrence attempts to carry data. |
| `Cannot have attribute tags and body content under a control flow tag.` | One `<if>`/`<for>` body mixes attribute tags with ordinary content. |
| `attribute tag \`<${name}>\` is only valid directly inside a component call` | An `@`-named tag reached the general tag path. |
| `attribute tag \`@${tagName}\` on ${what}; attribute tags are props of components, so they are only valid directly inside a component call` | Attribute tags on `<if>`, `<for>`, an element, etc. |

A **spread** attribute is not a collision — the check knows only explicitly
written names, not what a spread holds at runtime, matching JSX's
`{...props} id="x"`.

`children` counts as a name, because ordinary children lower into that prop.

### Repeated `<@name>` — final host behavior (decisions 104, 106 and 108)

Writing the same `<@name>` more than once on an **ordinary component call**
(no declared `attributeTags` schema) is allowed — core keeps every
occurrence, in source order, in `Component.attributeTags`; nothing at the
core lowering layer rejects or collapses a repeat.

Today's per-host value shape, factually, with no claim of Marko parity:

- **HTML, Preact, React and Hono**: consumer-declared cardinality and shape are
  implemented. An array
  prop is always a real array, including `[]`; conditions contribute zero or
  one value and loops push every iteration in source order. Nested attribute
  tags use the same rules recursively. Untyped body-only props use decision
  108's renderable fallback.
- **Solid**: data content and renderables are reusable accessors
  `() => SolidElement`; params add an outer function. Arrays, conditional
  values, loops, and nested tags use the same core plan as the JSX hosts.
- **Angular**: singular tags become `ngProjectAs` projections, including
  conditional branches. Arrays are rejected because a projection is keyed by
  selector. In a callee the four render idioms above become `<ng-content>`;
  conditions, pass-throughs, property reads, and other value uses are errors.
  An attribute-tag-only dynamic-tag body is also rejected because
  `ngComponentOutlet` has no content-projection mechanism.
- **Astro**: singular tags become named slots, including conditional branches.
  Arrays are rejected because an Astro slot is keyed by name and its renderer
  would silently keep only one occurrence.

Declared cardinality and `data` values deliberately diverge from Marko's own
`attrTag`/`attrTags` runtime shape (an iterable record whose property read hits
the first occurrence). Decision 108 restores Marko-compatible bare renderables
for untyped body-only tags while retaining MX arrays for fallback repeats. MX
also passes every authored attribute, while Marko may tree-shake attributes the
callee never reads. The user-facing side-by-side table and migration guidance
are in [`/language/attr-tag/`](https://mxlang.dev/language/attr-tag/).

A **custom tag** with its own declared `attributeTags` schema restricts
repeats: unless a name's declaration sets `repeatable: true`, a second
`<@name>` is `` `<@name>` may not be repeated `` (§9/§13.1). This
restriction is opt-in per custom tag and does not apply to an ordinary
component call.

### Deferred to MX 2

Both rejected by Marko, so both out of MX 1 (`divergences.md`):

| Construct | Marko's verdict |
|---|---|
| Tag params on native elements (`<div\|x\|>`) | `Tag does not support parameters.` |
| Attribute tags on native elements (`<div><@head>…</@head></div>`) | `Tag does not support nested attribute tags.` |

Conditional and looped attribute tags are part of MX 1 under decision 106.

### Declaration keys

For a custom tag's declared attribute tags, the keys are MX's own names with **no
Marko parity and no legacy aliases** (decision 94a): `literalOnly` (not
`staticOnly`) and `repeatable` (not `repeated`). Unknown keys are rejected at
registration (§13.1).

**Decisions:** 19, 28, 37, 51, 66, 70, 79, 94a, 95(1), 95(7), 96, 104, 106, 107, 108.

---

## 9. Custom tags

Custom tags are **discovered, not configured**, and a template tag is a
**compilation unit**, not an inlined fragment. Decision 95 settled the model;
decisions 97 and 98 shipped it. The full feature spec is
[`/design-notes/custom-tags/`](https://mxlang.dev/design-notes/custom-tags/); this section is the language-level contract.

### 9.1 Layers

| Layer | What it is | Status |
|---|---|---|
| **L1** | `tags/x.mx` — a template, compiled as its own unit | Shipped |
| **L2** | `x.tag.ts` — a sidecar with IR hooks over a `TagCall` | Shipped |
| **L3** | Raw hooks with Marko's exact signatures | **Blocked**: ships only after a vendored fork registers `Mx*` node types (decision 89c), because Marko's runtime node names would otherwise leak into user code |

### 9.2 Discovery

`getCustomTags(file)` walks **upward** from a file to the package root collecting
`tags/` directories, indexes `x.mx` and `x.tag.ts` by basename, and extends the
walk with `package.json#mx.tags` (a string, or entries of
`{ dir, prefix?, hosts?, parseOptions? }`). **Nearest `tags/` wins**; `mx.tags`
entries follow local directories, in array order. Package-level `mx.contracts`
modules follow `mx.tags`, also in array order. Each winner replaces the **whole
entry**, never merging declarations. An explicitly passed `customTags` still
beats a discovered tag of the same name.

**Package-level contracts (MX addition, decision 142).**
`package.json#mx.contracts` is a module string, an entry `{ module, hosts? }`, or
an array of either. The module must default-export a plain
`ContractMap` (`Record<string, CustomTag>`, exported by `@mxlang/core`); each key
is a tag name matching the discovery name pattern. Entries may declare
`parseOptions`, `attributes`, `attributeTags`, `children`, `parents`, and
`analyze`; `transform`, `finalize`, templates, and unknown keys are rejected.
There is no `prefix`. Relative and absolute paths resolve against the consuming
package directory; bare specifiers resolve through that package's
`node_modules`, using the `require`/`default` package export conditions. A
package exporting only an `import` condition fails loudly with the positioned
resolution error below.

The scan evaluates modules synchronously on a cache miss to learn their names
and parser options. Unlike sidecars, module `parseOptions` may be computed.
Modules obey the same runtime constraints as sidecars (§9.3): no top-level
`await`, explicit extensions on relative imports. Installed packages must export
JavaScript: Node does not strip TypeScript files under `node_modules` (local
`.ts` modules outside it are supported). Keep modules self-contained:
transitive imports are not stamped or evicted, so helper-only edits are not
noticed; restart the process to reliably reload imported helpers. Module files
are tracked in `ScanResult.files`; mtime **and content hash** changes invalidate
the loaded map, including edits within one filesystem tick. An unchanged scan
reuses its tag-map identity. **Under Node, an edited ESM/TS contracts module
(like an ESM/TS sidecar) is picked up after a tool restart; Bun reloads it.
CommonJS `.cjs` modules reload correctly on Node.** Evicting
`require.cache` does not clear Node's ESM loader cache, so a rescan and new map
identity do not guarantee new module exports there. This pre-existing
synchronous-loader limitation is deferred to `sync-esm-reload-node`.

`hosts` has the same filtering and lookup-owned unknown-name warning semantics
as `mx.tags`: `host: null` excludes every restricted entry; omitted `host`
disables filtering. A hostless target without a filter key should use
unrestricted contracts. Precedence and duplicate/shadow warnings are resolved
only among entries whose `hosts` restrictions apply to the caller. A restricted
entry cannot hide an unrestricted fallback from another host or `host: null`;
omitted `host` leaves all entries competing in array order. Module validation
still runs on ineligible entries. A contract-only call still requires the active target
to delegate the name (§9.8). A file-backed tag shadowing a module declaration
warns at the winning file; two modules declaring the same name warn at the later
module and the first wins. Core-owned names (`try`) warn and are skipped.

Both discovery walks index these entries identically. Only the nearest
`package.json` supplies contracts: a monorepo member with its own manifest must
redeclare them. Dependency manifests are never scanned for `mx.contracts`;
the consumer names each module explicitly. This surface provides diagnostics,
not contract-to-call-site types, completions, or hover.

Contracts errors **throw**, rather than dropping declarations and silently
passing calls. Configuration and resolution errors point at the direct
`"contracts"` key in the cached manifest text (1-based line, 0-based column).
Evaluation, export-shape, and per-module registration errors point at the
module file, `1:0`, and preserve the declaration diagnostic. The merged-map
registration pass remains for cross-source consistency checks; its errors
retain the existing calling-file `0:0` position.

A syntactically broken manifest remains a scan **warning**, not a contracts
configuration throw. With a previous good revision, its `mx.tags` and
`mx.contracts` stay in force. Without one, no configured tags or contracts are
loaded until the manifest parses; the warning says so explicitly. Its position
remains manifest `1:0`.

| Message | Position / when |
|---|---|
| `` `mx.contracts[${index}]` must be a string or an object with a `module` string `` | Manifest `"contracts"` key; entry is not a string or record. |
| `` `mx.contracts[${index}].module` must be a string `` | Manifest key; missing or non-string module. |
| `` `mx.contracts[${index}].hosts` must be an array of strings `` | Manifest key; invalid restriction shape. |
| `` `mx.contracts[${index}].${key}` is not supported; expected `module` or `hosts` `` | Manifest key; unknown config key, including `prefix`. |
| `` `mx.contracts[${index}].module` could not resolve `${spec}` from ${packageDir} `` | Manifest key; unresolvable module. |
| `contracts module failed to load: ${message}${hint}` | Module `1:0`; evaluation failed. |
| `contracts module must \`export default\` a plain ContractMap object` | Module `1:0`; no default, array, function or non-plain export. |
| `` `${name}` is not a usable tag name `` | Module `1:0`; invalid name. |
| `` `<${name}>` must be a plain CustomTag object `` | Module `1:0`; invalid tag value. |
| Existing parse-option and registration messages (§9.3, §9.7) | Module `1:0`; invalid declarations or contradictions, even when shadowed. |
| *(warning)* `` `<${name}>` from `mx.contracts` (${file}) is shadowed by ${winner}; the module's contract does not apply `` | Winning sidecar/template `1:0`; whole-entry replacement. |
| *(warning)* `` `<${name}>` is defined twice in `mx.contracts`: ${winner} and ${file}; the first module's whole entry wins `` | Later module `1:0`; duplicate declaration. |
| *(warning)* `` `<${name}>` is a core-owned custom tag and cannot be redefined by `mx.contracts`; remove this key `` | Module `1:0`; key skipped. |
| *(warning)* `` `mx.contracts` names an unknown host in `hosts`: ${host}${hint} `` | Manifest key; full-registry name validation only. |
| *(warning)* `` `package.json` could not be parsed as JSON: ${message}; no `mx.tags` or `mx.contracts` are loaded until the manifest parses `` | Manifest `1:0`; first revision is broken. With a previous valid revision the suffix is `` the previous valid `mx.tags` and `mx.contracts` stay in force `` instead. |

**`tags/*.marko` and `tags/*.mx` together.** The scan above indexes only `.mx` and
`.tag.ts`; a `tags/x.marko` is found by Marko's own taglib lookup (nearest `tags/`
per name, up to the package root, ahead of `node_modules` taglibs; in one
directory `tags/x/index.marko` beats `tags/x.marko`). A host that routes such a
tag as a plain component call (`@mxlang/html` today) imports it the way Marko
6.3.51 does: `import _x from "./tags/x.marko"`, a default import, extension kept,
relative to the calling file, named `_` plus the camelCased tag name (numeric
suffix on a collision), once per module. It is the optional
`HostDeclarations.resolveDiscoveredTagModule` hook plus `binding` on the
`Component` target. **MX-only rule:** a same-name `tags/x.mx` beats
`tags/x.marko` *regardless of distance* (registered custom tags are consulted
before the taglib lookup, step 6 above); Marko has no `.mx`, so it has no
answer here. See `divergences.md`.

The config key is **`mx`**, not `mxlang` — a hard rename with no legacy path
(decision 89a).

**The scan is synchronous, and that is load-bearing.** Bun's `onLoad`, Volar's
`createVirtualCode`, the language server's diagnose path and `mx-tsc` all call
from positions that cannot await. One synchronous implementation is what keeps
an editor, a `tsc` run and a build from resolving different tags for one file.

**A tag's name is its filename, case included**: `tags/Icon.tag.ts` is `<Icon>`.
Names must match `/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/`; dotfiles are skipped.

**A dotted file name is rejected, not indexed** (decision 137). Under a `tags/`
or `mx.tags` directory, a file `<base>.<word>.mx` is never callable as a tag:
the tag form `<base.word/>` and the concise form `base.word` both parse as tag
`base` with shorthand class `word`, so no syntax reaches such an entry and
indexing it would create a dead tag (measured on Marko 6.3.51, which indexes
`tags/my.icon.marko` silently under the name `my.icon` — an mx-only lint, see
`divergences.md`). Such a file is excluded from the tag map with a positioned
diagnostic, in one of two forms:

- `<word>` is a file-kind segment a registered target declares (`.ng.mx`,
  `.solid.mx`, `.astro.mx`): `` `${entry}` is a host module file, not a tag
  template; tag templates are `.mx` ``.
- otherwise: `` `${entry}` cannot be called as a tag: `<${bare}>` parses as tag
  `${tag}` with class `${classes}`. If it is another host's module file it does
  not belong under this host; otherwise rename it without the dot. ``

Which form applies depends on the caller's registered targets: a direct entry
that knows only its own (a Bun loader, the Angular CLI) sees another host's file
kind as the second case and still rejects the file. The rule names no host or
target, so the core holds no reserved-segment list.

| Message | When |
|---|---|
| `tag templates are \`.mx\`; \`.solid.mx\` is not supported as a tag` | A `.solid.mx` in a tags directory. |
| `` `${entry}` is a host module file, not a tag template; tag templates are `.mx` `` | A `<base>.<word>.mx` whose `<word>` is a registered file-kind segment. |
| `` `${entry}` cannot be called as a tag: `<${bare}>` parses as tag `${tag}` with class `${classes}`. If it is another host's module file it does not belong under this host; otherwise rename it without the dot. `` | Any other `<base>.<word>.mx`.
| `` `${bare}` is not a usable tag name; a tag file's name must start with a letter, digit or underscore and may then contain letters, digits, underscores, hyphens and dots `` | Name fails the pattern. |
| *(diagnostic, recorded not thrown)* `` `<${name}>` is a core-owned custom tag and cannot be redefined by a tag file; rename this file `` | A tag file resolves to a builtin name. Recorded rather than thrown so one misnamed file does not break every file in the package. |
| *(diagnostic, recorded)* `` `mx.tags` names a directory that does not exist: ${entry.dir} `` | A missing `mx.tags` directory. |

That last one is a **diagnostic, not a throw**, on purpose: one typo in
`package.json` must not break compilation of files that never used the entry.
**Every integration that scans must surface the diagnostics array**, or the typo
is silent everywhere — which is worse than either a throw or an error.

`mx.tags` shape errors, reported against the `package.json`:

| Message |
|---|
| `` `mx.tags` must be a string or an array of { dir, prefix?, hosts?, parseOptions? } `` |
| `` `mx.tags[${index}]` must be a string or an object with a `dir` string `` |
| `` `mx.tags[${index}].prefix` must be a string `` |
| `` `mx.tags[${index}].hosts` must be an array of strings `` |

An unknown host *name* inside an otherwise well-shaped `hosts` array is not a
shape error — it does not throw. **Only full-registry tooling validates host
names**, recording the warning against `package.json`. Own-only HTML/Hono Bun
loaders, Astro templates, and Angular build/watch/discover leave peer names
unresolved without a warning; they cannot establish that a peer is unknown.
Filtering, shape validation, and other scan diagnostics still apply. A
package-shaped restriction remains silent. Registry wrappers perform this
validation at their call sites; direct loaders do not. Shared Angular discovery
has an explicit internal `validateHostNames` option, false by default and
true for full-registry callers. Core's public lookup contract is unchanged.

| Message | When |
|---|---|
| *(diagnostic, recorded)* `` `mx.tags` names an unknown host in `hosts`: ${host} `` | An entry's `hosts` array names a host outside the known set (`html`, `astro`, `solid`, `preact`, `react`, `hono`, `angular`). The entry still indexes under that name — nothing is dropped — but no scan will ever match it, so this is worth a warning rather than nothing (decision 110a). |

**`hosts` restricts a `mx.tags` entry to the host names it lists** (decision
110a). Every integration passes its own host name into the scan —
`getCustomTags`/`scanCustomTags`/`scanCached`/`discoverProjectTags` all take
an optional `host` option (`null` excludes all restricted entries for a target
with no host filter key; `undefined` intentionally disables filtering) — and a
tag whose entry declared `hosts` excluding
that name is left out of the scan's result entirely, not merely hidden from
the compiled `customTags` map: a name a different host owns must stay
resolvable from *that* host's own scan of the same file. No `hosts` on the
entry (and every local `tags/` directory, which has no `mx.tags` entry to
carry one) means visible to every host, `host` unset included. The Bun
loaders, the Vite plugin, the Astro `.astro.mx` plugin, the TypeScript plugin
(whole-file `.mx`, `.solid.mx`, and `.astro.mx`), the language server, and
`mx-tsc` (through the same TypeScript-plugin language plugin) all pass their
own host name.

### 9.3 Sidecars and `parseOptions`

`parseOptions` is read **without executing the sidecar**, because it must reach
Marko before the *calling* file is parsed. It is extracted statically from the
default export, and the accepted shape is narrow: an object literal, or an
identifier bound once at module scope to one (optionally through `as`/
`satisfies`), holding boolean-valued `text`, `preserveWhitespace` or
`openTagOnly`.

Only `text` and `preserveWhitespace` are forwarded into the parser taglib.
**`openTagOnly` is deliberately not forwarded** — the lowerer enforces it, so a
body produces a positioned MX error rather than a Marko parser error (§9.4).

| Message | When |
|---|---|
| `` `${what}` must be an object literal `` | Not a record. |
| `` `${what}.${key}` is not a parse option; expected `text`, `preserveWhitespace` or `openTagOnly` `` | Unknown key. |
| `` `${what}.${key}` must be a boolean `` | Non-boolean value. |
| `` `parseOptions` must be an object literal, so the scan can read it without executing the sidecar `` | Value is not an object expression. |
| `` `parseOptions` must be a plain object literal; a spread or computed key cannot be read without executing the sidecar `` | Spread or computed key. |
| `could not be parsed: ${message}` | Babel could not parse the sidecar. |
| `sidecar failed to load: ${message}${hint}` | `require` threw. |
| `sidecar must \`export default\` a CustomTag object` | Default export is not a record. |

Two runtime constraints, **measured**, with the hints appended verbatim to the
load failure:

> ` — a custom tag sidecar may not use top-level \`await\`, because it is loaded synchronously before the calling file is parsed`

> ` — a custom tag sidecar's relative imports need explicit extensions (\`./helper.ts\`, not \`./helper\`)`

Bun accepts both forms; Node rejects both. A sidecar that breaks either works in
a `bun` build and fails in the editor — the exact disagreement one shared loader
exists to prevent. Sidecars load through Node's type-stripping `require`, so
every package that can load one declares `engines.node >= 22.18`.

### 9.4 Units

**A template custom tag is a compilation unit.** `tags/x.mx` compiles through the
*same per-file pipeline a page uses*, into a module exporting the tag; the caller
emits an injected `import` plus an ordinary component call. Nothing is spliced
into the caller.

This is not new machinery but **less** of it: an explicitly imported tag already
worked this way on all six hosts, so the work was routing a *discovered* tag down
the same path and deleting the substitution engine (~1000 lines: `input`
substitution, hygiene renaming, caller-side import/static merging, expansion
depth and node caps, the cycle detector).

Consequences, each a limit that simply stopped existing:

- N reads of an attribute are N reads, not N evaluations.
- A spread attribute is ordinary.
- Bare `input`, `typeof input` and destructuring are ordinary.
- A self-recursive tag is legal ESM — and needs **no import**, because a
  discovered tag whose resolved path is the file being compiled resolves to that
  file's own export name (§9.6).
- `static` in a tag now runs **once per process**, not once per calling module —
  an observable behavior change for any tag whose `static` block has side
  effects.

`content` is reserved as an attribute name and `<@content>` is rejected, because
both collide with the body slot:

| Message | When |
|---|---|
| `` `<${call.name}>`: `content` is reserved on a template tag; it names the body slot `` | An attribute literally named `content`. |
| `` `<@content>` is reserved for the body of `<${call.name}>` `` | An attribute tag named `content`. |

A tag declaring `parseOptions.openTagOnly` reports at the **call site**:

| Message |
|---|
| `` `<x>`: does not accept content `` |

**Content is allowed by default**, as in Marko. Unlike Marko, which is silent, MX
**warns at the call site** when a body is passed to a tag whose template never
reads it — from cached metadata, so the caller need not see the template:

| Warning |
|---|
| `` `<${call.name}>`: body content was dropped; ${tag.filename} has no `<${input.content}/>` placeholder `` |
| `` `<${call.name}>`: `<@${name}>` was dropped; ${tag.filename} does not read `input.${name}` `` |

Silent-drop reports go through `ctx.warnings`, **not `console.warn`** — a
recorded positioned warning when a sink is collecting, falling back to printing
when none is. That is what lets the language server turn them into Warning
diagnostics in the file being edited, which is the one place a dropped-content
report is worth anything.

### 9.5 Hooks

A sidecar may declare `parseOptions`, `attributes`, `attributeTags`, `children`, `parents`, `analyze`,
`transform` and `finalize`. The hook is named **`transform`, not `resolve`** —
`resolve` is **reserved for an MX 2 Vite-style hook** (decision 87c), and
`migrate` is **reserved** for a source-printing mode.

A `transform` may return **IR** (a macro the author wrote — the only expansion
left in the language) or a **`TagCall`** (validate or rewrite the call, then
route it to the adjacent template unit).

Six invariants:

1. **Order is by tag name, twice.** Per file: every `analyze`, then every
   `transform` in source order, then every `finalize`; both hook phases sorted by
   tag name, and `finalize`'s nodes prepended to the body in that order. A
   `finalize` receives no other tag's output and no route to the program, so
   ordering cannot become semantically load-bearing.
2. **A store is per file *and* per tag**, keyed on the `Ctx`. A definition object
   is a module singleton handed to every file in a package, so keying anywhere
   else leaks one file's state into the next.
3. **A file containing a tag that defines `analyze` is lowered twice** — the
   first walk over a scratch context that records calls and is discarded, so
   `analyze` sees the identical `TagCall` its `transform` will get while the
   walk's hoists and warnings are not emitted twice.
4. **A unit boundary is a hook boundary** (decision 95). A call written inside a
   tag template belongs to *that* template's unit and is not replayed into the
   caller, so a file-level `analyze` sees only the calls its own file wrote. A
   tag that must collect across units does it through its own module state.
5. **Only a tag the file actually calls is finalized.** A tag declaring **only**
   `finalize` is rejected at registration.
6. The cached metadata a unit exposes to its caller is
   `{ readsContent, attributeTags }` plus `returnsValue` and the return value's
   source text — **and nothing else**.

The metadata cache is **bounded** (256 entries, oldest-inserted evicted), keyed by
path + mtime + source, with a provisional entry seeded before the compile so
direct and mutual recursion terminate.

### 9.6 Injected imports and export names

**The injected import is gensym'd and deduped by resolved path.** A discovered
tag may be named `icon`, which the casing rule will never resolve as a component,
and the caller may already bind that name — so the local is always generated
(`$mx_Icon1`). One import per module per tag; if the caller already imports that
same path, its binding is reused and nothing is injected.

Reuse has two guards, each a measured bug:

- **A type-only import is never reused** — it binds no runtime value.
- **Nor is one shadowed at the region.** A scope between the module and an MX
  region that re-declares the name would silently bind the call to whatever the
  caller passed. The check is deliberately coarse (any binder of that name on the
  path from module root to region), because over-reporting costs one extra
  import under a generated name, which is always correct, while under-reporting
  is the silent bug.

**Every emitted module's default export is named after its file**, never
anonymous: `icon.mx` → `export default function Icon(…)`, `table-of.mx` →
`TableOf`. `-` and `_` separate words, `$` does not; a basename that cannot start
an identifier is prefixed `Tag` (`9.mx` → `Tag_9`). The name is re-minted on
collision with anything the file already binds, and computed **before** the body
walk, because a self-recursive call resolves during that walk.

| Message | When |
|---|---|
| `` `<${call.name}>` is this file's own tag, and a host module region (an expression spliced into another module) has no module scope to declare it in; call it from a file that compiles to a module, or move the markup into its own tag file `` | A self-call from a region file, which exports nothing. |

### 9.7 Registration errors

Module declarations are validated as a complete map during discovery, before
precedence or host filtering drops any entry (decision 142). The following
module-only errors are thrown at the module file, `1:0`; the existing rows below
also run per module and keep that position. Programmatic maps and sidecars keep
their existing registration behavior.

| Message | When |
|---|---|
| `` `<${name}>`: `${key}` is not allowed in `mx.contracts`; use a tag sidecar for hooks other than `analyze` and for templates `` | `transform`, `finalize`, `template`, or any unknown top-level definition key. |
| `` `<${name}>`.analyze must be a function `` | Non-function `analyze`. |

| Message | When |
|---|---|
| `` `<${name}>` is a core-owned custom tag and cannot be shadowed by a registered custom tag of the same name `` | A registered map contains `try`. |
| `` `<${name}>`: a custom tag that defines only `finalize` has no call site and nothing to collect; add a `transform`, an `analyze` or a template file `` | `finalize` alone. |
| `` Unknown key "${key}" in the "${attrName}" attribute declaration of tag "${tagName}"; allowed: type, items, required, enum, default, literalOnly `` | Unknown attribute-declaration key. |
| `` Invalid "${attrName}" attribute declaration of tag "${tagName}": `items` requires `type: "array"` `` | `items` on an attribute whose `type` is not `"array"` (decision 138). |
| `` Invalid "${attrName}" attribute declaration of tag "${tagName}": `items` must be one of string, number, boolean `` | An `items` value outside the three literal element types. |
| `` Invalid "${attrName}" attribute declaration of tag "${tagName}": `enum` cannot be combined with `type: "array"` `` | `enum` with `type: "array"` or `type: "function"` (the message names the type). |
| `` Unknown key "${key}" in the "${tagAttrName}" attribute tag declaration of tag "${tagName}"; allowed: repeatable, required, attributes, attributeTags, children `` | Unknown attribute-tag-declaration key (decision 138 E4). The same check runs recursively; nested registration owners read `tag "card": "<@group>": "<@row>"`. Attribute and child declaration key lists remain unchanged at every depth. |
| `` Unknown key "${key}" in the "${childName}" child declaration of tag "${tagName}"; allowed: repeatable, required `` | Unknown child-declaration key (decision 138 E2). |
| `` `<${name}>`: `children` cannot be combined with `parseOptions.text: true` `` | A children contract on a raw-text tag. |
| `` `<${name}>`: `children` cannot be combined with `parseOptions.openTagOnly: true` `` | A children contract on a tag that cannot have a body. |
| `` `<${parent}>`: child `<${child}>` declares `parents` without `<${parent}>`; add `<${parent}>` to `<${child}>`'s `parents`, or remove `<${child}>` from `<${parent}>`'s `children` `` | A registered parent's `children` lists a registered child whose declared `parents` omits that parent (decision 138 E3). Names both tags, before parsing, even if unused; `#text` is not a tag. |
| `` `<${child}>`: parent `<${parent}>` declares `children` without `<${child}>`; add `<${child}>` to `<${parent}>`'s `children`, or remove `<${parent}>` from `<${child}>`'s `parents` `` | Conversely, a child's `parents` names a registered parent whose closed `children` omits that child. An undeclared `children` contract stays open; `#root` is not a tag. |

Attribute-tag parents use the same two-way cross-check (decision 138 E4): when `C.parents` names `"@row"`, **every** declared `row` on any tag, at any depth, with closed `children` must list `C`. Conversely, a `row.children` listing registered `C` requires `"@row"` in `C.parents` if that list is declared. Another open or compatible `row` does not exempt a conflicting declaration. Omitted contracts and undeclared parent names remain open; `#text` and `#root` are not tags. Messages use the same two-edit fix as above and include the attribute tag's complete owner chain, for example `` `<item>`: parent `<card>`: `<@group>`: `<@row>` declares `children` without `<item>` ``.

### 9.8 Call-site validation

Naming (decision 132): the host hook that claims a tag is `HostDeclarations.isDelegatedTag`, its resolver is `resolveDelegatedTag`, and the IR node a claimed tag lowers to is `DelegatedTag` (built with `ctx.build.delegatedTag`). These replace `claimsTag`, `resolveHostTag` and `HostTag`, with no aliases.

**Contract-only tags (MX addition, decision 130).** A custom tag may declare only a contract and have neither a `transform` nor a template. It counts as contract-only whatever else it declares, `{}` included: an empty declaration is a contract for a tag with no attributes and no body rules, and a hooks-only definition is one too. Where the active host claims the tag's name (`HostDeclarations.isDelegatedTag`), core validates the call as below, applies declared defaults, runs `analyze` over every call like any other custom tag, and lowers the call to a `DelegatedTag` with the call's attributes, attribute tags and body (a whitespace-only body is kept, exactly as for an unregistered claimed tag) and each attribute's position; the node's `span` and `nameSpan` are the ones an unregistered claimed tag gets. It differs from an unregistered claimed tag only in that the contract is enforced and defaults are added, and in what it rejects because it has no template: `` `/var` on `<tag>` is not supported: it has no template, so it has no `<return>` to bind ``; `` tag arguments `(...)` on `<tag>` are not supported in a standalone template ``; and, for an attribute-tag declaration with none of `attributes`, `attributeTags` or `children`, `` `<tag>`: attribute tag `<@x>` does not support attributes `` / `` does not support nested attribute tags ``. Decision 138 E4 lifts that restriction only for explicitly extended declarations, as below. Where the host does not claim the name, the call fails as before with the "neither a `transform` nor a template" error. With `openTagOnly`, a retained whitespace-only body is rejected with a positioned "does not accept content" error. Decision 141 makes retained normalized whitespace content on the `transform` path too: both paths reject same-line spaces, while newline indentation removed by Marko supplies no body. A tag that has a `transform` or a template otherwise keeps its existing contract semantics. Marko has no such tag: it reports "Unable to find entry point for custom tag" for a taglib entry with no `template` or `renderer` (`@marko/compiler` `babel-utils/tags.js:362-368`, `runtime-tags` `custom-tag.ts:427`), and treats an `html: true` entry without either as a native element. `ctx.build.delegatedTag` takes an optional fourth argument, the attributes to carry; omitted, the node has none.

**Recursive attribute-tag contracts (MX addition, decision 138 E4).** `CustomTagAttributeTag` accepts `attributes?: Record<string, CustomTagAttribute>`, recursive `attributeTags?: Record<string, CustomTagAttributeTag>`, and `children?: Record<string, CustomTagChild>`, alongside `required` and `repeatable`. Each declared map closes its own set; an omitted map on an extended declaration stays open. In particular, omitted `attributeTags` accepts undeclared nested attribute tags with attributes and further nesting, recursively, rather than applying the legacy body-only restriction. The shared attribute check enforces unknown names, required attributes, scalar types, expressions, `literalOnly`, enums, and E1's `array` / `function` / `items` rules at every depth. Spreads are rejected in a closed attribute map. Defaults on attribute-tag attributes are **not applied**, and never satisfy a required attribute.

The same E2 children checker runs on each attribute tag's authored body before its plain children lower. It supports the reserved `#text` class, required/repeatable paths through `<if>` / `<for>`, and nested attribute-tag levels; attribute tags themselves do not count as plain children. E3's direct-parent spelling remains `"@row"`. Attribute-tag cardinality uses the preserved control-flow tree: an exhaustive branch can satisfy `required`, a loop cannot, and a loop needs `repeatable: true`. An extended declaration can occur inside `<if>` / `<for>`; one declaring none of the three maps keeps the existing no-template rejection of attributes, nested attribute tags and controlled occurrences. Template-backed tags retain their `Input` checks and host capability gates.

Errors stop at the first in check order, not source order: authored children are checked before attributes, with attribute-tag bodies visited depth first. A child's error (even in a nested attribute tag) can therefore precede an invalid attribute written earlier on an enclosing tag. Errors name the complete owner chain: `` `<card>`: `<@row>`: unknown attribute `bogus` `` or `` `<card>`: `<@group>`: `<@item>`: missing required child `<leaf>` ``. Unknown/typed attributes point at the attribute, array-item errors at the element, unlisted children at the child, repetition at the second occurrence (or sole loop occurrence), and missing requirements at the receiving attribute tag. Registration checks unknown keys and E1 contradictions recursively, even for unused tags. No host-specific core rule is introduced (decision 126).

**Allowed authored children (MX addition, decision 138 E2).** `CustomTag.children` is a record of `{ required?, repeatable? }`, closed once present; omitted, children remain open. The reserved contract-vocabulary key `"#text"` allows non-whitespace text and `${…}` / `$!{…}`. Each non-whitespace text node or interpolation is one occurrence; whitespace-only text never counts. `required` means at least one occurrence on every path; `repeatable: true` permits more than one, including inside a loop. `<if>`, `<else-if>`, `<else if>` / `<else>` and `<for>` are transparent: the minimum is the minimum over branches (an absent final `<else>` supplies an empty branch), and a child inside `<for>` has minimum 0 and maximum infinity. Comments, `<const>` and `<define>` declarations are ignored; a `<define>` call counts by its authored name. Ordinary child tags count once by name, without descending into their own bodies (`<script>` and `<style>` count by name as well).

Core checks authored children before lowering them, so a child's transform output does not change its name or count. The rule applies to transform tags, template tags with declaration-only sidecars, and contract-only delegated tags on every target. A dynamic child is an error in a closed contract. `TagCall.childTree?: ChildNode[]` exposes this authored shape to `analyze` and `transform`: named `ChildTag`, `ChildText`, `ChildDynamic`, `ChildFor.nodes`, and `ChildIf.branches` (each branch has `unconditional` and `nodes`), each node positioned with `loc`. It is syntax metadata, not emitted IR. Contracts report the first error only.

**Allowed authored parents (MX addition, decision 138 E3).** `CustomTag.parents?: string[]` names allowed **direct** parents. Omitted, placement remains unrestricted; an empty list permits no placement. `"#root"` is a reserved key of the contract vocabulary: it means the top level of a file or of a template's own compilation unit, never the template's caller. `<if>`, `<else-if>`, `<else if>` / `<else>` and `<for>` are transparent. `<define>` is not transparent: a tag in a `<define>` body has parent `define`. A dynamic parent reads `<${…}>` in diagnostics and never matches a `parents` list, even one spelling that diagnostic placeholder. Every other authored tag breaks the chain, whether registered or not: `<attributes><div><attribute/></div></attributes>` gives `attribute` the direct parent `div`. An attribute-tag body has that attribute tag as its direct parent, written `"@row"` in a parents list for `<@row>`. A recursive call inside its own template follows the same rule: top-level recursion has parent `#root`, not its own tag name.

Core tracks authored tag ancestors on the lowering context and checks the parent before lowering the custom call's body or invoking its hooks. Synthesized transform output is not authored syntax and is not checked. The rule covers transform tags, templates with declaration-only sidecars and contract-only delegated tags on every target, with no host-specific branch. Parent diagnostics have no colon prefix and stop at the first error:

| Message | When |
|---|---|
| `` `<attribute>` must be inside `<attributes>`; found inside `<div>` `` | Direct parent is not allowed, positioned at the offending tag's `<`. For an attribute-tag parent, `found inside <@row>` is backtick-quoted the same way. Multiple named parents are comma-separated. |
| `` `<attribute>` must be inside `<attributes>`; found at the top level `` | File/template root is not allowed. A `#root`-only list says `must be at the top level`; a mixed list adds `or at the top level` after the named parents. An empty list says `must be inside an allowed parent (none declared)`. |

The other call-site diagnostics carry the `` `<tag>`:  `` prefix:

| Suffix | When |
|---|---|
| `does not accept content` | `openTagOnly` and a body. |
| `accepts no attributes` | Any attribute on a tag declaring `attributes: {}`. |
| `spread attributes cannot be checked against this tag's declared attributes` | A spread on a tag declaring attributes. |
| `unknown attribute \`${attr.name}\`` | Not declared. |
| `attribute \`${attr.name}\` must be a literal` | `literalOnly` violated. |
| `attribute \`${attr.name}\` must be ${type}, got ${literal.type}` | Declared type disagrees. |
| `attribute \`${attr.name}\` must be ${type}, got ${shape}` | `type: "array"` or `"function"` and the written value has another shape (`string`, `number`, `boolean`, `object`, `array`, `function`). An identifier, call, member or conditional has no knowable shape and is accepted. A function is an arrow function, a function expression or the method shorthand `value({ post }) { … }`; the last two reach the contract only on a host that resolves attribute methods (`resolveAttributeMethod`), any other host rejects them before the contract runs. A template literal counts as a string, and a bound attribute (`value:=…`) is checked like a dynamic one (decision 138). |
| `attribute \`${attr.name}\` item ${n} must be ${items}, got ${shape}` | `type: "array"` with `items` and a literal element (1-based) of another shape; positioned at the element. A non-literal element, a spread or a hole passes. |
| `attribute \`${attr.name}\` must be an expression` | `type: "expression"` but static or boolean. |
| `attribute \`${attr.name}\` must be a static value from ${…}` | `enum` declared, value not a literal. |
| `attribute \`${attr.name}\` must be a string from ${…}, got ${literal.type}` | `enum` on a non-string. |
| `attribute \`${attr.name}\` must be one of ${…}, got ${…}` | Not in the enum. |
| `missing required attribute \`${name}\`` | Required attribute absent. |
| `unknown attribute tag \`<@${tag.name}>\`` | Not declared. |
| `attribute tag \`<@${tag.name}>\` may not be repeated` | Second occurrence without `repeatable`. |
| `missing required attribute tag \`<@${name}>\`` | Required attribute tag absent. |
| `` `<${name}>` is not allowed here; allowed children: `<a>`, `<b>` `` | Unlisted authored child, positioned at the child's `<`; an empty allowed list reads `none`. |
| `` text is not allowed here; it accepts only the child tags `<a>`, `<b>` `` | Non-whitespace text or interpolation without `#text`, positioned at the text/interpolation. With an empty `children` declaration the message ends `it accepts no child tags`. |
| `` a dynamic tag `<${…}>` cannot be checked against the declared children `` | Dynamic child, positioned at its `<`. |
| `` `<${name}>` may not be repeated `` | Maximum occurrence count exceeds 1 without `repeatable: true`; positioned at the second occurrence, or the sole loop occurrence. |
| `` missing required child `<${name}>` `` | Minimum occurrence count is 0 for a required child; positioned at the parent call. |

Transform-time:

| Message | When |
|---|---|
| `custom tag has neither a \`transform\` nor a template file, so a call has nothing to expand to` | Neither present and the host does not claim the name (§9.8, decision 130). |
| `` `<${call.name}>`: custom tag threw: ${message} `` | A `transform` threw a non-`TranslateError`. |
| `custom tag transform must return an array of IR nodes or a TagCall for its template` | Bad return value. |
| *(warning)* `` `<${call.name}>`: custom tag transform did not read its attributeTags; authored attribute tags were dropped `` | A macro `transform` never touched `call.attributeTags` while the call had some. Detected with a `Proxy`. |

**Decisions:** 80, 85, 87, 89, 90, 91, 93, 94a, 94d, 95, 97, 98, 130, 138, 141.

---

## 10. `<return>` and `/var`

### `<return>`

A template may end with `<return value=EXPR/>`: **value only**, no
`valueChange` — MX deliberately subtracts Marko's two-way channel. At most one
per template, at the **top level** only.

**Every rule is validated in the tag's own compilation.** That is what makes the
signature one shape rather than `T | undefined` per path: a unit cannot see its
callers, so no call site can widen it. `<return>` in a *page* is legal and means
the same thing.

| Message | When |
|---|---|
| `` `<return>` does not support body content `` | A body. |
| `` `<return>` does not support spread attributes `` | A spread. |
| `` `<return>` does not support the `valueChange` attribute; MX returns a value only, with no two-way channel `` | `valueChange`. |
| `` `<return>` does not support the `${attrName}` attribute `` | Any attribute but `value`. |
| `invalid duplicate \`value\` attribute` | Two `value`s. |
| `` `<return>` requires a `value=` attribute `` | No value. |
| `` `<return>` must be at the top level of its template; it declares the value the whole unit returns, so it cannot be conditional or nested `` | Inside a native tag, `<if>`, `<for>`, an attribute tag or a `<define>`. |
| `cannot have multiple \`<return>\` tags for the template` | Two `<return>`s. |

Plus the four generic field rejections (§4) with `` `<return>` `` as the label.

### The export shape is the host's business

| Host | Shape |
|---|---|
| html, Preact, React, Hono | `{ value, output }`; the call is emitted as an ordinary **function call**, not a JSX element — a JSX element is a *description* of a call the runtime makes later, so it could never hand the pair back |
| Solid | A generated `$mxReturn` **callback prop** the unit calls during setup, because a Solid component's return value is its view. **One-shot, not reactive** — a tag wanting reactivity returns an accessor |
| Astro | Renders through its own renderer rather than a call site, so the pair is unwrapped there |

**A returning unit on a JSX host may not import hooks.** It is invoked as a plain
function, so Preact's/React's dispatcher would bind its hooks to the *calling*
component's hook list — order-dependent, broken under conditional or looped
calls, and `useContext` would read the caller's position. Importing a `use*`
binding from `preact/hooks`, `preact/compat`, `react` or `hono/jsx` into a unit
declaring `<return>` is a compile error. Solid is unaffected; its callback prop
keeps the unit a component.

### `/var`

`/var` binds a returning tag's value at the call site.

**`/var` is top-level-only on the JSX hosts and Solid.** Every structural kind
lowers to an *expression* there — a ternary, a `.map` callback, a `<For>` render
prop — so a callback scope has no statement position for the binding. Hoisting
the call to the component body took it out of the scope it was written in (it
read row bindings that did not exist there, and ran once for a body rendered N
times), so the escape is rejected rather than silently relocated. **html** keeps
supporting the nested case, where the temp lands inside the emitted `for`/`if`
block. **Angular** rejects `/var` entirely.

**`.astro.mx` rejects `/var` entirely too, and for a different, structural reason**
(host-cannot, ruled 2026-09-28 on TODO `amx-tag-var`): Astro runs the `---`
fence to completion *before* Astro's own compiler ever lowers or calls the
template's tags, so by the time a returning tag is actually called there is no
statement position left anywhere — not in the fence (already finished), and
not in the template (markup, not statements) — to bind a value into. This is
unlike the JSX-host/Solid restriction above, which is a real MX 2 gap
(`tag-var-in-callback-scope`); `.astro.mx`'s case cannot be lifted by giving a
callback scope a statement position, because there is no callback scope here
at all. The workaround is to call the unit directly from the fence's own
TypeScript instead of from the template — an ordinary function call, since a
`.mx` unit compiled for this host still exports the plain
`{ value, output }` shape (see the table above):

```astro
---
import Counter from "./tags/counter.mx";
const { value } = Counter({ start: 1 });
---
<p>{value}</p>
```

Lifting the restriction means a statement position per callback scope — **MX 2,
`tag-var-in-callback-scope`**.

Three positioned diagnostics stand in for what JavaScript would leave as
`undefined` or a TDZ crash:

| Message | When |
|---|---|
| `` `/var` on `<${name}>` is not supported: it has no template, so it has no `<return>` to bind `` | A `/var` on an L2 sidecar with no template. |
| `` `<${call.name}>` does not return a value; add `<return value=…/>` to ${tag.filename} to bind it with `/var` `` | The unit declares no `<return>`. |
| `` `${name}` is a `/var` bound inside a nested block and is not in scope here; a `/var` binds in the call site's own scope only `` | The read escaped the declaring block. |
| `` `${name}` is read before the `/var` that binds it; move the read after the call that declares it `` | The read precedes the declaring call. |

MX **rejects the escape** rather than hoisting the binding into a getter as Marko
does, which would change its user-visible type (invariant §7.5-8).

Mechanics that are normative:

- Reads are found by **parsing** (free identifiers), never by regex, so
  `${"the letter n"}` and `<for|n|>` do not false-positive.
- A tag param of the same spelling **shadows** the `/var` and is skipped.
- Only a *custom tag call* pre-registers a pending `/var`; `<let>`, `<const>` and
  other `/var`-taking constructs are excluded.
- A call's own attributes **cannot** read the `/var` that same call declares.
- **Scope is a path of block ids, not a depth** — a read in a sibling block sits
  at the same depth as the binding yet is not in scope.

**Solid-only divergence: `/var`'s bound type is `any`, not the `<return>`
expression's real type (TODO `tag-var-type-from-return`, filed from PR #159
round 2).** On html, preact, react and hono, the caller binds `/var` with
`const n = temp.value;`, and TypeScript infers `n`'s real type from the
callee's own return signature for free. Solid cannot do this: its `/var` is
assigned inside the region's or unit's `$mxReturn={($mxV) => { n = $mxV; }}`
callback prop (§9's return-value table), so TypeScript's control-flow
analysis has no directly-assigned value to narrow `n`'s declaration from —
only a callback invoked at some later, statically-unprovable point. Firstmate
ruled (2026-09-28) that inferring the real type here is not possible without
changing the emitted runtime JS: TypeScript's `typeof` operator only accepts
an identifier, never an arbitrary expression, and the `<return>` expression
can itself depend on the unit's own body locals (`<let>`, `<const>`, a
derived signal), so no type-only declaration placed beside the component can
name it either — every route tried requires either duplicating the
expression's evaluation at runtime or making the callee generic over a type
parameter no caller can supply (JSX call sites take no type arguments).
Solid explicitly declares the binding `let n: any;` (not a bare `let n;`,
which would additionally report `noImplicitAny`'s own TS7005 on every read,
unrelated to this gap) on both the `.solid.mx` region path
(`@mxlang/parser`'s `hoistRegionImports`) and the whole-file `.mx` path
(`@mxlang/solid`'s `compileSolidUnit`). A misuse of the bound value (e.g.
calling a string method on a `<return>`'d number) type-checks clean today —
pinned by a regression test on each path, named so a future fix (MX 2's
per-callback-scope statement position, `tag-var-in-callback-scope`, would
also let Solid's `/var` bind synchronously instead of through a callback)
flips the assertion.

**Decisions:** 67d (superseded), 95, 97e, 97f, 97g, 97h, 98.

---

## 11. Stateful tags

`<let>`, `<effect>`, `<lifecycle>`, `<script>`, `<id>`, `client` blocks and `:=`
are **not part of the portable structural core**. They are framework territory:
core provides three hooks, and **each host's declarations decide what they mean**
(decisions 70, 71).

A template using `<let>` means something different depending on which host
compiles it — the same way JSX means something different per framework. **Cost
accepted explicitly:** templates using stateful tags are not portable across
hosts.

### The capability test

Decision 65, normatively:

> Does the construct contribute to the emitted bytes, or does it only configure
> behaviour after the first render? The second kind is **inert** (accepted, no
> output); the first must **lower** or must **error**. And **"my code can't" is
> never a reason for a table row — only "this target can't."**

### Inert is a shape, not a licence to drop

An inert tag's own attributes and body are validated against what its Marko tag
definition allows; anything else is an error naming the tag. Otherwise
`<effect><div>x</div></effect>` compiles clean with the `<div>` deleted.

| Message |
|---|
| `spread attributes on \`<${name}>\` are not supported: the tag emits nothing, so a spread's keys would be silently discarded` |
| `` `<${name}>` does not support the `${attr.name}` attribute; it emits nothing, so the attribute would be silently discarded `` |
| `` `<${name}>` does not support body content; it emits nothing, so the body would be silently discarded `` |

Declarations are **per tag**, because Marko is: `<effect foo="bar"/>` and
`<log=1 foo="bar"/>` are refused, while `<lifecycle foo="bar"/>` compiles (a
lifecycle tag's attributes are its configuration) and `<script>` is the one inert
tag taking a body (raw text).

### The three hooks

1. `isDelegatedTag`/`resolveDelegatedTag` — the lower-time tag handler.
2. `ctx.hoist(code)` — lift a statement to the enclosing function's head (the
   render function, or the nearest `<define>`).
3. `ctx.bindings.register(name, rewrite)` — rewrite identifier **references**, so
   a host whose state is a getter emits `count()` for `${count}`. Rewrites apply
   only to reference positions, and emitted-JS scopes restore shadowed names.

### The `strict` policy

An opt-in stance, not the default (decision 68's policy fold). Under `strict`,
the same six constructs — `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client`
blocks, `<id>` — become errors naming the construct, for an author who wants
"this template needs a reactive runtime" enforced at compile time.

Decision 111 adds `<log>` and `<debug>` to the same `strict` error set:
debug-only tooling, not reactive constructs, but a `strict` author gets the
same named-construct error instead of the default policy's inert row.

The `input`-shadowing check (§5.6) is **not** `strict`-only.

Dropped rather than folded in, being conventions of the retired dialect rather
than target capabilities: the explicit-import requirement, the
`export interface Input` requirement, `<fragment>`, and lowercase-by-scope tag
resolution.

### No MX runtime

Decision 82: **if an `.mx` file ever needs a client runtime, that runtime is
Marko**, not Solid. A host may ship framework code an author would otherwise
write by hand (Preact's `MxErrorBoundary`, for instance) — that is not an MX
runtime, and a template using none of it imports none of it.

**Decisions:** 54, 65, 67a, 68, 70, 71, 79, 82, 85.

---

## 12. Positions and diagnostics

### The contract

A `TranslateError` carries **1-based `line`** and **0-based `column`** — what
Marko's nodes have, not byte offsets. Every IR node carries a position
(decision 79).

Three position rules:

1. A position with no `file` belongs to **the file being compiled** — the
   overwhelmingly common case, so every position that predates tag templates is
   unchanged and no consumer has to ask.
2. `Position.file` names another file when material comes from a **tag template**,
   so a diagnostic raised inside `tags/icon.mx` points into the template rather
   than at the call that used it.
3. `Expr` additionally carries an optional `span` — **file-absolute byte
   offsets** of the expression's authored source — absent when there is no
   authored source, rather than fabricated.

`Position.file` and `Expr.file` are **read-only plumbing today**: nothing in
`packages/core` writes either. A tag unit compiles under its own context, so its
expressions are already absolute against their own file. The one place a
foreign file is attached is a `TranslateError` escaping a unit's metadata
compile, re-thrown with the tag's filename.

### One base for every printed position (ruling #227)

A position MX **prints** is **1-based line and column** — the basis `mx-tsc`
prints (`file(line,column)`) and every editor uses. That holds for a position
inside a message's text, not only for a `file(line,column)` header: a warning
that names `the later one at 1:16`, the position in a callee-read failure
(`... (card.mx:2:24): Unexpected token`), an Angular build prefix and a
`mx-angular map` answer all use the same base, so a reader — or an agent —
never has to guess which of two numbers on one line is right.

The **structured** fields keep the compiler's own base, which is unchanged and
is what every consumer already expects: `TranslateError.line`/`column`,
`MxWarning`, `ScanDiagnostic` and `TargetPolicyDiagnostic` carry a **1-based
line and a 0-based column** (Babel's), because an LSP range, a Volar offset or
a TS `textSpan` is computed from the 0-based column. Only the printed text is
converted, and only at the print site.

A message may also quote **another file's** parser position verbatim — a
wrapped callee's `Unexpected token (1:32)`, or Marko's own `at <path>:L:C`
frame header, which is 1-based already. Those stay as they are: that position
belongs to a file the diagnostic itself does not locate, and nothing else
records it.

### Consumer obligations

- The **language server** publishes a foreign-file diagnostic against the
  template's own URI at its real position, and leaves a pointer at the head of
  the open document — LSP cannot publish against a file it was not asked about,
  and the template is not itself open. It clears the template's diagnostics when
  the caller stops reporting them.
- The **TypeScript plugin** and **`mx-tsc`** report a `TranslateError` whose
  `file` names another file (a compile error raised inside a tag template)
  against that template file at its own position, and leave a pointer
  diagnostic on the caller naming the template — matching the language
  server. A Volar `CodeMapping` still addresses one source only, so this is a
  second, file-keyed compile diagnostic, not a mapped span: a plausible-but-
  wrong column inside one file's mappings is still worse than none.
- **Every integration that scans must surface `ScanResult.diagnostics`** (§9.2).

### A host is not done without its diagnostics

Decision 71, and the reason `@mxlang/language-server` exists: Marko's own
language server compiles with a hardcoded config carrying **no host policy**, so
a construct a host's `strict` policy rejects is valid Marko and Marko's server
reports nothing. `tsserver` cannot fill the gap either — it never opens a `.mx`
file, only the `.ts`/`.tsx` files that import one.

MX's server is **diagnostics-only** by design: adding completion or hover would
mean re-implementing Marko's language server, which it runs *alongside*, not in
place of.

**No file-extension routing for diagnostics** (decision 71): extensions pick a
grammar, they do not produce diagnostics. Host and `strict` are resolved from the
nearest `package.json` (§13.5).

**Decisions:** 70, 71, 72, 79, 80, 88, 91, 94c, 95(2), 97f, 99.

---

### Literal Angular syntax in an Angular template (mx-only lint, decision 126)

In a `.mx` page, tag or `.ng.mx` region, text that is Angular template syntax
is **plain text** to Marko and to MX: `{{ name }}` and `@if (x) {` have no
meaning to Marko's parser (only `${…}` and `<…>` do), so they compile and render
literally. The Angular host reports each occurrence as a **positioned warning**
(not an error) at the `{{` or the `@`, with a one-line hint to the MX form:
`{{ x }}` → `${x}`, `@if (x) {` → `<if=x>…</if>`, `@else if`/`@else` →
`<else if=…>`/`<else>`, `@for (i of xs; …) {` → `<for|i| of=xs>…</for>`,
`@switch`/`@case`/`@default` → `<if>`/`<else if>` chains, `@let z = 1;` →
`<const/z=1>`. `@defer`, `@placeholder`, `@loading`, `@error` and `@empty` have
no MX form, so their message gives only the escape. A `{{ … }}` body is
rewritten to `${…}` only when it parses as JS with no Angular pipe
(any single `|` outside a string, at any depth: Angular has no bitwise OR); for a pipe the message says pipes have no MX form. The scan stays inside
the text node's own source span (also in concise mode).

It never fires in an attribute value, a `${…}` placeholder (so `${"{{"}` writes
a real literal `{{`), an HTML comment, `<script>`/`<style>`/`<html-script>`/`<html-style>` content, or on a lone `{`/`}`
or an `@` in prose (`user@host`, "the @if keyword", "Ping me @if (now) only"):
`{{` needs its closing `}}`, and `@name` needs real block syntax after the
keyword: a balanced `(…)` then `{` (`@if`, `@for`, `@switch`, `@case`,
`@else if`, `@defer`), a bare `{` (`@else`, `@default`, `@empty`,
`@placeholder`, `@loading`, `@error`), or `name = …;` (`@let`). Each message
also names the literal escape, `${"{{"}` or `${"@"}if`. Text in `<pre>`,
`<code>` and `<textarea>` still warns (Angular interpolates there too), so a
page that shows Angular syntax uses the escape. The lint covers `.mx` pages and
tags compiled by the Angular host as well as `.ng.mx` regions. This is a lint
beyond Marko (decision 72), lives only in `packages/hosts/angular`, and is
recorded in `divergences.md`.

## 13. Host semantics table

*This section is written from the host-survey pass and is the one place where
"host-defined" resolves to a concrete answer per host.*

Every cell below was verified by **compiling a probe through the host's real
entry point**, not read from its README. Where a README disagrees, the README is
listed in §16.

Hosts: **html** (default policy), **html-strict** (which is also how
**Astro `.mx`** compiles), **Solid**, **Preact/React/Hono** (one shared emitter,
differences noted), **Astro `.astro.mx`**, **Angular**.

### 13.1 Structural core

| Construct | html | html-strict / Astro `.mx` | Solid | Preact / React / Hono | Astro `.astro.mx` | Angular |
|---|---|---|---|---|---|---|
| `if`/`else-if`/`else` | `if`/`else if`/`else` statements | same | ≤2 branches → `<Show when fallback>`; 3+ → `<Switch>`/`<Match>` | ternary chain, `null` arm when no `<else>` | ternary chain over `<Fragment>` | `@if`/`@else if`/`@else` |
| `for of` | `for (const p of …)` | same | `<For each>` (no `keyed`) | `.map`, key = item identity | `.map`, **no key** | `@for (… track $index)` + warning |
| `for of` + `by="id"` | **ignored** | ignored | `keyed={x=>x.id}` | `key={p.id}` | **ignored** | `track p.id` |
| `for in` | `Object.entries` loop | same | `<For each={Object.entries(o)} keyed={e=>e[0]}>`, reads via `mxEntry()` | `.map(([k,v])=>…)`, `key={k}` | `.map(([k,v])=>…)` | `\| keyvalue: null` + warning |
| `for` range | `for (let i=a; i<=b; i++)` | same | `<Repeat count from>` | `Array.from({length}).map` | `Array.from({length}).map` | folded literal array |
| `for` range + `step=` | **error** | error | `<Repeat>` with `i = from + k*step` | `Array.from` with computed length | error | folded literal array |
| `define` | local render function | same | **error** — no local component form in a JSX expression | `const R = (p) => (<>…</>)` hoisted | **error** — extract to its own `.astro.mx` | `<ng-template #R let-p>` |
| `const` | `const x = …` | same | **error** in a region | `const` at component-body top | **error** — declare it in the fence | `@let x = …;` |
| `let` | initial value only | **error** (strict) | **error** — use `createSignal` | **error** — use `useState` | **error** | error — fixed 2026-09-17, `<let>`-specific message; was **the wrong error** (bug 1, only the generic `/var` field guard fired) |
| `try` | `try`/`catch` | same | `<Loading>` | body inline | **error** | **error** |
| `try` + `<@catch>` | `catch` block | same | `<Errored fallback>` | `MxErrorBoundary` (Preact/React) / native `ErrorBoundary` with `fallbackRender` (Hono) | error | error |
| `try` + `<@placeholder>` | **error** — needs a second render pass | error | `<Loading fallback>` | `MxPlaceholder` / `Suspense`, nested **inside** the boundary | error | error |
| `<return>` + `/var` | `{ value, output }`; `/var` in **any** scope | same | `$mxReturn` callback prop; `/var` top-level only | `{ value, output }`; `/var` top-level only; **hook imports are a compile error** | **error** | error — fixed 2026-09-17 (page level; the tag-unit call site was already an error); was **accepted and silently dropped** (bug 8) |

### 13.2 Markup and attributes

| Construct | html | Solid | Preact | React | Hono | Astro `.astro.mx` | Angular |
|---|---|---|---|---|---|---|---|
| `${}` | `__mxEscape(x)` | `{x}` | `{x}` | `{x}` | `{x}` | `{x}` | `{{ x }}` |
| `$!{}` | raw append | sole child → `innerHTML` | `dangerouslySetInnerHTML` | same | same | `<Fragment set:html>` | `<span [innerHTML]>` + warning |
| `class="a"` | `class` | `class` | `class` | `className` | `class` | `class` | `class` |
| `class={…}` | inlined `__mxClassValue()` | native `class={{…}}` | `__mxClass(…)` | `__mxClass(…)` | `__mxClass(…)` | `class:list` | `[ngClass]` + warning |
| `style={…}` | inlined `__mxStyleValue()` | `style={{…}}` | `style={{…}}` | same | same | `style={{…}}` | `[ngStyle]` + warning |
| spread | merged into attrs | `{...o}` | `{...o}` | same | same | `{...o}` | **error** — Angular binds statically named inputs only |
| `:=` | **initial value only, silently one-way** | **error** | **error** | error | error | **error** | `[(value)]` — **genuinely two-way** |
| `class:foo` | **error**, quoting Marko | error | **error** | error | error | **error** | error, naming the replacement — fixed 2026-09-17; was **accepted** → `[class.active]` (bug 7) |
| dynamic tag | `__mxRenderDynamic()` | `<Dynamic component>` | `__mxDynamic()` | same | same | **error** | `[ngComponentOutlet]` + warning |
| component resolution | Marko's rule (binding + case) | **case only** | Marko's rule, with `componentAlias` | same | same | **case only** | **case only** |
| repeated `<@item>` | declared real array; fallback array | declared real array; fallback array | declared real array; fallback array | same | same | **error** — a slot is keyed by name | **error** — a projection is keyed by name |
| tag params | body block | child callback | render-prop child | same | same | **error** — Astro has no render-prop form | `let-x` |
| `<!doctype>` | emitted | **error** | **error** | error | error | emitted | emitted + warning |
| HTML comments | **stripped** (Marko parity) | stripped | stripped | stripped | stripped | **kept** | **kept** |

### 13.3 Stateful tags

| Tag | html | html-strict / Astro `.mx` | Solid | Preact/React/Hono | Astro `.astro.mx` | Angular |
|---|---|---|---|---|---|---|
| `<effect>` | inert | error | error | error | error | error — fixed, was **literal element** (bug 1) |
| `<lifecycle>` | inert | error | error | error | error | error — fixed, was **literal element** |
| `<script>` | inert (body `text`) | error | error | error | error | error — fixed, was **literal element** |
| `<id>` | inert | error | field-guard error | error | error | error — fixed, was field-guard-only |
| `<log>` / `<debug>` | inert | error — fixed 2026-09-28 (decision 111), was **inert** (bug 5) | **literal element** | **literal element** | **literal element** | error — fixed, was **literal element** |
| `client` block | inert | error | **literal element** | error | error | error — fixed, was **literal element** |
| `server` block | **runs**, hoists like `static` | **runs** | **literal element**, binding undefined | **literal element** | **literal element** | error — fixed, was **literal element** |
| `<await>` | error | error | field-guard error | error | error | error — fixed, was field-guard-only |

**Only `@mxlang/html` and Angular have a complete tag-disposition table.**
(Fixed 2026-09-17, task `angular-spec-gaps`: Angular's emitter declared only
`try`, so every other name fell through to element resolution and became a
literal lowercase element — bug 1, closed by `STATEFUL_ERRORS` in
`packages/hosts/angular/src/emitter.ts`.) The Solid emitter still declares only
four entries. Every undeclared name there falls through to element/component
resolution, and because Solid's `isElement` is a bare case test, an unhandled
stateful tag still becomes a **literal lowercase element** in the output —
the S8 silent-wrong-render class the field guard exists to close.

### 13.4 Where hosts genuinely disagree

Not merely in emitted syntax — in observable behavior:

1. **`by=`** is ignored on html and `.astro.mx`, item identity on the JSX hosts,
   reconciliation identity on Solid, `track` on Angular. Ignoring it is
   defensible on html (a one-shot render reconciles nothing) but `.astro.mx` is a
   client-visible target and drops it with no diagnostic.
2. **The default `<for>` key.** Four different reconciliation behaviors from one
   MX source: item identity (JSX hosts), `$index` (Angular, warned), none
   (`.astro.mx`), reference (Solid).
3. **`:=`** is genuinely two-way only on Angular; renders one-way with no error
   on html; rejected everywhere else.
4. **`server` blocks** execute on html and become junk markup everywhere else.
5. **`<let>`** binds an initial value on html and errors everywhere else,
   Angular included (fixed 2026-09-17; was the wrong error, bug 1).
6. **`<return>`** is a real value channel on html and the JSX hosts, a callback
   prop on Solid, an error on `.astro.mx` and, since 2026-09-17, on Angular too
   (was silently dropped, bug 8).
7. **Comments** are stripped on html/Solid/JSX and kept on `.astro.mx`/Angular.

### 13.5 Host and target selection

A **host** is a framework; a **target** is an output format (decisions 129/132).
`@mxlang/core` resolves the nearest `package.json` through a required open-set
lookup; tools use `@mxlang/target-registry`'s built-in wrapper.

1. `mx.target` names a registered target directly: `html`, `astro-html`,
   `solid-jsx`, `preact-jsx`, `react-jsx`, `hono-jsx`, `angular-template`, or
   `data` (subject to the tooling limit below). A host name here is an
   `unknown-target` **error** with its default target in the hint; other unknown
   names get a nearest-target suggestion when within two edits. A package
   specifier (containing `/` or starting with `@`, `.` or `/`) is not a built-in
   name: it is loaded from the project as a third-party target (below).
2. `mx.host` selects that host's default target. `mx.host: "html"` is accepted
   silently, the legacy spelling of `mx.target: "html"`. `"translator"` remains
   a deprecated alias with its existing warning. A bare unknown word remains a
   warning. A package specifier is loaded as a third-party target whose
   descriptor must carry a `host` part (below).
3. If both keys resolve, they must agree: the target belongs to the named host,
   or the legacy host value selects that same target. Otherwise
   `target-host-mismatch` is an **error** at the `mx.target` value, quotes
   included, with related information at `mx.host`. The diagnostic explains
   whether this is another host's target, a hostless target, or a legacy-value
   conflict, and asks the author to remove one key. Tools retain the explicit
   target for subsequent diagnostics, never silently replace it.
4. If exactly one key resolves, it selects the target. A hosted target alone
   also selects its host's behaviour. `mx.target: "html"` beats a dependency on
   `@mxlang/solid`; it needs no `mx.host`.
5. If neither resolves, exactly one registered target package in `dependencies`
   or `devDependencies` selects its target; otherwise the default is `html`,
   non-strict. `@mxlang/core` and `peerDependencies` do not count (decision 124).
   An invalid target still hands on this fallback (or a resolved `mx.host`) so
   later diagnostics are not drowned, but it cannot produce a green build.

`mx.strict` accompanies an explicitly selected target as it did an explicit
host. `mx.tags[].hosts` still filters by **host**, not target: `solid-jsx` there
warns that it is a target and suggests `solid`.

**Third-party targets.** A package specifier under `mx.target` or `mx.host` is
resolved from the directory of the `package.json` that holds the key (never from
the tool, so a VSIX-bundled language server finds a target the project installed),
required synchronously, and validated. The module's default export, else its
named `mxTarget` export, else the module itself when it is the descriptor
(`module.exports = descriptor`), must be a target descriptor of
`descriptorVersion` 0. Rule 5's single-dependency inference applies to built-in
targets only: a third-party target always needs an explicit `mx.target` (or
`mx.host`) key. The descriptor is cached per resolved file and the target
package's `package.json` (modification time and content), so its identity is
stable between calls and a reinstall is picked up. A load that failed is retried on
every resolution, so fixing any file it loaded is picked up at once. After installing a missing
target, restart the language server, TS server or dev server: both Bun and Node
keep a resolution miss once the project has a `node_modules`.

A specifier that resolves and then fails to load or validate is an **error with
no fallback to a guessed target** (the same family as `target-host-mismatch`:
a build that compiled under a target the author did not name would be green and
wrong). Tools still hand on the rule-5 target so later diagnostics are not
drowned. Each error is one line then the action, with no stack, positioned at
the key's value (quotes included, with `length`):

| Code | When | Message |
|---|---|---|
| `target-not-found` | the specifier does not resolve from the project | `mx.target "@acme/mx-vue" cannot be resolved from /p/app: <first line of the resolver's message>. Install it (bun add -d @acme/mx-vue) or use a built-in target: html, …` (a relative or absolute path says `Check the path` instead of `Install it`) |
| `target-load-failed` | evaluating the module throws | `mx.target "@acme/mx-vue" failed to load: <message>. (/p/app/node_modules/@acme/mx-vue/dist/index.js)`; a top-level `await`, or a relative import without its extension, adds the reason (the load is synchronous) |
| `target-invalid-descriptor` | the export is not a descriptor: the **first** failing field only; an unsupported `descriptorVersion`; or it cannot be registered next to the built-in targets (below) | `mx.target "@acme/mx-vue" must export a target descriptor (default export or "mxTarget"): "name" is missing, expected a string. See the TargetDescriptor contract (unstable).`; `… targets descriptor version 1; this mx supports 0.`; `mx.target "@acme/mx-vue" cannot be registered next to the built-in targets: <reason>. See the TargetDescriptor contract (unstable).` |
| `host-invalid-descriptor` | a specifier under `mx.host` exports a descriptor with no `host` part | `mx.host "@acme/mx-vue" exports a target with no host. Use mx.target "@acme/mx-vue", or give the descriptor a "host" part.` |

A descriptor cannot be registered when the built-in targets already own what it
claims. The `<reason>` is the first of: `file kinds are supported for built-in
targets only (for now)` (a loaded descriptor may not declare `host.fileKinds`;
TODO `third-party-file-kinds`); `host "solid" belongs to the built-in targets; a
third-party target cannot join it (for now)` (a loaded target may not name a
built-in host; TODO `third-party-join-builtin-host`); or the set rule
`createTargetLookup` enforces (a target registered twice, a name that is a host
name, a reserved name, a package, `mx.host` value or file-kind segment already
taken).

`mx.host` and `mx.target` agree under rule 3 with a loaded descriptor exactly as
with a built-in one: they agree when the target's `host.name` is the host the
other key names. `mx.host` may be a specifier of the same package, of another
package whose descriptor has the same `host.name`, or the bare host name itself
(`mx.host: "vue"` beside `mx.target: "@acme/mx-vue"` whose host is `vue`); none
of these warns about an unknown host. The language
server shows the error on the document, linked to the key in `package.json`;
the TypeScript plugin and `mx-tsc` report `TS80003` at the key and `TS80001`
`target not loaded: see package.json(line,col)` on the page, and exit non-zero;
the Vite plugin fails the transform with the same text.

The loader hands the tool the descriptor; the **tool** then calls
`descriptor.load(core)` with **its own** `@mxlang/core`. A target uses that
injected `core` (one scan cache, the editor's unsaved-buffer overrides, and one
`TranslateError` class) rather than importing its own. A target that imports its
own copy still works: `TranslateError`s are recognised across copies by a
`Symbol.for` brand, so a positioned error stays positioned. Such a package
declares `@mxlang/core` as a **peer** dependency. The descriptor contract is
**unstable** until `@mxlang/core` is published under a stable version.

**Trust.** The editor and the build `require` the named module when a `.mx`
file is opened or compiled, so name only packages you trust. Sidecars and
`mx.contracts` modules are the same class. The VS Code extension therefore
declares that it does not support untrusted workspaces.

A loaded host's name is a valid `mx.tags[].hosts` value for files compiled under
that target, and its `mx.tags` entries filter by it; no unknown-host warning
fires for it.

**The data target and its tooling limit (decisions 131 and 132, 131 addenda 1
and 2).** `data` is a **hostless** target: its descriptor has no `host` part, so
no `mx.host` value names it and it has no file kinds (§13.7). It is chosen only
per package, by `mx.target: "data"` (rule 1; a nested `package.json` covers a
subtree of a mixed repository) or by rule 5 when `@mxlang/data` is the single
target package in `dependencies`/`devDependencies`. There is no `x.data.mx` file
kind: a file kind's segment is a host's name (decision 136) and `data` has none.
A package that depends on both `@mxlang/data` and another built-in target
package has two matches under rule 5 and falls to `html`; it must set
`mx.target` to the target its tool-compiled files use, and its data files go
through `parseData`.

Editor dispatch for data files is deferred (TODO
`data-target-tooling-dispatch`): **the language server, the TypeScript plugin,
Vite and the Bun loader do not compile data files yet; `mx-tsc` does** (§13.7.4,
decision 131 addendum 4). Until editor dispatch lands, an explicit
`mx.target: "data"` is a positioned error raised by the registry wrapper, never
by core, at the key's value (code `unknown-target`):
`mx.target "data" is not wired into the editor and build tools yet (TODO data-target-tooling-dispatch); call parseData from @mxlang/data instead`.
The language server and the TypeScript plugin report it as a policy
error and the Vite plugin fails the transform with it. `mx-tsc` asks the wrapper
for the unmasked policy when it is run on a package whose own `package.json`
says `mx.target: "data"` (§13.7.4); in every other run (rule-5 inference, a
monorepo root, `-b`/`-w`) it still reports the error like the editor tools. The tools still hand on
the same fallback as any `unknown-target` (rule 5, else `html`), so later
diagnostics are not drowned, but the error means no green build. The Bun loader
does not read `mx.target` at all: `@mxlang/html/bun` always compiles as `html`.
Dependency-only `data` inference (rule 5) keeps its existing staging to `html`
with no diagnostic. `parseData` from `@mxlang/data` is the supported entry
point today and is independent of editor/build dispatch (§13.7).

**Edge cases of the walk.** The nearest `package.json` is the one that *exists*:
a malformed one (or one that is not a JSON object) ends the walk with the
default `html` policy and a warning naming it and the ancestor whose host the
file used to take; it does not fall through to an unrelated ancestor. A
directory with **no** `package.json` of its own belongs to the nearest
ancestor's project — including a monorepo root — so a workspace member that
should not inherit the root's host needs its own `package.json` (or `mx.host`).
The walk stops at a `node_modules` directory, so an installed package that
ships no `package.json` resolves to `html`, not to the consumer's host. An
`mx.host` that names no host is ignored with a warning listing the valid hosts
(and the nearest one, if close) and resolution continues with step 2.

**One resolver, shared** by the Vite plugin, the Bun loaders, the language server
and the TypeScript plugin — so an editor, a `tsc` run and a build cannot disagree
about a file's host.

`host: "astro"` always compiles under `strictPolicy` regardless of the field's
own `strict` value, because that host has no other mode.

### 13.6 Bugs found while writing this table

Each was reproduced against the host's real entry point on 2026-09-17. **None is
a spec question** — the spec says what should happen; these are places the code
does something else, silently.

| # | Host | Bug |
|---|---|---|
| 1 | Angular | **FIXED 2026-09-17** (task `angular-spec-gaps`). Was: no stateful-tag policy at all — the emitter declared only `try`. `<effect>`, `<lifecycle>`, `<script>`, `<log>`, `<debug>`, `client`/`server` all emitted **literal elements** (`<effect [value]="…">`); `<let>`/`<id>`/`<await>` failed only incidentally, via the generic field guard, so `<let x=1/>` with no `/var` also emitted a literal element. Now every one of these is its own positioned error (`STATEFUL_ERRORS`, `packages/hosts/angular/src/emitter.ts`), same wording family as `@mxlang/preact`'s `statefulErrors`. |
| 2 | html, Preact | **`<return>` is documented as a compile error and is not.** Both READMEs list it under "Errors"; the code reverses this under decision 95 and both hosts emit `{ value, output }`. |
| 3 | Astro `.astro.mx` | **FIXED 2026-09-28.** Every range `<for>` emitted invalid JavaScript: `Math.max(0, (` opened two parens and only one closed: `{Array.from({ length: Math.max(0, (3) - (0) + 1 }, …)}` — *"Unexpected token '}'. Expected ')' to end an argument list."* The test asserted only a substring (`toContain("(3) - (1) + 1")`), which passed regardless; now the tests assert the exact emitted code and that the real Astro compiler (`@astrojs/compiler-rs`) reports zero diagnostics for `from`/`to`, `until`, no-`from`, descending, and expression-bound ranges. |
| 4 | Solid | **FIXED 2026-09-27**, decision 106. Repeated attribute tags now emit real arrays. |
| 5 | html-strict | **FIXED 2026-09-28** (decision 111, task `strict-policy-log-debug`). Was: `<log>`/`<debug>` survived `strict` — `STRICT_TAGS` overrode six names but not these two, so they stayed inert under strict, and therefore under the Astro `.mx` host too, whose README claimed all stateful tags were build errors. Both are now `STRICT_TAGS` error rows, same as the other six. |
| 6 | Preact | README claims a non-object `style=` is an error; `<div style="color:red"/>` compiles. |
| 7 | Angular | **FIXED 2026-09-17**, decision 86; corrected by the colon-attribute parity follow-up. Was: silently lowered `class:active=c` to `[class.active]="c"`. Native `class:`/`style:` forms remain rejected with an object/array `class=`/`style=` replacement (§4). `attr:x`, like other non-reserved colon names, is an ordinary complete attribute name in Marko and is preserved; a dynamic value uses `[attr.attr:x]`, not `[attr.x]`. |
| 8 | Angular | **FIXED 2026-09-17** (page level; the tag-unit call site already errored). Was: `<return>` accepted and emitted nothing at the page level, silently dropping the value channel rather than erroring as `.astro.mx` does. |
| 9 | html | **FIXED 2026-09-26**, decision 104. Dynamic tags receive attribute-tag props. |

### 13.7 The data target

**Decisions 131 (with addenda 1 to 3) and 132.** `@mxlang/data` is MX's first
**hostless** target (§13.5): a `.mx` file under it is **data**, not UI. It
compiles with core's own pipeline (delegate-everything declarations plus a data
taglib) and returns a small, closed, serializable **static tree**. The tree
describes what is written, never what it evaluates to; the consumer decides what
any tag or expression means. A later *evaluated mode* (the file compiles to a
module exporting a value) is TODO `data-host-evaluated-mode` and is not part of
this section.

**Tooling status.** `mx-tsc` checks a data package (§13.7.4). The language
server, the TypeScript plugin, Vite and the Bun loader do **not** compile data
files yet (TODO `data-target-tooling-dispatch`); for them `mx.target: "data"` in
a project is the positioned error quoted in §13.5. **`parseData` is the
supported entry point for a program.** Nothing in this section depends on tool
dispatch.

#### 13.7.1 `parseData`

```ts
parseData(source: string, filename: string, options?: ParseDataOptions): ParseDataResult
parseDataFile(path: string, options?: ParseDataOptions): ParseDataResult
```

`parseData` never throws for a source problem: a Marko parse error, a rejected
construct or a failed contract is **one** error diagnostic and `tree` is
`undefined`. Parsing is fail-fast (Marko's parser and core's `fail` both stop at
the first error), so there is never a partial tree. An unrecognized internal
error that carries no position fields is rethrown; a `TranslateError` at 0:0
(core's "no position" sentinel) is not that, it is a file-level diagnostic
(below).

| Result field | Meaning |
|---|---|
| `tree` | the `DataDocument` (§13.7.2), or `undefined` when `diagnostics` holds an error |
| `diagnostics` | `{ severity, message, line, column, offset, file? }`. `line` is 1-based and `column` 0-based, as `TranslateError` and `MxWarning`. `offset` is the UTF-16 offset derived from them (`-1` when `file` names another file, whose text `parseData` does not have). An error or warning with no source position (core's 0:0, as for a bad `customTags` registration) is file-level: `line: 1`, `column: 0`, `offset: 0` (`-1` when `file` names another file). On success it holds this call's warnings only |

| Option | Values | Meaning |
|---|---|---|
| `customTags` | `Record<string, CustomTag>` | contract-only custom tags by call name (decisions 130 and 138): required attributes, attribute types, `children`, `parents`. `parseData` does **not** scan `tags/` or `package.json`; this map is the whole vocabulary it knows. An entry whose `transform` emits tags is not supported yet: `parseData` throws on its output, an internal error rather than a source diagnostic (TODO `data-transform-output-tree`) (see [Writing a dialect package](/custom-tags/dialect-package/) for producing it) |
| `structural` | `"pass"` (default), `"reject"` | `"pass"` keeps the structural constructs in the tree (§13.7.3). `"reject"` makes the first one, in document order, a positioned error: ``the data tree is static; this file's consumer does not evaluate `<if>` `` (the construct is named: text, `${}`, `<if>`, `<for>`, `<const>`, comments, `import`, `export`, `static`). For a consumer that wants tags and attributes only |
| `unknownTags` | `"allow"` (default), `"reject"` | `"allow"` is the open set of decision 131: a tag with no entry in `customTags` is accepted. `"reject"` (131 addendum 3) makes any authored tag, at any depth, whose name has no entry in `customTags` a positioned error at the tag: ``` `<opem>` is not a known tag: it has no contract in `customTags`; did you mean `<open>`? ``` (the hint appears when one declared name is clearly nearest). Reserved names never reach the check (core consumes them first) and `<@name>` attribute tags are governed by the parent's `attributeTags`, not by this option. |
| `warnings` | `MxWarning[]` | a sink for core's warnings, pushed as raised, so those raised before a later error stay in the caller's array |

**Error order under `unknownTags: "reject"`** (decision 131 addendum 3; the
unknown-tag check runs on a tag before anything inside it, so the first error is
the root cause). Exactly one error is reported:

1. A source that does not parse reports its Marko parse error.
2. An error core raises while compiling (a reserved name, `<define>`,
   `<return>`, a `customTags` contract error: attribute shape, closed
   `children`, `parents`, a tag variable on a contract tag) is reported, **unless**
   an unknown authored tag opens strictly earlier in the file, in which case the
   unknown tag is reported. An ancestor always opens earlier, so a typo'd parent
   (`resourse` holding an `<attributes>`) is reported with its `did you mean`
   hint, not the contract error of the child under it. A core error at or before
   the unknown tag's position wins, so a known parent's closed-`children` error
   positioned at the unknown child itself is the reported one.
3. When compiling succeeds, the tree is built. The `structural: "reject"` hit,
   the unknown-tag check and the build rejects (dynamic tag, `<!doctype>`, tag
   variable, merged shorthand class, unusable tag name) compete **by position in
   the file**: the earliest wins, wherever it sits in the tree, with attribute
   tags and children interleaved in document order. At the same position the
   build reject wins. An unknown tag's own body is never walked, so there is one
   error per unknown call.

#### 13.7.2 The tree

All types are in `@mxlang/data/tree`. Every span is core's `SourceSpan`
(`{ sourceStart, sourceEnd }`, UTF-16 code units from the file's start, so
`source.slice(span.sourceStart, span.sourceEnd)` is always the authored text).

- **`DataDocument`**: `{ kind: "document", filename, statements, children }`.
  `statements` holds the `import`/`export`/`static` statements (each
  `{ kind, code, span }`), sorted by `span`, because core splits them out of the
  body and loses their order relative to the body. `children` is a `DataNode[]`.
- **`DataNode`** is one of: `tag`, `text`, `expression`, `comment`, `if`,
  `for`, `const`. Each carries a `span`.
- **`DataTag`** (`kind: "tag"`): `name`, `nameSpan`, `span` (the whole tag, body
  and closing tag included), `attrs`, `args` (`<x(1, 2)>`), `params` (`<x|a, b|>`,
  as source text), `attrTags` and `children`.
- **`DataAttrTag`** (`kind: "attr-tag"`): a `<@y>`; the same fields except
  `args`, with `name` without the `@`. `attrTags` is the tree form of a tag's attribute tags, with
  `<if>`/`<for>` among them kept (those nodes carry no `span`, unlike the body
  nodes); they are **not** in `children`, and their
  interleaving with ordinary children is not kept. Every other node written
  beside an attribute tag (text, tags, comments) is in `children`, in source
  order, exactly as it is without attribute tags. A comment written right
  before an `@tag` is one of them: Marko's parser moves it into the tag's
  attribute list, and core puts it back among the children.
- **`DataAttr`**, by `kind`:

  | `kind` | Source | Fields |
  |---|---|---|
  | `string` | `type="string"`, `<x="post">`, shorthand `#id`, `.cls` | `name`, `value`, `valueSpan`, `nameSpan` (absent for shorthand) |
  | `boolean` | `required` | `name`, `nameSpan` |
  | `expression` | `n=1`, `values=[…]`, `change=(x) => …`, `v:=x`, `onClick=fn` | `name`, `value: DataExpr`, `nameSpan`, `bound?: true` |
  | `spread` | `...rest` | `value: DataExpr` |

  Only a string literal is `string`; `n=1` and `required=true` are `expression`
  (the tree does not evaluate). A default attribute (`<resource="post">`) is a
  `string` attribute named `value` whose `nameSpan` is zero-width at the `=`.
  Attributes keep authored order, then the shorthand-synthesized `class` and
  `id`. Duplicates follow decision 135: the last occurrence is kept and the
  dropped one is a warning (`duplicate attribute \`b\`: the later one at 1:8 wins, so this one is dropped`).
  Event attributes stay plain expression attributes (`onClick`).
- **`DataExpr`**: `{ code, shape, span, node }`. `shape` is `"object"`,
  `"array"`, `"string"` or `"other"`. `node` is Marko's own Babel node (offsets at
  `node.loc.{start,end}.index`). **`code` is the printed form, not the authored
  text**: a method shorthand `value({ post }) { … }` has `code` `function ({ post }) { … }`. Slice `span` for what the author wrote.

**Serialized form.** `SerializedDataDocument` is `DataDocument` with every `node`
removed (`code`, `shape` and every `span` stay), so it is plain data. The data
target's `compileModule` emits it as `export default <literal> as const`, a
module that imports nothing; it takes `customTags` from its options and uses the
defaults for `structural` and `unknownTags`. A consumer that needs the Babel
nodes calls `parseData`.

#### 13.7.3 What each construct means in data

| Construct | In the tree | Notes |
|---|---|---|
| Tags, attributes, attribute tags | `tag`, `attrs`, `attrTags` | every name core does not own is a data tag (it is *delegated*, decision 132): no `unknown tag` error by default (`unknownTags: "allow"`) |
| Text | `text`: `value`, `span` | `value` is Marko-normalized; `span` slices the text as authored, so they differ on collapsed whitespace. A same-line one-space body (`<a> </a>`) is text; a newline-plus-indent run is not (decision 141) |
| `${x}`, `$!{x}` | `expression`: `value`, `escaped`, `span` | `span` covers the delimiters, `value.span` the expression |
| `<if>`, `<else-if>`, `<else>` | `if`: `branches[]` of `{ test \| null, children, span }` | `test: null` is `<else>` |
| `<for>` | `for`: `head`, `children` | `head.source` is `of`, `in` or `range`; plus `params`, `paramSpans`, `key` |
| `<const/n=expr>` | `const`: `name`, `init` | |
| Comments | `comment`: `value`, `html` | `html` is true for `<!-- -->`, false for `//` |
| `import`, `export`, `static` | `statements` | statement text, never resolved or evaluated |
| Tag params, args | `params` (text), `args` | |
| `<define>` and calls to it | **error**: ``` `<define>` is a render-time macro: the data tree is static and cannot expand it; inline the content at each use ``` | a macro cannot be expanded by a static tree |
| `<return>` | **error**: ``` `<return>` needs the evaluated mode: the data tree is static and has no value to return ``` | |
| Tag variable `/v` | **error**: ``tag variable `/v` on `<a>`: the data tree is static; a binding without evaluation means nothing`` | |
| Dynamic tag `<${x}>` | **error**: ``a dynamic tag (`<${expr}>`) has no name; the data tree is static and needs one`` | |
| Call of an imported component (`<Foo/>` with `import Foo`) | **error**: ``` `<Foo>` calls a template tag; a data file cannot call a template tag ``` | `parseData` does not scan, so a lowercase tag is a data tag even when a `tags/` file of that name exists. If `customTags` holds an entry **with a template** (a map from `getCustomTags` does for a `tags/` file), the call is the same error |
| `<!doctype>` | **error**: ``` `<!doctype>` means nothing in a data file; the data tree describes tags and data, not a page ``` | |
| `<![CDATA[…]]>`, `<?xml …?>` | **error**, from core on every target (decision 139) | |
| Attribute methods `change(ctx) { … }` | accepted, as an `expression` attribute | the Ash-style fixture uses `value({ post }) { … }` |
| Attribute modifiers `class:active=c` | **error** (core, standalone template) | |

A tag or attribute-tag **name** is not restricted to an identifier:
namespaced (`svg:rect`) and non-ASCII names pass through. The only refused
names are ones that are not names: a leading `$` or `!`, or a `{`, `}` or
whitespace (a `$!{x}` line or a `$const x = 1` scriptlet that Marko parses as a
tag; MX has no scriptlets, decision 54). A shorthand `class` together with an
authored `class` on one tag (`<x.a class="b"/>`) is one positioned error, because
core merges them into a class with no source span.

**Reserved names.** No data tag may be named `if`, `else`, `else-if`, `for`,
`const`, `define`, `return`, `import`, `export`, `static` or **`try`**: core
consumes these before a target sees a tag (`try` is core-owned, `else` and
`else-if` are consumed by the `<if>` walk). `if`, `for`, `const`, `import`,
`export` and `static` always parse as the structural construct. `else`,
`else-if` and `try` outside such a construct fail with ``` `<try>` cannot name a data tag: it is reserved — core consumes the structural names (…) and `<try>` before a target sees them ```. The host-owned names (`let`, `id`, `log`, `debug`, `effect`, `class`, `await`, …)
are ordinary data tag names.

**Marko's HTML parse rules are off.** Marko gives 19 tag names an HTML parse rule
(void `openTagOnly`: `area base br col embed hr img input link meta param source track wbr`; raw `text` bodies: `script style textarea title`;
`preserveWhitespace`: `pre script style textarea`). The data taglib sets each of
those three options to `false` on every name Marko's own lookup reports, so a data
tag named `source`, `input`, `title`, `script` or `pre` parses like any other tag
and may have child tags. The list is derived from Marko's lookup, not
hand-written, and a test pins the 19 names. The cost: a tag-like `<name` inside
a `script`, `style`, `textarea` or `title` body parses as a tag, not text; a data
file writes text through `${"…"}` or an attribute. This is the one place a data
file is not a Marko file: Marko rejects `<source><input/></source>`, data
accepts it.

#### 13.7.4 `mx-tsc` on a data package

**Decision 131, addendum 4.** `mx-tsc` run on a project directory whose own
`package.json` says `mx.target: "data"` does not build a TypeScript program.
Rule-5 inference from an `@mxlang/data` dependency does **not** switch it: such
a package, a monorepo root, and a directory with no manifest of its own keep
their ordinary `tsc` run and the staged error for their data files, so a
TypeScript error is never swallowed by an inference. With no tsconfig it parses
every `.mx` file under the directory that the policy assigns to `data`, in
full-path order (skipping `node_modules` and dot directories; a nested package
that resolves to another target is not walked), with `parseData` and the
package's own tag map (`getCustomTags(file, { host: null })`: `tags/` sidecars
and `mx.contracts`). The command is `mx-tsc` in the package directory, or
`mx-tsc -p <dir>`; `-p` also accepts a tsconfig path (only its directory is
used), and `--pretty` and `--noEmit` are accepted and ignored. Any other
argument (`-b`, `-w`, `--version`, a file list) is an ordinary `tsc` run.

Each diagnostic prints as `file(line,column): error TS80001: message` (a
warning is `TS80002`): the compile diagnostic a host `.mx` file gets, so one
search finds every `.mx` problem. Positions are 1-based, converted from the
diagnostic's 1-based `line` and 0-based `column`. A problem in the
configuring `package.json` is `TS80003` at its position: the resolution's own
policy diagnostics (a mismatch, an unknown target or host) with their own
severity, a scan warning, an invalid `mx.data` value (checked even when there
is no `.mx` file). A discovery failure (a missing or invalid `mx.contracts`
module) is an error at the position it carries, and independent packages are
still checked; it is never an empty tag map with a green result. A broken or
looping `.mx` link and an unreadable directory are `TS80001` errors naming the
path. The exit code is 1 when any diagnostic is an error
and 0 otherwise; a clean package prints nothing.

`package.json#mx.data` is `{ "structural"?: "pass" | "reject", "unknownTags"?:
"allow" | "reject" }`. Both default to `"reject"` here; `parseData`'s own
defaults stay `"pass"` and `"allow"`, and only `mx-tsc` reads the key. An
invalid value is an error at the value and the strict default applies. The
language server, the TypeScript plugin and Vite keep the staged error of §13.5
until `data-target-tooling-dispatch` lands.

### Host selection

See §13.5 for `mx.host`, `mx.target`, their agreement rule and positioned errors
(decisions 129/132 and decision 131 addendum).

**Edge cases of the walk.** The nearest `package.json` is the one that *exists*:
a malformed one (or one that is not a JSON object) ends the walk with the
default `html` policy and a warning naming it and the ancestor whose host the
file used to take; it does not fall through to an unrelated ancestor. A
directory with **no** `package.json` of its own belongs to the nearest
ancestor's project — including a monorepo root — so a workspace member that
should not inherit the root's host needs its own `package.json` (or `mx.host`).
The walk stops at a `node_modules` directory, so an installed package that
ships no `package.json` resolves to `html`, not to the consumer's host. An
`mx.host` that names no host is ignored with a warning listing the valid hosts
(and the nearest one, if close).

**One resolver, shared** by the Vite plugin, the Bun loaders, the language server
and the TypeScript plugin — so an editor, a `tsc` run and a build cannot disagree
about a file's host.

`host: "astro"` always compiles under `strictPolicy` regardless of the field's
own `strict` value, because that host has no other mode.

---

## 14. What MX 2 reserves

| Item | Reserved for | Decision |
|---|---|---|
| **Deliberate divergence from Marko** | Any divergence at all; each needs a row in `divergences.md` (what, why, test), and a syntax divergence lands only with the tooling it breaks | 72 |
| `resolve` | A Vite-style hook name; the current hook is `transform` | 87c |
| `migrate` | A source-printing mode | 87b |
| `mode: "inline"` | The inline-vs-component hybrid for custom tags | 94d |
| `tag-var-in-callback-scope` | Per-scope `/var` binding inside `<for>`/`<if>`/attribute-tag/content scopes | 97f, 98 |
| `lowercase-local-component-diagnostic` | Marko's PascalCase rule as one positioned core error on every host | 94c |
| Tag params on `<if>` | `<if\|u\|=cond>` — Marko rejects it | `divergences.md` |
| Tag params on native elements | `<div\|x\|>` — Marko rejects it | `divergences.md` |
| Attribute tags on native elements | Marko rejects them | `divergences.md` |
| `<fragment>` | Marko rejects it; multiple root nodes need no wrapper | `divergences.md` |
| Unknown custom elements | Letting `<my-widget>` through as a literal element | `divergences.md` |
| L3 raw hooks | Blocked on a vendored fork registering `Mx*` node types | 89c |
| A non-JS parser | — | 74 |
| An async `<try>`/`<await>` | "a later product" | 65 |
| Scriptlets | Revisit when the reactive mode is built or killed | 54 |

**MX 2 stays TypeScript** (decision 88). `whole-file-mx` is **closed**, not
deferred (decision 85).

---

## 15. Open questions

1. **Event attribute naming** (§4). No rule today; behavior differs per host by
   accident. Blocked on `notes/investigations/dom-events.md`.
2. **Dynamic tags** (§7). No decision fixes their behavior; hosts may claim them.
   The attribute-tag-on-a-dynamic-tag silent drop on the html target (and on
   Solid's own dynamic-tag path, which shares the bug) is fixed: both now
   forward the attribute tags into the resolved target's props (decision
   104, `attribute-tag-silent-drops`).
3. **`--` text lines** (§3). Legal by inheritance, untested — no fixture.
4. **`.solid.mx` as a final spelling** (§1). Left "for now" three times, never
   ruled on.
5. **File-local component bindings** (§7). `<const/Panel=…/>` and tag params do
   not participate in the precedence check; only `import` and `<define>` do.
6. **`style=` shorthand.** Only `class`/`#id` shorthand is decided.
7. **Decisions pending Saulo's veto**, recorded in decision 93: decisions 90–92
   and the custom-tags spec's substitution design. Decision 94d is explicitly
   awaiting his ruling; decision 92 is marked "Saulo may veto"; decision 65's
   policy statement is marked "lead's assumption, Saulo to confirm".

### Closed questions

8. **Attribute-tag cardinality and value shape — closed by decisions 106–108.**
   `Input` declares singular versus array and data versus renderable. Untyped,
   unresolved, and dynamic callees use decision 108's body-only renderable
   fallback; attributed or nested occurrences use data. Conditional and looped
   attribute tags and recursive nested tags are part of MX 1.
9. **Arguments plus content on dynamic and `<define>` calls — closed by
   decision 109.** A dynamic `<${expr}>` tag or a `<define>` call now accepts
   the tag-argument form combined with a body or attribute tags, matching
   Marko's own lenient `assertAttributesOrArgs` (which rejects only arguments
   plus a plain attribute); Marko's strict `assertAttributesOrSingleArg`
   remains named-custom-tag-only and untouched. html and preact/react/hono
   emit the trailing content/attribute-tag props alongside a dynamic tag's
   or a `<define>` call's arguments; Solid's dynamic-tag design already kept
   attrs/attribute-tags/content orthogonal from arguments (args only resolve
   the value handed to `<Dynamic component=…>`), so it needed no emitter
   change for the dynamic case. At the time this decision closed, a
   `<define>` call could not be authored inside a `.solid.mx` region at all
   (`<define>` unconditionally errored there), so a `<define>`-bound call
   target was unreachable on Solid and out of this decision's scope —
   **superseded by decision 110b below**, which makes `<define>` itself work
   in a region and gives Solid its own named-param call shape (a plain
   function call, not JSX — §5.4). Angular and
   Astro keep a positioned error naming their own constraint
   (`ngComponentOutlet`/no local component form), not MX's.
   **A `<define>` call does not emit Marko's own trailing-object shape.**
   Marko's own codegen for `renderer(...args, propsObject)` works because a
   named custom tag's callee has a declared `Input` to destructure that
   object against; a `<define>` has none — its params are ordinary
   positional identifiers. Measured against real Marko 6.3.51: its own
   codegen for `<Card('a')><@head>H</@head></Card>` against
   `<define/Card|title, head|>` binds the *whole* trailing props object to
   whichever param follows the args (`head` here), not the attribute tag's
   value, silently dropping the content (`<div>a</div>`, or
   `<div>[object Object]</div>` with no args at all) — Marko itself gets
   this shape wrong for a construct with no `Input` to destructure against.
   MX's `<define>` emitters (html, the shared preact/react/hono emitter)
   instead extend their own pre-existing positional named-lookup scheme
   (already used for the no-args call shape, where `<Row it=x/>` looks up
   `it` by param name): params beyond the consumed positional args are
   filled from that same named lookup — attributes, attribute-tag exports,
   and a bare body under the reserved `content` key — one value per
   remaining param, rather than one trailing object.
10. **`<define>` is supported in `.solid.mx` regions — closed by decision
   110b.** Previously a compile error ("cannot declare a function inside a
   JSX expression"). A top-level `<define>` in a region hoists to a
   gensym'd module-scope function, the same way a discovered tag's import
   already does (see §5.4). After hoisting, item 9's `<define>` call shapes
   apply on Solid too, through a plain function-call expression rather than
   a JSX tag (JSX has no positional-call syntax). A `<define>` nested inside
   `<if>`/`<for>`/another construct, or one that closes over a value local
   to the region (not its own params, another top-level `<define>`, or a
   module import), is a positioned error rather than silently wrong code —
   real module scope has no closure over the region's enclosing function or
   a nested callback's own scope.
11. **A string-target dynamic tag called with arguments uses `args[0]` as
   its input — closed by decision 112.** Previously html's `renderDynamic`
   and the shared preact/react/hono `mxDynamic` helper ignored `args`
   entirely for a string target, rendering the call's own (empty, per
   `rejectArgsWithProps`) attributes or its attribute-tag props instead.
   Measured against real Marko 6.3.51 (`runtime-tags/src/html/
   dynamic-tag.ts`'s `_dynamic_tag`, `typeof renderer === "string"` branch,
   and the identical dom `_dynamic_tag` in `dom/control-flow.ts`): `const
   input = (inputIsArgs ? args[0] : ...) || {}` — `args[0]`, not the call
   site's attributes, becomes the element's input; extra arguments
   (`args[1]` onward) are ignored; a null/undefined `args[0]` is treated as
   `{}`. A non-object truthy `args[0]` (e.g. a string) is spread as-is,
   matching Marko's own `_attrs`'s `for (const name in data)` over a
   non-object value (yields its numeric indices) — not special-cased.
   **Decision 109's trailing props object does not combine with `args[0]`
   here.** Marko's translator appends that object *after* every positional
   argument (`renderer(...args, { content, <attribute tags> })`), so for a
   string target it lands at `args[N]`, N > 0 — never `args[0]` — and is
   therefore not read as input. Content still renders regardless: Marko
   threads it as `_dynamic_tag`'s own separate `content` parameter,
   independent of `input`, filled at the call site whether or not the
   trailing object also happens to carry a `content:` key. html and the
   shared JSX emitter (preact/react/hono) both keep this exact split —
   `renderDynamic` already receives content through its own `props`
   parameter regardless of `args`; the JSX `mxDynamic` helper gained a
   third `content` argument for the same reason, so the runtime dispatcher
   never has to guess whether a trailing array element is a genuine
   argument or the synthesized props object.
   **Decisions 109 and 112 are disjoint, not in conflict (lead ruling,
   2026-09-28): 109 governs a function/component target called with
   arguments; 112 governs only a string (native-element) target.** Solid's
   `#dynamicComponent` applies both: for a function/component target,
   attrs/attribute-tags/content stay orthogonal from args exactly as
   decision 109 left them (unchanged, still tested); for a *string* target
   called with arguments, `args[0]` becomes the element's attributes
   *instead of* the call's attribute-tag props, matching html/preact/
   react/hono — content still renders regardless, threaded independently.
   Which rule applies is a run-time fact (the resolved target's type), so
   the emitter produces two `<Dynamic>` branches behind its existing
   `typeof` guard rather than one conditional attribute list.

## 16. Docs to fix

Fixed 2026-09-28 (docs-drift-2026-09-17): the `<return>`-on-html claim, the
"future SolidMX or React host" line, the Solid `<if>`-lowering description,
the html tag-params-on-component-call claim, the `define-const-static-import.md`
`.mx` import example, the `input`-shadowing strict-only omission on
`errors.md`, this section's own §13.2 dynamic-tag row (Solid/Preact/React/Hono
render dynamic tags via `<Dynamic>`/`mxDynamic`, not error), and every stale
README line below. `packages/hosts/preact/README.md`'s non-object-`style=`
claim was measured **still correct** (it errors) — this section's prior claim
that it compiles was itself wrong.

Closed 2026-09-28: `<return>`, `/var`, custom-tag units, discovery, and
sidecars are **already documented**, at `/custom-tags/templates/#returning-a-value`
(`<return>`/`/var`, including the per-host `/var`-scoping table and the
JSX-hooks restriction), `/custom-tags/index/` and `/custom-tags/templates/`
(the "compilation unit" model), `/custom-tags/discovery/`, and
`/custom-tags/sidecars/` — none needed writing. The actual gap was that
`language/stateful-tags.md`'s `<return>` row didn't link to it; fixed. The
custom-tags build spec is also on the site at `/design-notes/custom-tags/`.

---

## 17. Sources

- `notes/decisions-2026-09-10.md` — decisions 1–99
- `worktrees/main/divergences.md` — the subset rule, deferred-to-MX-2 table
- `worktrees/main/AGENTS.md` — per-package and per-host contracts
- [`/design-notes/custom-tags/`](https://mxlang.dev/design-notes/custom-tags/) — the custom-tags feature spec
- `notes/solidmx-spec.md` — SolidMX (note §5.1's `<if=cond|u|>` is wrong; see §5.2)
- `packages/core/src/{lower,core,custom-tags,builtin-tags,template-tag,scan,ir}.ts`
- `packages/hosts/*/README.md` and their emitters
- `apps/docs/docs/language/*.md` — six user-facing pages
- htmljs-parser `src/states/CONCISE_HTML_CONTENT.ts` — concise-mode line rules
