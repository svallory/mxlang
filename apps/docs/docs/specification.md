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
| `.amx` | An Astro component whose template is MX | An `.astro` module | Shipped |
| `.ng.mx` | An Angular region file | `.ts` with an inline `template` | **Not built** (decisions 96, 99) |

### Whole files vs region files

A **whole file** (`.mx`, `.amx`) is parsed by `@marko/compiler` from the first
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
`mx-tsc`, the editor extensions — accepts `.mx`, `.solid.mx` and `.amx` only,
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

### Why `.amx` is single-dot

`.astro.mx` was the first spelling (decision 76c) and works for components, but
Astro's route collection keys on `path.extname(basename)` — the **last**
extension segment only. Measured against astro@7.3.2: a `page.astro.mx` under
`src/pages` is skipped as an unsupported file type, and once `.mx` is also
registered it routes to `/page.astro/`, with a literal `.astro` in the URL.
Decision 78 settled on `.amx`. `.solid.mx` keeps two dots because nothing
routes on it.

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

### Errors

Core-owned:

| Message | When |
|---|---|
| `unrecognized statement tag \`${name}\`; expected \`import\`, \`static\`, or \`export\`` | A statement tag reached the statement lowerer under another name. A guard, unreachable through the normal tag switch. |

### `server` and `client` blocks

A `server` block is **not** inert on the HTML host — that host *is* the server
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
a mixed body; the Angular host emits `[innerHTML]` with a warning.

Core raises no dedicated interpolation diagnostic — a `MarkoPlaceholder` lowers
unconditionally with `escaped` taken from the node, so `$!{}` is simply
`escaped: false`.

### Whitespace

**MX follows Marko's rule, not JSX's, and does not implement it.** Marko's own
`onText` has already applied it before `@mxlang/core` sees a text node. There is
no `normalizeText` in core, and **a second normalization pass on any host's path
would collapse whitespace twice** — this is the same single rule on every host,
SolidMX included.

The rule, line-based (decision 33, superseding decision 12's run-based
statement):

1. Split a text run into lines and trim each line.
2. Drop lines that are then empty.
3. Join what remains with a single space.
4. Collapse remaining internal whitespace runs to one space.

Consequences, each measured:

- A whitespace-only run **containing a newline** is dropped entirely — so
  ordinary indentation between tags contributes nothing.
- A whitespace-only run **without** a newline collapses to one space.
- `"\n  static\n  "` before `<span>` is `"static"` with **no** trailing space.
- `"a\n  b"` is `"a b"`.
- `${" "}` is the escape hatch for a literal space the newline rule would drop.
- **Comments are not content** and do not count when trimming.

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
(`packages/hosts/html/fixtures-marko/error-dynamic-tag-name/`) proves it: a
bare `${tagName}` at column 0 fails at render with "Invalid tag name" — it
compiled to a dynamic tag, not a placeholder.

Both shapes now lower alike (`lowerTag`, decision — a `HostTag` for a host
claiming `DYNAMIC_TAG` with `shape` `"bare"`/`"tagged"`, or, unclaimed, a
`Component` with a dynamic target):

- A host that claims `DYNAMIC_TAG` gets the identical `HostTag` for either
  shape (`claimsTag(name, ctx, shape)` can inspect `shape` to opt a *new* host
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

**Decisions:** 12 (superseded), 33 (both entries), 45, 54, 14, 96.

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
| Method | `onClick() { … }` | Event handler — host-defined, see below |

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

**Not Marko syntax at all** — not "something MX cannot express" (decision 67b,
measured against 5.42.5). Marko's parser rejects every form with its own fix-it:

> `class:active` is not a valid attribute, did you mean `class={ active: condition }`?

So there is no MX behavior to document and no fixture to write: no `.mx` file
using them compiles. Where a host is reached anyway, core raises:

| Message | When |
|---|---|
| `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in a standalone template` | A modifier survived to the lowerer and the host's `resolveModifier` declined it. |

`prop:` is the one namespace that passes through on the Solid host. `on:`,
`oncapture:`, `attr:`, `bool:` and `use:` are parse errors there with fix-it
hints (decision 10) — Solid 2 removed them, and MX does not keep syntax with no
target. Decision 10 records itself as "the most reversible call".

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

**`on:*` and `oncapture:*` are not given meaning by core.** They reach the host
as the attribute `on`/`oncapture` plus a modifier, through the same hook as any
other `name:modifier`, and each host maps or rejects them in its own vocabulary
(Solid 2, React and Angular reject with a fix-it naming `on-<exact>`; a Solid 1
or Svelte 4 host could map them). Core neither rewrites them nor warns.

#### Gotcha: the handler signature and `onChange` are the host's, not MX's

Host differences here are **documented, not shimmed**:

- The handler's parameters are whatever the host runtime passes — the DOM event
  on every current host. (Marko's own runtime would pass `(event, target)`.)
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
some types reinterpret a later `value`. The HTML host reproduces this, and the
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
host for its `try` primitive via `ctx.build.hostTag("try", …)`.

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
gate every other custom tag gets: it is a structural pass-through wrapper and
must reproduce the caller's body unchanged, so `<try>  </try>` keeps its
whitespace-only body.

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
the HTML host (it needs a second render pass), while `<try>` with only `<@catch>`
lowers to an ordinary `try`/`catch`.

**Decisions:** 8, 28, 51, 65, 85, 91, 93.

---

## 7. Components and dynamic tags

### Resolution precedence

The **normative** order, as shipped (decision 93):

1. Host tag disposition (`declarations.tags[name]` — error or inert)
2. Core structural tags: `import`, `static`, `export`, `for`, `const`,
   `define`, `return`, `else`, `else-if` — **never shadowable**
3. `@`-prefixed names → attribute-tag error
4. **Built-in custom tags (`try`)** — wins unconditionally
5. **A file-local binding** (`<define>` or `import`), **gated on PascalCase**
6. A registered custom tag
7. A host claim (`claimsTag`)
8. `declarations.isComponent`
9. PascalCase with nothing matching → error; else an element if
   `isElement` accepts it; else error

**The PascalCase gate at step 5 is load-bearing.** Marko's own rule is that a
*lowercase* local variable is never resolved as a component:
`import panel from "./panel.mx"` then `<panel/>` is a Marko parse error, not a
component reference. An earlier fix checked local bindings with no casing gate
and regressed every lowercase custom tag or host claim (e.g. `<style>`) that
shared a name with an unrelated lowercase import in the same file.

**Known gap, pre-existing:** only `import` and `<define>` populate the
file-local sets. A component name bound by `<const/Panel=…/>`, or as a `<for>`
tag param, is **not** in either set and still loses to a registered custom tag of
the same name — measured. Extending the check to those binders is unscoped
follow-up.

The HTML host's rule is stated by case only in the sense above: a tag matching an
import, a `<define>`, or a taglib/`tags/` discovery is a component call; anything
else is an HTML element whatever its case, hyphenated custom elements included.
SolidMX keeps JSX's PascalCase-means-component convention, on a separate lowering
path.

| Message | When |
|---|---|
| `` `<${name}>` has no matching import or `<define>` in scope; a capitalized tag is always a component call `` | PascalCase, nothing matched. |
| `unknown tag \`<${name}>\`: not an HTML element, and no matching import or \`<define>\` is in scope` | Lowercase, and the host's `isElement` rejected it. |

An unresolved **hyphenated** tag refuses to compile, matching Marko
(`Unable to find entry point for custom tag <my-widget>`, measured against
5.42.5). `divergences.md` lists letting it through as a literal custom element
as an MX 2 candidate.

### Dynamic tags

`<${expr}>` — with or without attributes or a body — is a dynamic tag, and so
is a **bare** `${expr}` line (**corrected 2026-09-17, core PR #103** —
see §3): both parse to the identical node, and Marko itself treats them
alike. At the *lowering* stage (`lowerTag`), a host that claims `DYNAMIC_TAG`
gets a `HostTag` for either shape; a host that does not claim it gets a
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

> **Bug, measured 2026-09-17 — an attribute tag on a dynamic tag is silently
> dropped.** On the HTML host (which claims `DYNAMIC_TAG`),
> `<${T}><@head>x</@head>y</${T}>` compiles clean and emits
> `renderDynamic(T, { content: … })` — **no `head` prop, and no diagnostic**.
> The identical call on a named component emits the `head` prop correctly.
> This is the S8 silent-drop class the project otherwise refuses. The docs
> claim the combination "is reported as such"; it is not reported at all.
> Either the attribute tags reach `renderDynamic`, or the combination is a
> positioned error — silence is the one option the capability test (§11)
> forbids. Filed in §13.6.

**Decisions:** 47/S11 (superseded by 65, swept by 68), 51, 79, 93, 94c.

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

An attribute-tag **value is "renderable"** in MX's contract, read as
`<${input.head}/>`; each host materializes it (decision 95(1)).

Attribute-tag names are stored with the leading `@` stripped, and their name span
starts one character in so the `@` is excluded from diagnostics.

### Collisions and placement

| Message | When |
|---|---|
| `attribute tag \`@${name}\` collides with attribute \`${name}\`` | Name equals a non-spread attribute on the same parent. |
| `attribute tag \`@children\` collides with the parent's ordinary children` | `<@children>` beside any ordinary child. |
| `attribute tags take params or a body, not attributes (v1)` | The attribute tag carries attributes. |
| `attribute tag \`<${innerName}>\` inside attribute tag \`<@${name}>\`` | Nested attribute tags. |
| `attribute tag \`<${name}>\` is only valid directly inside a component call` | An `@`-named tag reached the general tag path. |
| `attribute tag \`@${tagName}\` on ${what}; attribute tags are props of components, so they are only valid directly inside a component call` | Attribute tags on `<if>`, `<for>`, an element, etc. |

A **spread** attribute is not a collision — the check knows only explicitly
written names, not what a spread holds at runtime, matching JSX's
`{...props} id="x"`.

`children` counts as a name, because ordinary children lower into that prop.

### Deferred to MX 2

Both rejected by Marko, so both out of MX 1 (`divergences.md`):

| Construct | Marko's verdict |
|---|---|
| Tag params on native elements (`<div\|x\|>`) | `Tag does not support parameters.` |
| Attribute tags on native elements (`<div><@head>…</@head></div>`) | `Tag does not support nested attribute tags.` |

Also deferred: **conditional attribute tags** (decision 95(7)).

### Declaration keys

For a custom tag's declared attribute tags, the keys are MX's own names with **no
Marko parity and no legacy aliases** (decision 94a): `literalOnly` (not
`staticOnly`) and `repeatable` (not `repeated`). Unknown keys are rejected at
registration (§13.1).

**Decisions:** 19, 28, 37, 51, 66, 70, 79, 94a, 95(1), 95(7), 96.

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
entries come last, in array order. An explicitly passed `customTags` still beats
a discovered tag of the same name.

The config key is **`mx`**, not `mxlang` — a hard rename with no legacy path
(decision 89a).

**The scan is synchronous, and that is load-bearing.** Bun's `onLoad`, Volar's
`createVirtualCode`, the language server's diagnose path and `mx-tsc` all call
from positions that cannot await. One synchronous implementation is what keeps
an editor, a `tsc` run and a build from resolving different tags for one file.

**A tag's name is its filename, case included**: `tags/Icon.tag.ts` is `<Icon>`.
Names must match `/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/`; dotfiles are skipped.

| Message | When |
|---|---|
| `tag templates are \`.mx\`; \`.solid.mx\` is not supported as a tag` | A `.solid.mx` in a tags directory. |
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

A sidecar may declare `parseOptions`, `attributes`, `attributeTags`, `analyze`,
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
| `` `<${call.name}>` is this file's own tag, and a `.solid.mx` region has no module scope to declare it in; call it from a file that compiles to a module, or move the markup into its own tag file `` | A self-call from a region file, which exports nothing. |

### 9.7 Registration errors

| Message | When |
|---|---|
| `` `<${name}>` is a core-owned custom tag and cannot be shadowed by a registered custom tag of the same name `` | A registered map contains `try`. |
| `` `<${name}>`: a custom tag that defines only `finalize` has no call site and nothing to collect; add a `transform`, an `analyze` or a template file `` | `finalize` alone. |
| `` Unknown key "${key}" in the "${attrName}" attribute declaration of tag "${tagName}"; allowed: type, required, enum, default, literalOnly `` | Unknown attribute-declaration key. |
| `` Unknown key "${key}" in the "${tagAttrName}" attribute tag declaration of tag "${tagName}"; allowed: repeatable, required `` | Unknown attribute-tag-declaration key. |

### 9.8 Call-site validation

All carry the `` `<tag>`:  `` prefix:

| Suffix | When |
|---|---|
| `does not accept content` | `openTagOnly` and a body. |
| `accepts no attributes` | Any attribute on a tag declaring `attributes: {}`. |
| `spread attributes cannot be checked against this tag's declared attributes` | A spread on a tag declaring attributes. |
| `unknown attribute \`${attr.name}\`` | Not declared. |
| `attribute \`${attr.name}\` must be a literal` | `literalOnly` violated. |
| `attribute \`${attr.name}\` must be ${type}, got ${literal.type}` | Declared type disagrees. |
| `attribute \`${attr.name}\` must be an expression` | `type: "expression"` but static or boolean. |
| `attribute \`${attr.name}\` must be a static value from ${…}` | `enum` declared, value not a literal. |
| `attribute \`${attr.name}\` must be a string from ${…}, got ${literal.type}` | `enum` on a non-string. |
| `attribute \`${attr.name}\` must be one of ${…}, got ${…}` | Not in the enum. |
| `missing required attribute \`${name}\`` | Required attribute absent. |
| `unknown attribute tag \`<@${tag.name}>\`` | Not declared. |
| `attribute tag \`<@${tag.name}>\` may not be repeated` | Second occurrence without `repeatable`. |
| `missing required attribute tag \`<@${name}>\`` | Required attribute tag absent. |

Transform-time:

| Message | When |
|---|---|
| `custom tag has neither a \`transform\` nor a template file, so a call has nothing to expand to` | Neither present. |
| `` `<${call.name}>`: custom tag threw: ${message} `` | A `transform` threw a non-`TranslateError`. |
| `custom tag transform must return an array of IR nodes or a TagCall for its template` | Bad return value. |
| *(warning)* `` `<${call.name}>`: custom tag transform did not read its attributeTags; authored attribute tags were dropped `` | A macro `transform` never touched `call.attributeTags` while the call had some. Detected with a `Proxy`. |

**Decisions:** 80, 85, 87, 89, 90, 91, 93, 94a, 94d, 95, 97, 98.

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
block. **Angular** and **`.amx`** reject `/var` entirely.

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

1. `claimsTag`/`resolveHostTag` — the lower-time tag handler.
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

### Consumer obligations

- The **language server** publishes a foreign-file diagnostic against the
  template's own URI at its real position, and leaves a pointer at the head of
  the open document — LSP cannot publish against a file it was not asked about,
  and the template is not itself open. It clears the template's diagnostics when
  the caller stops reporting them.
- The **TypeScript plugin** *drops* a foreign-file span: a Volar `CodeMapping`
  addresses one source, and a plausible-but-wrong column is worse than none.
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

## 13. Host semantics table

*This section is written from the host-survey pass and is the one place where
"host-defined" resolves to a concrete answer per host.*

Every cell below was verified by **compiling a probe through the host's real
entry point**, not read from its README. Where a README disagrees, the README is
listed in §16.

Hosts: **html** (default policy), **html-strict** (which is also how
**Astro `.mx`** compiles), **Solid**, **Preact/React/Hono** (one shared emitter,
differences noted), **Astro `.amx`**, **Angular**.

### 13.1 Structural core

| Construct | html | html-strict / Astro `.mx` | Solid | Preact / React / Hono | Astro `.amx` | Angular |
|---|---|---|---|---|---|---|
| `if`/`else-if`/`else` | `if`/`else if`/`else` statements | same | ≤2 branches → `<Show when fallback>`; 3+ → `<Switch>`/`<Match>` | ternary chain, `null` arm when no `<else>` | ternary chain over `<Fragment>` | `@if`/`@else if`/`@else` |
| `for of` | `for (const p of …)` | same | `<For each>` (no `keyed`) | `.map`, key = item identity | `.map`, **no key** | `@for (… track $index)` + warning |
| `for of` + `by="id"` | **ignored** | ignored | `keyed={x=>x.id}` | `key={p.id}` | **ignored** | `track p.id` |
| `for in` | `Object.entries` loop | same | `<For each={Object.entries(o)} keyed={e=>e[0]}>`, reads via `mxEntry()` | `.map(([k,v])=>…)`, `key={k}` | `.map(([k,v])=>…)` | `\| keyvalue: null` + warning |
| `for` range | `for (let i=a; i<=b; i++)` | same | `<Repeat count from>` | `Array.from({length}).map` | **emits invalid JS — bug 3** | folded literal array |
| `for` range + `step=` | **error** | error | `<Repeat>` with `i = from + k*step` | `Array.from` with computed length | error | folded literal array |
| `define` | local render function | same | **error** — no local component form in a JSX expression | `const R = (p) => (<>…</>)` hoisted | **error** — extract to its own `.amx` | `<ng-template #R let-p>` |
| `const` | `const x = …` | same | **error** in a region | `const` at component-body top | **error** — declare it in the fence | `@let x = …;` |
| `let` | initial value only | **error** (strict) | **error** — use `createSignal` | **error** — use `useState` | **error** | error — fixed 2026-09-17, `<let>`-specific message; was **the wrong error** (bug 1, only the generic `/var` field guard fired) |
| `try` | `try`/`catch` | same | `<Loading>` | body inline | **error** | **error** |
| `try` + `<@catch>` | `catch` block | same | `<Errored fallback>` | `MxErrorBoundary` (Preact/React) / native `ErrorBoundary` with `fallbackRender` (Hono) | error | error |
| `try` + `<@placeholder>` | **error** — needs a second render pass | error | `<Loading fallback>` | `MxPlaceholder` / `Suspense`, nested **inside** the boundary | error | error |
| `<return>` + `/var` | `{ value, output }`; `/var` in **any** scope | same | `$mxReturn` callback prop; `/var` top-level only | `{ value, output }`; `/var` top-level only; **hook imports are a compile error** | **error** | error — fixed 2026-09-17 (page level; the tag-unit call site was already an error); was **accepted and silently dropped** (bug 8) |

### 13.2 Markup and attributes

| Construct | html | Solid | Preact | React | Hono | Astro `.amx` | Angular |
|---|---|---|---|---|---|---|---|
| `${}` | `escape(x)` | `{x}` | `{x}` | `{x}` | `{x}` | `{x}` | `{{ x }}` |
| `$!{}` | raw append | sole child → `innerHTML` | `dangerouslySetInnerHTML` | same | same | `<Fragment set:html>` | `<span [innerHTML]>` + warning |
| `class="a"` | `class` | `class` | `class` | `className` | `class` | `class` | `class` |
| `class={…}` | inlined `classValue()` | native `class={{…}}` | `mxClass(…)` | `mxClass(…)` | `mxClass(…)` | `class:list` | `[ngClass]` + warning |
| `style={…}` | inlined `styleValue()` | `style={{…}}` | `style={{…}}` | same | same | `style={{…}}` | `[ngStyle]` + warning |
| spread | merged into attrs | `{...o}` | `{...o}` | same | same | `{...o}` | **error** — Angular binds statically named inputs only |
| `:=` | **initial value only, silently one-way** | **error** | **error** | error | error | **error** | `[(value)]` — **genuinely two-way** |
| `class:foo` | **error**, quoting Marko | error | **error** | error | error | **error** | error, naming the replacement — fixed 2026-09-17; was **accepted** → `[class.active]` (bug 7) |
| dynamic tag | `renderDynamic()` | **error** | error | error | error | **error** | `[ngComponentOutlet]` + warning |
| component resolution | Marko's rule (binding + case) | **case only** | Marko's rule, with `componentAlias` | same | same | **case only** | **case only** |
| repeated `<@item>` | array of renderables | **duplicate JSX props, last wins** — bug 4 | array | array | array | repeated `slot=` | **error** |
| tag params | body block | child callback | render-prop child | same | same | **error** — Astro has no render-prop form | `let-x` |
| `<!doctype>` | emitted | **error** | **error** | error | error | emitted | emitted + warning |
| HTML comments | **stripped** (Marko parity) | stripped | stripped | stripped | stripped | **kept** | **kept** |

### 13.3 Stateful tags

| Tag | html | html-strict / Astro `.mx` | Solid | Preact/React/Hono | Astro `.amx` | Angular |
|---|---|---|---|---|---|---|
| `<effect>` | inert | error | error | error | error | error — fixed, was **literal element** (bug 1) |
| `<lifecycle>` | inert | error | error | error | error | error — fixed, was **literal element** |
| `<script>` | inert (body `text`) | error | error | error | error | error — fixed, was **literal element** |
| `<id>` | inert | error | field-guard error | error | error | error — fixed, was field-guard-only |
| `<log>` / `<debug>` | inert | **inert** — bug 5 | **literal element** | **literal element** | **literal element** | error — fixed, was **literal element** |
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

1. **`by=`** is ignored on html and `.amx`, item identity on the JSX hosts,
   reconciliation identity on Solid, `track` on Angular. Ignoring it is
   defensible on html (a one-shot render reconciles nothing) but `.amx` is a
   client-visible target and drops it with no diagnostic.
2. **The default `<for>` key.** Four different reconciliation behaviors from one
   MX source: item identity (JSX hosts), `$index` (Angular, warned), none
   (`.amx`), reference (Solid).
3. **`:=`** is genuinely two-way only on Angular; renders one-way with no error
   on html; rejected everywhere else.
4. **`server` blocks** execute on html and become junk markup everywhere else.
5. **`<let>`** binds an initial value on html and errors everywhere else,
   Angular included (fixed 2026-09-17; was the wrong error, bug 1).
6. **`<return>`** is a real value channel on html and the JSX hosts, a callback
   prop on Solid, an error on `.amx` and, since 2026-09-17, on Angular too
   (was silently dropped, bug 8).
7. **Comments** are stripped on html/Solid/JSX and kept on `.amx`/Angular.

### 13.5 Host selection

Resolved by `@mxlang/core`'s `resolveHostPolicy`, walking upward for the nearest
`package.json`:

1. A `"mx": { "host": …, "strict"?: … }` field — authoritative. `"translator"`
   is a **deprecated alias** for `"html"` and warns.
2. Failing that, **exactly one** `@mxlang/*` host dependency (in `dependencies`
   or `devDependencies`; `@mxlang/core` does not count) → that host at its
   default policy. Two or more → no match.
3. Otherwise `html`, non-strict.

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
| 3 | Astro `.amx` | **Every range `<for>` emits invalid JavaScript.** `Math.max(0, (` opens two parens and only one closes: `{Array.from({ length: Math.max(0, (3) - (0) + 1 }, …)}` — *"Unexpected token '}'. Expected ')' to end an argument list."* The test asserts only a substring (`toContain("(3) - (1) + 1")`), which passes regardless. |
| 4 | Solid | **Repeated attribute tags emit duplicate JSX props**, so the last wins and the first is silently lost. Every other JSX host builds an array. |
| 5 | html-strict | **`<log>`/`<debug>` survive `strict`.** `STRICT_TAGS` overrides six names but not these two, so they stay inert under strict — and therefore under the Astro `.mx` host, whose README claims all stateful tags are build errors. |
| 6 | Preact | README claims a non-object `style=` is an error; `<div style="color:red"/>` compiles. |
| 7 | Angular | **FIXED 2026-09-17**, decision 86. Was: silently accepted `class:`/`style:`/`attr:` modifiers, lowering `class:active=c` to `[class.active]="c"`. Every other host errors, on the grounds that this is **not Marko syntax at all** (§4). Now rejected the same way, naming the replacement (an object/array `class=`/`style=` value, or a plain dynamic attribute — the emitter itself decides `[attr.x]` vs `[x]` for a dynamic `data-*`/`aria-*` attribute). |
| 8 | Angular | **FIXED 2026-09-17** (page level; the tag-unit call site already errored). Was: `<return>` accepted and emitted nothing at the page level, silently dropping the value channel rather than erroring as `.amx` does. |
| 9 | html | **An attribute tag on a dynamic tag is silently dropped** (§7). |

### Host selection

Resolved by `@mxlang/core`'s `resolveHostPolicy`, walking upward for the nearest
`package.json`, in this order:

1. A `"mx": { "host": …, "strict"?: … }` field — authoritative.
2. Failing that, **exactly one** `@mxlang/*` host dependency → that host at its
   default policy.
3. Otherwise the translator's default (non-strict) policy.

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
| **Conditional attribute tags** | — | 95(7) |
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
   **And an attribute tag on a dynamic tag is silently dropped on the HTML host
   — measured, a real bug, not merely undocumented.** Needs a ruling: forward
   the attribute tags into `renderDynamic`'s props, or make the combination a
   positioned error.
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

---

## 16. Docs to fix

Drift between `apps/docs/docs/` and the code. **The code wins**; these are
reported, not edited (per this task's brief).

| Page | Claim | Reality |
|---|---|---|
| `language/stateful-tags.md` | `<return>` is an **Error** on the HTML host — "hands a value to a parent template, and a compiled module has no parent" | **Wrong since the unit model.** `<return>` ships in MX 1 (decisions 95, 97e, 98); the html host emits `{ value, output }` and supports `/var` in **any** scope. Decision 67d, which the page states, is superseded. |
| `language/stateful-tags.md` | "A reactive host (**a future SolidMX or React host**)" | Solid, Preact, React, Hono, Astro and Angular hosts all exist. |
| `language/structural-tags.md` | "SolidMX lowers the same tag to Solid's `<Show>`/**ternary** form" | The Solid host uses `<Show>` for ≤2 conditioned branches and `<Switch>`/`<Match>` for 3+. |
| `language/attribute-tags-and-params.md` | "A string-emitting host like the HTML host does **not currently support tag params on a component call** — only on the native control tags" | **Measured false.** `<Card\|x\|>${x}</Card>` against an imported component and `<Row\|x\|>${x}</Row>` against a `<define>` both compile on the html host. |
| `language/errors.md` | "Combining a dynamic tag name with an attribute tag is not supported **and is reported as such**" | **Nothing is reported.** Measured on the html host (which claims `DYNAMIC_TAG`): `<${T}><@head>x</@head>y</${T}>` compiles clean and drops `head` with no diagnostic, while the same call on a named component keeps it. A silent drop, not an error — see §7 and §15. |
| `language/define-const-static-import.md` | Shows `import { formatDate } from "./util.mx"` | A `.mx` file is a template compiling to a component, not a module exporting `formatDate`. The example should import from a `.ts` file. |
| `language/errors.md`, `stateful-tags.md` | Both describe the strict policy as covering "the same six constructs" | Correct, but neither page states that the `input`-shadowing check is **not** strict-only. `define-const-static-import.md` does say it. |
| — | No docs page covers `<return>`, `/var`, custom tag units, discovery, or sidecars | Partly closed 2026-09-18: the custom tags build spec is on the site at `/design-notes/custom-tags/`; dedicated language pages for `<return>`, `/var`, discovery and sidecars are still missing. |

### Stale in the repo's own docs (READMEs and comments, not the docs site)

| File | Claim | Reality |
|---|---|---|
| `packages/hosts/html/README.md`, `packages/hosts/preact/README.md` | `<return>` listed under "Error — the target genuinely cannot" | Both hosts emit `{ value, output }`; decision 95 reversed this and the code comments say so explicitly. |
| `packages/hosts/html/src/translate.ts:511` | "`<await>`/`<try>`-with-placeholder/`<return>` are errors in both policies already" | `<return>` is not among them; the html host has no `return` disposition at all. |
| `packages/hosts/astro/README.md` | The `.amx` lowering table shows the range `<for>` row working | It emits unparseable JavaScript — bug 3. |
| `packages/hosts/astro/README.md` (Astro `.mx` host) | All stateful tags are build errors | `<log>`/`<debug>` stay inert under `strictPolicy` — bug 5. |
| `packages/hosts/preact/README.md` | A non-object `style=` is an error | It compiles. |
| `packages/hosts/angular/README.md` | Never mentions stateful tags | They emit literal elements — bug 1. |
| `packages/hosts/solid/README.md` | Does not cover repeated attribute tags | They emit duplicate props, last-wins — bug 4. |

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
