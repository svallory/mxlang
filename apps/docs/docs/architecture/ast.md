---
title: "The MX AST"
description: "Draft catalogue of MX2's own syntax tree: Marko's AST as it is today, the accommodations removed, the MX node types, and how they map to parser events and to the IR."
---

# The MX AST

> **Status: draft for review** (decision 158). Owners: mx-lead (IR, lowering)
> and native-parser (parser, node types). Nothing on this page is implemented
> yet. Section 1 describes what exists today and cites it; sections 2 to 9 are
> the proposal. Every statement about Marko, htmljs-parser or the current
> lowering cites the file and line it was read from, or a probe that was run.

Decision 158 gives MX2 its own syntax tree: node types defined in MX's Babel
fork (`@mxlang/babel`), built by a front end in `@mxlang/parser` from the
template parser's events, and read directly by `lower()` in `@mxlang/core`.
This page is the catalogue those three pieces are built from.

**Citation shorthand.** `[C]` is the installed compiler,
`node_modules/.bun/@marko+compiler@5.42.10/node_modules/@marko/compiler/dist/`.
`[H]` is the installed template parser,
`node_modules/.bun/htmljs-parser@5.18.0/node_modules/htmljs-parser/dist/`.
`[Hs]` is the htmljs-parser source clone at `~/work/htmljs-parser` (version
5.18.0 in its `package.json`). Paths without a prefix are relative to the repo
root. "Probe" means a script run on 2026-10-05 against the installed
compiler, kept outside the repo under `~/tmp/mx2-ast/` (`raw.ts`: parse-only
translator, as `parseFragment` uses; `core.ts`: MX's core taglib registered
the way `packages/targets/html/src/compiler.ts:53` registers it).

**Version.** The workspace resolves `@marko/compiler` **5.42.10** (the only
copy under `node_modules/.bun/`; `bun.lock:1050`; `packages/core/package.json:44`)
and `htmljs-parser` **5.18.0** with the MX patch (`package.json:57`, `:69`).
The compiler's own `htmljs-parser` link resolves to the same patched 5.18.0
copy. A research note citing 5.42.5 predates commit `c2e521347`.

## 1. Marko AST as it is

### 1.1 Where the node types live

Marko's thirteen node types are declared in a **patched `@babel/types`
7.29.7** bundled into the compiler: `[C]babel.js:8065` opens the region
`@babel+types@7.29.7_patch_hash=…/lib/definitions/marko.js`, and
`defineAliasedType("Marko")` defines every type at `[C]babel.js:8069-8280`.
The TypeScript declarations are at `[C]types.d.ts:3630-3716`, and the Marko
types are members of Babel's own `Node` union (`[C]types.d.ts:381`). The same
patch adds a non-standard `params` field to `Program`
(`[C]types.d.ts:576`, `[C]babel.js:5511`), which the compiler fills with a
single `input` identifier (`[C]chunk-src.js:6447`).

Every node extends Babel's `BaseNode`: optional `start`, `end`, `loc`,
`range`, comments and `extra` (`[C]types.d.ts:369-378`).

**Positions in practice.** MX never sees `start`/`end` on a Marko node. The
compiler's `parserOverride` returns `types.cloneNode(file.ast, true)`
(`[C]chunk-src.js:6710`), and Babel's `cloneNode` copies only the declared
fields, `loc`, comments and `extra`, never `start`/`end`
(`[C]babel.js:13217-13241`). Probe `raw.ts` on `<div#a.b x=foo :y/>`
confirms it: every Marko node has `start === undefined`; Marko nodes carry
`loc` without `index`; Babel expression nodes inside them carry
`loc.start.index`. `packages/core/src/fragment.ts:254-258` relies on exactly
this ("Present on plain Babel nodes only; absent on Marko's own").

### 1.2 The thirteen node types

Optionality is from the `defineType` field definitions; "default" means the
builder fills the value. "Read by" lists the MX reading sites (all under
`packages/`, tests excluded); "not read" means no MX source reads the field.

#### `MarkoTag`

Defined `[C]babel.js:8233-8280`; declared `[C]types.d.ts:3704-3714`. Aliases
`Marko`, `Statement`.

| Field | Type | Optional | Read by MX |
|---|---|---|---|
| `name` | `Expression` (a `StringLiteral` for a static name, a template literal or other expression for `<${x}>`) | required | everywhere a tag is dispatched: `core/src/lower.ts:3271` (`name?.value === "if"`), `:3395` (statement scan), `core/src/default-tag.ts:18-29` (empty-span test), `core/src/name-sugar.ts:883-895`, `targets/data/src/scan.ts:158-170` |
| `attributes` | `(MarkoAttribute \| MarkoSpreadAttribute)[]` | default `[]` | `core/src/lower.ts:765` (`lowerAttrs`), `:2286-2300` (`<return>`), `core/src/name-sugar.ts:594-713` (`rewriteAttributes`) |
| `body` | `MarkoTagBody` | required | `lower.ts:880` (`node.body?.body`), `:2283` |
| `arguments` | `(Expression \| SpreadElement)[] \| null` | optional | `lower.ts:971`, `:2247`, `:2704`, `:2875` |
| `typeArguments` | `TSTypeParameterInstantiation \| null` | optional | `core/src/core.ts:1127` (rejected: "type arguments on … are not supported") |
| `rawValue` | `string \| null` | optional | not read (the statement lowerer re-slices the source instead, `lower.ts:2153`) |
| `var` | `LVal \| null` | optional | `lower.ts:1985-2064` (`<const>`, `<define>`), `:2543-2679` (components), `:3239-3257`, `core/src/reserved-bindings.ts:64` |
| `attributeTags` | `(MarkoTag \| MarkoScriptlet \| MarkoComment)[]` | default `[]` | `lower.ts:948`, `:1393`, `:1532`, `:2342-2404`, `:2552`, `:3143` |

Also set at runtime but not a declared field, so dropped by the clone:
`tagDef` (`[C]chunk-src.js:6080`). Not in the builder but declared in the
d.ts: none beyond the table.

#### `MarkoTagBody`

Defined `[C]babel.js:8200-8232`; declared `[C]types.d.ts:3696-3702`. Aliases
`Marko`, `BlockParent`, `FunctionParent`, `Scope`, `Scopable` (it is the
Babel scope for tag params). Probe: it carries **no `loc`**.

| Field | Type | Optional | Read by MX |
|---|---|---|---|
| `body` | `(MarkoTag \| MarkoCDATA \| MarkoText \| MarkoPlaceholder \| MarkoScriptlet \| MarkoComment)[]` | default `[]` | `lower.ts:880`, `:2283` and every child walk |
| `params` | `FunctionParameter[]` | default `[]` | `lower.ts:821`, `:844-866`, `:1818`, `:1958`; `core.ts:1133` |
| `attributeTags` | `boolean` | default `false` | not read |
| `typeParameters` | `TSTypeParameterDeclaration \| null` | optional | `core.ts:1127` (rejected) |

#### `MarkoAttribute`

Defined `[C]babel.js:8162-8193`; declared `[C]types.d.ts:3681-3689`. Alias
`Marko` only (not `Expression`, not `Statement`).

| Field | Type | Optional | Read by MX |
|---|---|---|---|
| `name` | `string` | required | `lower.ts:578`, `:590-593`, `:2297` |
| `value` | `Expression` (a `BooleanLiteral true` when no value was written, `[C]chunk-src.js:6117`) | required | `lower.ts:665-747` (kind derivation) |
| `modifier` | `string \| null` | optional | `lower.ts:213-216`, `:243`, `:592-595`, `:643-660`, `:723` |
| `arguments` | `(Expression \| SpreadElement)[] \| null` | optional | `lower.ts:613`, `:618` |
| `default` | `boolean \| null` | optional | `lower.ts:200-214`, `:231`, `:524`, `:2297` |
| `bound` | `boolean \| null` | optional | `lower.ts:494`, `:591`, `:628` |

MX adds four ad hoc fields to attributes it synthesizes for name sugar:
`sugarNameSpan`, `sugarLabel`, `sugarAt` and real `start`/`end`
(`core/src/name-sugar.ts:154-176`, `:327-351`); `lower.ts:205-210`,
`:544-546` and `:562-566` read them.

#### `MarkoSpreadAttribute`

Defined `[C]babel.js:8194-8199`; `[C]types.d.ts:3691-3694`. One field,
`value: Expression`, required. Read by `lower.ts:569-570`.

#### `MarkoText`

`[C]babel.js:8115-8119`; `[C]types.d.ts:3658-3661`. `value: string`,
required, **already whitespace-normalized** by the front end
(`[C]chunk-src.js:5985-6037`). Read by `lower.ts:3282-3290`, `:937-938`,
`:1722`, `:2430`; `core.ts:1035`.

#### `MarkoPlaceholder`

`[C]babel.js:8120-8131`; `[C]types.d.ts:3663-3667`. `value: Expression`
required; `escape: boolean` default `true`. Read by `lower.ts:3293-3307`
(both fields).

#### `MarkoScriptlet`

`[C]babel.js:8132-8151`; `[C]types.d.ts:3669-3674`. `body: Statement[]`
required; `static: boolean` default `false`; `target: "server" \| "client"`
optional. MX reads only the type: `lower.ts:3339-3343` rejects every scriptlet
(decision 54). `static` and `target` are not read; they are never set by the
front end either (`[C]chunk-src.js:6067` builds `markoScriptlet(block.body)`).

#### `MarkoComment`

`[C]babel.js:8104-8114`; `[C]types.d.ts:3652-3656`. `value: string`
required (delimiters stripped); `kind: "html" \| "line" \| "block"` optional,
set by `getCommentKind` (`[C]chunk-src.js:6250-6256`). MX reads `value`
(`lower.ts:3328-3337`) but **not `kind`**: it re-derives "is this an HTML
comment" by slicing the source (`lower.ts:3334`).

#### `MarkoCDATA`, `MarkoDocumentType`, `MarkoDeclaration`

`[C]babel.js:8099-8103`, `:8089-8093`, `:8094-8098`; `[C]types.d.ts:3647`,
`:3637`, `:3642`. Each has one required `value: string`, delimiters stripped
(probe: `<!doctype html>` gives `"doctype html"`, `<?xml v?>` gives
`"xml v"`). `MarkoDocumentType.value` is read by `lower.ts:3321-3327`;
`MarkoCDATA` and `MarkoDeclaration` are rejected by type (`lower.ts:3354-3359`,
decision 139).

#### `MarkoClass`

`[C]babel.js:8152-8161`; `[C]types.d.ts:3676-3679`. Aliases `Marko`,
`Statement`, **`Class`**. One field, `body: ClassBody`. The front end never
builds it (`[C]chunk-src.js` has no `markoClass(` call); it is produced by
Marko's translator for the class tag. No MX source references it.

#### `MarkoParseError`

`[C]babel.js:8069-8088`; `[C]types.d.ts:3630-3635`. Aliases `Marko`,
**`Expression`, `Statement`**, so it can stand in any expression or statement
slot. Fields: `source: string` and `label: string` required, `errorLoc:
object \| null` optional. Built by `createParseError`
(`[C]chunk-src.js:1027`) when a Babel sub-parse fails; it also sets
`file.___hasParseErrors`. Probe on `<div x=(1 +)/>`: the attribute's `value`
is `MarkoParseError { source: "(1 +)", label: "Unexpected token", errorLoc:
{ start: { line: 1, column: 11, index: 11 } } }`. Read by
`lower.ts:274-281` (`label`, `errorLoc`, `loc`),
`core/src/stock-parser.ts:245`, `hosts/solid/src/compile.ts:207` (`source`).

### 1.3 Marko's front end, handler by handler

`parseMarko` (`[C]chunk-src.js:5887-6249`) implements **24** of the
template parser's 27 handlers (`[H]util/constants.d.ts:64-90`). It does not
implement `onOpenTagStart`, `onCloseTagStart` or `onCloseTagName`.

| Handler | Line | What it builds |
|---|---|---|
| `onError` | 5975 | throws a `CompileError` (aggregated with earlier `MarkoParseError`s); never a node |
| `onText` | 5985 | `MarkoText`, after dropping newline-only runs and trimming against neighbours (`onNext` lookahead, 6014-6036) |
| `onCDATA`, `onDoctype`, `onDeclaration` | 6038, 6041, 6044 | the three value nodes |
| `onComment` | 6047 | `MarkoComment` with `kind` |
| `onOpenTagComment` | 6050 | a Babel `CommentBlock`/`CommentLine`, attached later as leading/trailing/inner comments (5941-5948) |
| `onTagTypeArgs` | 6056 | `tag.typeArguments` |
| `onTagTypeParams` | 6059 | **`tag.body.typeParameters`** |
| `onPlaceholder` | 6062 | `MarkoPlaceholder` |
| `onScriptlet` | 6065 | `MarkoScriptlet`; `part.block` ignored |
| `onOpenTagName` | 6071 | `MarkoTag`; writes `"div"` into an empty name (6078); looks up `tagDef.parseOptions` to choose the parse mode (6080-6086) |
| `onTagShorthandId`, `onTagShorthandClass` | 6092, 6095 | buffered, merged at `onOpenTagEnd` |
| `onTagVar`, `onTagArgs` | 6099, 6105 | `tag.var`, `tag.arguments` |
| `onTagParams` | 6102 | **`tag.body.params`** |
| `onAttrName` | 6108 | `MarkoAttribute`, name split at the **last** `:` (6111), empty head becomes `"value"` with `default: true` (6117) |
| `onAttrArgs`, `onAttrValue`, `onAttrMethod` | 6121, 6125, 6131 | fill the current attribute |
| `onAttrSpread` | 6139 | `MarkoSpreadAttribute` |
| `onOpenTagEnd` | 6143 | merges shorthands into `class`/`id` attributes (6148-6171); sets `rawValue` for `rawOpenTag` tags (6173-6177) |
| `onCloseTagEnd` | 6181 | sets `end`/`loc`; for a `controlFlow` tag that holds attribute tags, swaps its body and moves it into the parent's `attributeTags` (6194-6227) |

Expression parsing (`[C]chunk-src.js:947-1016`): each position is parsed by
wrapping the slice and passing `startIndex`/`startLine`/`startColumn`, so the
Babel node's positions are file-relative: params as `(${str})=>{}` with offset 1
(956), arguments as `_(${str})` with offset 2 (961), a tag var as
`(${str}\n)=>{}` (966), type arguments as `_<${str}>` (978), type parameters as
`<${str}>()=>{}` (983).

### 1.4 How MX gets a Marko tree today

Two entry points, both through `compileSync`:

- `parseFragment` (`packages/core/src/fragment.ts:383-438`) with
  `PARSE_ONLY_TRANSLATOR` (`fragment.ts:58-62`): **no core taglib**. Probe:
  `import x from "./y"` parses as a `MarkoTag` named `import` with attributes
  `x`, `from` and `"./y"`; `class { x = 1 }` as a tag `class` with one
  attribute named `{ x = 1 }`. `name-sugar.ts:862-881` carries a fallback list
  of statement tag names for exactly this case.
- `compileSource` (`packages/core/src/compile.ts:329-380`) with the host's
  translator (`compile.ts:198-245`), which registers MX's core taglib
  (`packages/core/src/taglib/core-tags.json`; `statement: true,
  rawOpenTag: true` for `import`, `static`, `export`, `client`, `server`,
  `class` at lines 75-90; `controlFlow: true` for `if`, `else`, `else-if`,
  `for` at 4-16). Probe `core.ts`: the same statement then parses as a
  `MarkoTag` named `import` with no attributes and `rawValue: "import x from
  \"./y\""`. `lower()` runs in the translator's `Program.exit`
  (`compile.ts:230`).

## 2. Accommodations removed

One row per thing Marko's AST or front end does to fit Marko. "Why" is
Marko's reason as far as the source shows it; where the source does not say,
the row says "not stated".

| # | What Marko does | Why (Marko's need) | What MX needs instead | Replaced by |
|---|---|---|---|---|
| A1 | The Marko node family lives inside a patched `@babel/types` (`[C]babel.js:8065-8280`), members of Babel's `Node` union (`[C]types.d.ts:381`); `Program` gains `params` (`[C]babel.js:5511`). | Marko's translator is a Babel plugin: it traverses and replaces Marko nodes with Babel's own `NodePath`, scope and builders, so the nodes must be Babel nodes. `MarkoTagBody` is a Babel `Scope`/`FunctionParent` (`[C]babel.js:8201-8207`) so tag params get Babel bindings. | MX never runs Marko's translator. MX needs node types it owns, defined in `@mxlang/babel` without patching Babel's own definitions, and traversable by MX's own walker. | The `Mx*` family (§3), declared as a separate union in `@mxlang/babel`. Babel nodes appear only inside expression containers (§4). |
| A2 | The attribute name is split at the **last** `:` into `name` + `modifier` (`[C]chunk-src.js:6111-6115`). | Marko's translator implements modifiers (`class:x`, `value:fn:=x`, `x:scoped`). | MX gives `:` no general modifier meaning; `class:`/`style:` reach the host through a hook, and every other colon name is an ordinary name rejoined by `lower.ts:590-593` and explained at `:224-246`. | `MxAttribute.name` is the authored name, colons included. No `modifier` field. A consumer that needs `class:x` splits the string (§8, D4). |
| A3 | An attribute with an empty head is named `"value"` with `default: true` (`[C]chunk-src.js:6117`), so `<if=a>` and bare `:x` both become `value`; the default attribute's `loc` starts at the `=` and has no name text (`lower.ts:188-202`). | Marko's tags read their default input as `input.value`. | `<if=a>` is "the tag's default value", not an attribute named `value`. Bare `:x` is the name sugar (decision 146, divergence `divergences.md:131`). | `MxAttribute.name: null` for the default attribute (§3.5); bare `:x` is `MxShorthand { sigil: ":" }` (§3.6). |
| A4 | Tag-adjacent `#id`/`.class` are buffered and merged into `class`/`id` attributes at `onOpenTagEnd` (`[C]chunk-src.js:6148-6171`); several classes become one string, a template, or an array; the merged attributes have **no `loc`** (probe: `MarkoAttribute@noloc`). A shorthand `id` beside an `id` attribute throws (6168). | Marko's output is HTML; merging gives the translator one `class` attribute. | Shorthands are their own syntax with their own spans; MX's name sugar has to recover them (`name-sugar.ts` exists for this; `lower.ts:557-559` falls back to the tag position). Merging and duplicate rules are language semantics, owned by lowering. | `MxShorthand` nodes, in source order, each with its own span (§3.6). No merge in the AST. |
| A5 | An empty tag name becomes `"div"` (`[C]chunk-src.js:6078`), leaving the `StringLiteral` with an empty span. | Marko has one host. | Decision 145: an unnamed tag resolved by the `defaultTag` ladder. MX detects it today by an empty-span test (`default-tag.ts:12-29`, `targets/data/src/scan.ts:160-167`). | `MxTagName { kind: "unnamed" }` (§3.3). |
| A6 | A tag name containing `:` is one name (`<a:b>` is tag `a:b`); a `:` inside a shorthand is part of the class (`.c:b`). | htmljs-parser's tag-name rule; Marko has no name sugar. | Decision 146 and addendum (`divergences.md:130`, `:133`): the head splits into tag, `:name`, `#id`, `.class` in any order. MX does it post-parse (`name-sugar.ts:5-32`). | `MxShorthand` items in `MxTag.shorthands`; the name never contains `:` (§3.3, §3.6). |
| A7 | Attribute tags are moved out of the body into `tag.attributeTags`, with preceding comments (`[C]chunk-src.js:5915-5927`); a `controlFlow` tag holding attribute tags has its body and `attributeTags` swapped and is moved into the **parent's** `attributeTags`, with `body.attributeTags = true` (`[C]chunk-src.js:6194-6227`). The moved list is then re-sorted by `start` (`attributeTags.sort(sortByStart)`, `[C]chunk-src.js:6213`). Probe: `<Card><@head/><if=a><@item/></if></Card>` puts the `<if>` in `Card.attributeTags`. | Marko's translator compiles attribute tags as input properties of the parent; moving them at parse time saves a pass. | Lowering already re-derives structure: three synchronized views (`attributeTags`, `attributeTagTree`, `attrTagProps`) and source-order merging (`lower.ts:1508-1516`, `:1517`). The AST should show what was written, where it was written. | Attribute tags stay in `body` in source order as `MxAttributeTag` nodes; nothing moves (§3.7, §8 D2). |
| A8 | Statement tags (`import`, `export`, `static`, `server`, `client`, `class`) are tags whose open tag is kept raw (`rawOpenTag`, `[C]chunk-src.js:6173-6177`) and whose meaning comes from the taglib (`core-tags.json:75-90`); without the taglib they parse as tags with garbage attributes (probe, §1.4). MX recovers the statement by slicing the source on `loc` (`lower.ts:2153`, `:3399-3410`) and regexes (`lower.ts:2161`, `:2202`). Spec §2 documents the cost (`apps/docs/docs/specification.md:204-209`). | Marko's grammar is tag-shaped at the top level; the translator gives the statement tags meaning. | They are TypeScript statements. MX needs the parsed statement, its keyword and its span. | `MxModuleStatement { keyword, statements }` with a parsed Babel statement list (§3.10). |
| A9 | `MarkoClass` (`[C]babel.js:8152-8161`), a `Class`-aliased node. | Marko 5's class components. | MX has no class components; `class` is not a statement MX accepts (`lower.ts:2209-2212` rejects anything but `import`/`static`/`export`). | No node. `class { }` at the top level is an `MxModuleStatement { keyword: "class" }` that lowering rejects (§3.10), so the error keeps its position. |
| A10 | `MarkoParseError` is an `Expression` and `Statement` alias (`[C]babel.js:8070-8074`) put in place of the failed expression; `onError` from the template parser **throws** (`[C]chunk-src.js:5975-5984`). Two error channels, neither carries a code. | Lets the translator keep going until it reaches the bad expression, then throw. | Decision 157 addendum 1 asks for structured errors. MX needs every error as data: a code, a span, a message. Several template errors per parse would need parser recovery (Q20). | `MxParseError { code, source, message, span }` in `MxDocument.errors`, and an `error` field on the expression container that failed (§3.13, §4). Expression and front-end errors no longer throw; a template-parser error still ends the parse (htmljs `emitError`), but the tree built so far is kept (§3.13). |
| A11 | Tag params and tag type parameters are stored on **`MarkoTagBody`** (`[C]chunk-src.js:6059`, `:6102`), not on the tag. | `MarkoTagBody` is the Babel scope that binds them (A1). | The params belong to the tag head the author wrote; scope is a lowering concern. | `MxTag.params`, `MxTag.typeParams` (§3.2). The body is a plain child list. |
| A12 | Positions: Marko nodes get `start`/`end` and a `loc` without `index` (`withLoc`, `[C]chunk-src.js:5909-5914`), then lose `start`/`end` in the clone (`[C]chunk-src.js:6710`, `[C]babel.js:13217-13241`); Babel nodes keep `loc.index`. Position objects are shared between nodes (`packages/core/AGENTS.md`, `parseFragment` bullet). Fragments are shifted by a tree walk afterwards (`fragment.ts:229-264`). `Program.end` is `code.length - 1` (`[C]chunk-src.js:6241`). | Babel's `File`/`loc` model; the clone is how the compiler hands the tree to Babel. | One numeric span on every node, file-relative, in UTF-16 units, with line/column computed on demand (§5). | `start`/`end` on every MX node; no `loc` stored (§5). |
| A13 | Text is whitespace-normalized in the front end, with neighbour lookahead (`[C]chunk-src.js:5985-6037`); the node's `loc` is moved to the trimmed text. | Marko's HTML output rules. | MX needs both: the normalized value the IR's `Text.value` carries, and the authored span (`ir.ts:396-412`). | `MxText { value, raw }` plus span (§3.8, §8 D6). |
| A14 | Open-tag comments become Babel comments attached to the next attribute, the last attribute, or the tag (`[C]chunk-src.js:5941-5948`). | Babel's comment attachment model. | A comment is source; tools need it where it was written. | `MxComment` items in `MxTag.attributes` order (§3.11). |
| A15 | The tag's parse mode (text, void, statement, preserve-whitespace) comes from a taglib lookup at name time (`[C]chunk-src.js:6080-6086`), fed by Marko's built-in element taglibs (`marko-html.json` at `[C]chunk-src.js:3057`, SVG at `:5348`, MathML at `:5175`), MX's `core-tags.json`, and custom tags' `text`/`preserveWhitespace` (`core/src/custom-tags.ts:460-485`). | Marko's taglibs. | The parse mode is still name-dependent. MX needs it as an explicit input to the front end, not a taglib. | A `tagShape(name)` callback on the front end, and `MxTag.bodyMode` recording what was answered (§3.12; the full input list is §7.1). |
| A16 | `MarkoScriptlet.static`/`target` and `MarkoComment.kind` exist but MX does not read them; `MarkoTagBody.attributeTags` is an internal flag (A7). | Translator needs. | Fields the language does not use are noise. | Dropped, except comment `kind`, which MX keeps and lowering should read instead of re-slicing (§9, Q11). |
| A17 | `<${x}>` names are parsed as template strings: a static-only template becomes a `StringLiteral`, one expression with empty quasis becomes that expression (`[C]chunk-src.js:5954-5973`). | One code path for all names. | A dynamic name is an expression with a span; a static name is a string with a span. | `MxTagName` kinds `static` and `dynamic` (§3.3). |
| A18 | `rawValue` (`[C]babel.js:8267`) holds the raw open tag for `rawOpenTag` tags (statement tags and `<style>`, `core-tags.json`). | Marko's `<style>` and statement handling. | Not needed once statements are parsed (A8); `<style>` content is a body. | No field. |
| A19 | A `{ … }`-wrapped attribute value that fails to parse gets a hint appended to its `MarkoParseError` label: "Attribute values in Marko are plain JavaScript expressions, not JSX; remove the wrapping `{ }`" (`withWrappedAttrValueHint`, `[C]chunk-src.js:6292-6297`, applied at `:6129`). | A common mistake from JSX authors. | The same hint, in MX's words. | The front end applies the same test to an `MxExpression` error and rewords the message (§3.13). |
| A20 | The tag name `%` throws "`<% scriptlets %>` are no longer supported" (`[C]chunk-src.js:6079`). | Marko 3 scriptlet syntax removed. | MX never had it; a clear error is still better than an unknown `%` tag. | `MxParseError` `MX_RESERVED_TAG_NAME`, recorded, parse continues (§3.2). |
| A21 | A statement tag written in HTML mode (`<import …>`) throws `statementTagInHTMLModeError` (`[C]chunk-src.js:6087`, message at `:6278-6284`). | Statement tags are top-level concise lines. | The same rule; `import` is an `MxModuleStatement` only on a concise top-level line. | `MxParseError` `MX_STATEMENT_IN_HTML_MODE` with Marko's message, recorded (§3.2). |
| A22 | Comments inside a scriptlet block and inside a tag body are kept as Babel `innerComments` (`[C]chunk-src.js:6067-6069`). | Babel's comment model. | Comments inside TypeScript belong to the Babel payload. | Kept on the `MxStatements` payload as Babel produces them; no `Mx*` field. |

## 3. MX nodes

### 3.0 Naming scheme

Every type this catalogue defines is `Mx` + a PascalCase noun (`MxDocument`,
`MxTag`, `MxAttribute`). Two kinds of `Mx` type exist:

- **Nodes** have a `type` discriminator equal to their name and a span, and are
  members of the `MxNode` union below. Expression containers (§4) are nodes
  too: they have a `type` and a span, but they only appear in fields, never in
  a child list.
- **Field shapes** (`MxTagName`, `MxShorthandValue`, `MxCloseTag`) have no
  `type`; each is documented with the field that holds it.

`Span` is the one unprefixed helper. No name starts with `Marko` (criterion
11). Collision check: the Babel fork's node types in
`packages/parser/src/babel/types.ts` contain no `Mx` prefix (`rg 'type: "Mx'`
returns 0), while unprefixed candidates would collide (`Placeholder` is a Babel
type at `types.ts:2017`; `TemplateLiteral` at `:810`).

```ts
interface Span { start: number; end: number }      // §5
interface MxNodeBase extends Span { type: `Mx${string}` }

type MxChild =
  | MxTag | MxAttributeTag | MxReturn | MxText | MxPlaceholder
  | MxScriptlet | MxComment | MxCDATA | MxDoctype | MxDeclaration
  | MxModuleStatement;

type MxNode =
  | MxDocument | MxChild
  | MxAttribute | MxShorthand | MxSpreadAttribute | MxMethod
  | MxParseError | MxAtom
  // expression containers (§4)
  | MxExpression | MxStatements | MxPattern | MxArguments
  | MxParameterList | MxTypeArguments | MxTypeParameters;
```

Offsets in the examples are `[start, end)` within the example line alone (a
whole file starting with that line), computed by script.

### 3.1 `MxDocument`

Purpose: the root of a parse (a whole `.mx` file, an `.astro.mx` template body,
or a region/fragment).

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `body` | `MxChild[]` | no | top-level children, source order; partial when the template parser stopped at an error (§3.13) |
| `errors` | `MxParseError[]` | no | expression errors in source order, then at most one template-parser error, last (§3.13) |
| `complete` | `boolean` | no | `false` when the template parser reported an error (the parse stopped there) |
| `source` | `string` | no | the text that was parsed (the fragment, for a fragment parse) |
| `base` | `{ offset: number; line: number; column: number }` | no | §5.3; `{0, 0, 0}` for a whole file |

There is no document-level mode: htmljs decides concise or HTML per line, and
each `MxTag.concise` records it per tag.

Spans: `start = base.offset`, `end = base.offset + source.length` (not
`length - 1`, unlike `[C]chunk-src.js:6241`). A leading byte-order mark is
skipped by the parser (`packages/parser/src/template/core/Parser.ts:296` on
`main`), so the first node can start at offset 1.

Example: the document for `<p>x</p>` is `[0, 8)` with `body` one `MxTag`
`[0, 8)`, `errors` empty, `complete: true`.

Invariants: `body` is in source order; every node's span lies in
`[start, end]`; `complete === false` iff `errors` ends with a template-parser
error (§3.13).

### 3.2 `MxTag`

Purpose: an element, component call, structural tag, custom tag or dynamic tag.
The AST does not decide which: resolution is lowering's (spec §7).

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `name` | `MxTagName` | no | §3.3 |
| `typeArgs` | `MxTypeArguments \| null` | no | `<Tag<T>>` |
| `var` | `MxPattern \| null` | no | `/x` |
| `args` | `MxArguments \| null` | no | `(a, b)` after the name |
| `typeParams` | `MxTypeParameters \| null` | no | `<T>` before params |
| `params` | `MxParameterList \| null` | no | `\|a, b\|`; `null` means no pipes, an empty list means `\|\|` |
| `shorthands` | `MxShorthand[]` | no | tag-adjacent `#id`, `.class`, `:name`, source order |
| `attributes` | `(MxAttribute \| MxShorthand \| MxSpreadAttribute \| MxComment)[]` | no | attribute list in source order, attribute-position sugar and open-tag comments included |
| `body` | `MxChild[] \| null` | no | `null` for a self-closed tag and for a tag the parser closed at its open tag (`bodyMode: "void"`); children in source order, attribute tags included |
| `bodyMode` | `"html" \| "parsed-text" \| "preserve" \| "parsed-text-preserve" \| "void"` | no | the parse shape `tagShape(name)` answered (§3.12) |
| `selfClosed` | `boolean` | no | `/>` written |
| `concise` | `boolean` | no | written in concise mode |
| `openTag` | `Span` | no | `<` (or the first name character in concise mode) through `>`/`/>` (or end of the head line) |
| `closeTag` | `MxCloseTag \| null` | no | the written closing tag; `null` when none was written (self-closed, void, concise) |
| `incomplete` | `boolean` | no | `true` when the template parser stopped (§3.13) before this tag's end event |

`MxCloseTag` is `{ span: Span; name: string \| null; nameSpan: Span \| null }`:
`span` is `</` through `>`; `name` is the **written** closing name, sugar
included (`</div:x>` gives `"div:x"`, spec "Name sugar",
`specification.md:729-731`; `divergences.md:130`), from `onCloseTagName`;
`name` and `nameSpan` are `null` for `</>`. The front end does not compare it
with the open name: htmljs reports `MISMATCHED_CLOSING_TAG` (code 21,
`[H]util/error-code.d.ts`) itself.

Spans: `start` is the `<` in HTML mode (Marko does the same,
`[C]chunk-src.js:6075`), the first head character in concise mode. `end` is
the end of the `onCloseTagEnd` range: the end of `closeTag` when one was
written, the end of `openTag` for a self-closed or void tag, and for a concise
block the end of its last descendant (probe on `div.a\n  -- some text
${y}\n  span#b`: the tag's `loc` ends at 3:8, the end of `span#b`). For an
`incomplete` tag, `end` (and `openTag.end`, when `onOpenTagEnd` had not
arrived) is the `start` of the template-parser error. Sub-spans:
`name` (§3.3), each head part's own span (§3.4).

Source forms and example:

```mx
<Row<string>/row(a, b)<T>|item: T| class="x">${item}</Row>
```

Offsets (`[start, end)`, this line alone):
- tag: `[0, 58)`; `openTag`: `[0, 45)`; `closeTag.span`: `[52, 58)`, `closeTag.nameSpan` `[54, 57)`
- `name.span`: `[1, 4)` (`Row`)
- `typeArgs`: `[5, 11)` (`string`), `outer` `[4, 12)`
- `var`: `[13, 16)` (`row`)
- `args`: `[17, 21)` (`a, b`)
- `typeParams`: `[23, 24)` (`T`)
- `params`: `[26, 33)` (`item: T`)
- `attributes[0]`: `[35, 44)`; `body[0]` (`MxPlaceholder`): `[45, 52)`

Invariants: `params !== null` iff pipes were written; head parts appear at most
once each (a second one is an htmljs error, which stops the parse, §3.13);
`body` never contains `MxModuleStatement` (top level only, §3.10);
`bodyMode === "void"` implies `body === null` and `closeTag === null`.

**HTML-mode statement tags.** `<import …>`, `<static …>` and the other
statement keywords written with `<` are an `MxParseError` with code
`MX_STATEMENT_IN_HTML_MODE` and Marko's message
(`statementTagInHTMLModeError`, `[C]chunk-src.js:6087`, `:6278-6284`); the
front end produces an `MxModuleStatement` only for a concise top-level line.
Unlike Marko, which throws, the error is recorded and the parse continues
(this error is the front end's, not the template parser's).

**`<%`.** Marko rejects the tag name `%` ("`<% scriptlets %>` are no longer
supported", `[C]chunk-src.js:6079`). MX has no such tag; `<%` is an
`MxParseError` `MX_RESERVED_TAG_NAME` with the same message, recorded the same
way.

### 3.3 `MxTagName`

A field shape of `MxTag` (no `type`).

```ts
type MxTagName =
  | { kind: "static"; value: string; span: Span }
  | { kind: "dynamic"; expression: MxExpression; quasis: Span[];
      expressions: MxExpression[]; span: Span }                 // <${x}>, <my-${x}>
  | { kind: "unnamed"; span: Span };                            // <#a>, <.b>, <:c>, concise #a
```

- `static`: the authored name with the head sugar removed. The written name
  (htmljs's `onOpenTagName` range) is split at its **first** `:`
  (`specification.md:724`; decision 146, 23:23 addendum): before it is
  `value`, from it on is a tag-position `MxShorthand { sigil: ":" }` (§3.6).
  `<input:email>` is `value: "input"`, `span` `[1, 6)`. So `value` never
  contains `:` (`divergences.md:130`). An empty part before the `:`
  (`<:email>`) makes the name `unnamed`. Marko splits attribute names at the
  **last** `:` (A2); that rule does not apply here. Attribute tags are not
  split (§3.7).
- `dynamic`: htmljs reports a `Template` (`[Hs]src/util/constants.ts:37-40`).
  `quasis` are its static parts' spans, `expressions` one container per
  `${…}` (span inside the braces), `expression` the whole name as one
  container: a Babel `TemplateLiteral`, or the single expression when both
  quasis are empty (Marko's rule, `[C]chunk-src.js:5954-5973`). `span` covers
  the written name, `${` and `}` included.
- `unnamed` (decision 145): `span` is empty, at the offset right after `<`
  (concise: at the first sugar character). Lowering resolves it through the
  `defaultTag` ladder (spec "The unnamed tag"); the AST never writes `div`.

Examples (`<input:email>`, `<${x}>`, `<.card>`): `static` `[1, 6)`;
`dynamic` `span` `[1, 5)`, `expression.span` `[3, 4)`; `unnamed` `[1, 1)`.

### 3.4 Head parts: `MxPattern`, `MxArguments`, `MxParameterList`, `MxTypeArguments`, `MxTypeParameters`

Each is an expression container (§4) with a specific Babel payload. One span
rule for all five: **`start`/`end` cover the text inside the delimiters
(htmljs's `value` range); `outer: Span` covers the delimiters too (htmljs's
event range)** (`Ranges.Value`, `[Hs]src/util/constants.ts:33-35`).

| Type | Source | Babel payload | Delimiters (`outer`) |
|---|---|---|---|
| `MxPattern` | `/x`, `/{ a, b }` | `LVal` | from `/` |
| `MxArguments` | `(a, ...b)` on a tag or an attribute | `(Expression \| SpreadElement)[]` | `(` `)` |
| `MxParameterList` | `\|a, b = 1\|` on a tag; `(a, b)` on a method | `FunctionParameter[]` | `\|` `\|` or `(` `)` |
| `MxTypeArguments` | `<string>` after a name | `TSTypeParameterInstantiation` | `<` `>` |
| `MxTypeParameters` | `<T>` before tag params or a method's params | `TSTypeParameterDeclaration` | `<` `>` |

For a method, htmljs's `AttrMethod.params` range includes the parentheses and
its `value` excludes them (`packages/parser/src/template/states/ATTRIBUTE.ts:242-262`
on `main`), so `MxParameterList` for `onInput(e) { … }` has span `(e)`'s
inside and `outer` the parenthesised text.

### 3.5 `MxAttribute`

Purpose: one named attribute, or the tag's default value.

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `name` | `string \| null` | no | authored name, colons included (`class:x`, `value:fn`); `null` for the default value (`<if=a>`) |
| `nameSpan` | `Span` | no | the name (`onAttrName`); zero-width at the `=`/`(` for the default value |
| `operator` | `"=" \| ":=" \| null` | no | `null` for a bare attribute or a method |
| `value` | `MxExpression \| MxMethod \| null` | no | `null` for a bare attribute (`disabled`) |
| `args` | `MxArguments \| null` | no | `name(args)` without a body (Marko's attribute arguments, `onAttrArgs`) |

Spans, one rule: `start = min(nameSpan.start, value?.start)` and `end =` the
end of `value`, of `args`, or of `nameSpan`, whichever is last. The `min`
matters for an `async` method, whose range starts at `async`, before the name
(`[Hs]src/util/constants.ts:51-53`; `ATTRIBUTE.ts:287-292` on `main`; probe:
`<div async onLoad<T>(e: T) { a() }/>` gives the method `1:5-1:34` and the
name `1:11`). For the default value, `start` is the `=` (or `(`) and
`nameSpan` is zero-width there (htmljs reports an empty `onAttrName` range).
For an expression value, `value.span` is htmljs's `AttrValue.value` (after
`=`/`:=` and whitespace, `ATTRIBUTE.ts:361-370`).

```mx
<input disabled type="email" value:=draft onInput(e) { set(e) }/>
```

Offsets:
- `disabled`: `[7, 15)`, `nameSpan` the same, `operator` and `value` `null`
- `type="email"`: `[16, 28)`; `nameSpan` `[16, 20)`; `value.span` `[21, 28)` (quotes included, as the IR's string spans)
- `value:=draft`: `[29, 41)`; `name: "value"`, `operator: ":="`; `value.span` `[36, 41)`
- `onInput(e) { set(e) }`: `[42, 63)`; `nameSpan` `[42, 49)`; `value` is an `MxMethod` `[49, 63)`

Invariants: `operator === ":="` implies `value` is an `MxExpression` (bound
attribute); `value.type === "MxMethod"` implies `operator === null`; a default
value is written at most once per tag (a second is a front-end
`MxParseError` `MX_DUPLICATE_DEFAULT`, which is also decision 146 addendum 4's
"error only if the tag already has a default value"). Bound attributes keep
their full name: `value:=x` is `name: "value"`, because htmljs reports `:=`
as the operator (`part.bound`, `[C]chunk-src.js:6127`).

### 3.5a `MxMethod`

Purpose: method shorthand, `name(params) { body }`, as an attribute value or a
sugar's default (`onAttrMethod`).

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `type` | `"MxMethod"` | no | |
| `async` | `boolean` | no | `async` was written before the name |
| `typeParams` | `MxTypeParameters \| null` | no | `<T>` before the params |
| `params` | `MxParameterList` | no | §3.4, span inside `(` `)` |
| `body` | `MxStatements` | no | span inside `{` `}`; `outer` includes the braces |
| `source` | `string` | no | `source.slice(start, end)` |

Spans: htmljs's `AttrMethod` range: from `async` when written, else from the
type parameters' `<`, else from `(`, through `}` (`ATTRIBUTE.ts:284-308` on
`main`). There is no Babel `FunctionExpression` in the AST; lowering builds
the one `Attr` needs from `params`, `typeParams` and `body` (Marko builds it in
the front end, `[C]chunk-src.js:6131-6138`).

Example: in `<b onInput(e) { set(e) }/>`, the method is `[10, 24)`,
`params` `[11, 12)` (outer `[10, 13)`), `body` `[15, 23)` (outer `[14, 24)`).

### 3.5b `MxSpreadAttribute`

Purpose: `...expr` in the attribute list (`onAttrSpread`).

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `type` | `"MxSpreadAttribute"` | no | |
| `value` | `MxExpression` | no | the expression after `...` |

Spans: `start` at the first `.`, `end` at the end of the expression
(`onAttrSpread` range, `ATTRIBUTE.ts:351-359` on `main`); `value.span` is the
expression only. Example: in `<b ...rest/>`, the node is `[3, 10)` and
`value.span` `[6, 10)`. Invariants: no name, no `nameSpan`, no sugar (IR spec
§6, `spread` row); it takes part in source order with the other attributes.

### 3.6 `MxShorthand` (`#id`, `.class`, `:name`)

Purpose: the three name sugars in any position (decision 146 and addenda).

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `sigil` | `"#" \| "." \| ":"` | no | which sugar |
| `position` | `"tag" \| "attribute"` | no | tag-adjacent (in `MxTag.shorthands`) or in the attribute list |
| `value` | `MxShorthandValue` | no | the part after the sigil |
| `default` | `MxExpression \| MxMethod \| null` | no | decision 146 addendum 4: `#name=expr` or `#name(params) { body }` sets the tag's default value |

```ts
type MxShorthandValue =
  | { kind: "static"; value: string; span: Span }
  | { kind: "dynamic"; template: MxExpression; quasis: Span[];
      expressions: MxExpression[]; span: Span };   // tag position only: <div.a${x}>
```

Spans: `start` = the sigil; `end` = end of `value` (not of `default`, which has
its own span). `value.span` excludes the sigil.

What each sigil takes (`specification.md:713-718`): `:name` an identifier,
`[A-Za-z_$][\w$-]*`; `#x` and `.x` what Marko's shorthand takes, a run up to
whitespace, `=`, `(`, `/`, `|`, `<`, `,` or `>`, with `.` and `#` starting the
next part.

**Splitting a shorthand value.** htmljs reports a tag-adjacent `#d:b` as **one**
`onTagShorthandId` `Template` (reviewer's probe: `[4, 8)` for `<a.c#d:b …>`),
and an attribute-position `#x`/`.x`/`:x` as an attribute name. The front end
splits each into `MxShorthand`s (`specification.md:724-728`):

1. Static value: split at its **first** `:`. `.c:b` gives `.c` and a
   tag-position `:b`. A second `:` anywhere in the tag head is an
   `MxParseError` `MX_SECOND_NAME` at the second `:` (spec: "a tag takes one
   name").
2. Dynamic value: only the static tail after the last `${…}` splits.
   `<a.${x}:b>` gives `.` with a dynamic value (`template` over `${x}`) and a
   static `:b`.
3. A `:` in a static part **before** a `${…}` (`<a.c:b${x}>`) is an
   `MxParseError` `MX_COLON_BEFORE_DYNAMIC` at that `:`.
4. A value left empty by a split (`<a.:b>`) produces no `MxShorthand` for that
   sigil (`name-sugar.ts:831-842`).

```mx
<a.c#d:b title="t" .big :mail/>
```

Offsets:
- tag position: `.c` `[2, 4)` (`value.span` `[3, 4)`), `#d` `[4, 6)`, `:b` `[6, 8)` (split out of htmljs's `#d:b` `[4, 8)`)
- attribute position: `.big` `[19, 23)`, `:mail` `[24, 29)`
- `<a.${x}:b>`: `.` `[2, 7)` with `value.span` `[3, 7)` and `template.span` `[5, 6)`; `:b` `[7, 9)`

Invariants: a tag has at most one `:` sugar in its head; `value.kind ===
"dynamic"` implies `position === "tag"`; order within `shorthands` and within
`attributes` is source order, so the spec's class-order rule can be applied by
lowering without positions. Atoms: `:name` standing alone in attribute
position **is** this node (decision 156 §4); `:name` inside an expression is
an `MxAtom` (§4.3).

### 3.7 `MxAttributeTag`

Purpose: `<@name>` — a property of the nearest enclosing tag.

Fields: the same as `MxTag` (§3.2) except `name`, which is `{ value: string;
span: Span }`: `value` is the key without `@`, `span` covers `@name` as
written (Marko's name `loc` does the same; probe: `StringLiteral@1:7-1:12` for
`@head`). Head sugar is **not split**: `<@svg:rect>` keeps `value:
"svg:rect"` (decision 146 addendum 3); attribute-position sugar applies.

Example: in `<Card><@head x=1>H</@head></Card>` the attribute tag is
`[6, 26)`, `name.span` `[7, 12)`, `name.value` `"head"`, and it is `body[0]` of
`Card`.

Invariants: always somewhere under an `MxTag` (Marko throws "@tags must be
nested within another element", `[C]chunk-src.js:5917`; MX records an
`MxParseError` `MX_ATTRIBUTE_TAG_AT_ROOT` and keeps the node); never moved: an
`<if>` holding attribute tags keeps them in its own `body` (§8 D2).

### 3.8 `MxText`

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `value` | `string` | no | in a `"html"` or `"parsed-text"` body: normalized by Marko's rule (`[C]chunk-src.js:5991-6036`, spec §3 "Whitespace"); in a `"preserve"` or `"parsed-text-preserve"` body: the authored text unchanged, as Marko does when `preserveWhitespace` is on (`[C]chunk-src.js:5987-5989`) |
| `raw` | `string` | no | `source.slice(start, end)` |

Spans: Marko's: in a normalizing body, the authored text left after the
newline-led runs at each end are trimmed, before inner collapsing
(`[C]chunk-src.js:6029-6033`); in a preserving body, the whole run. This keeps
the IR's `Text.span` exactly what it is today (decision 158 requires every
golden byte-identical). Concise `--` text lines produce `MxText` too, starting
after `-- `.

Examples: `<p>  a\n  b</p>` gives `value: " a b"`, span `[3, 10)`;
`<pre>  a\n  b</pre>` gives `value: "  a\n  b"` (probe: Marko keeps the
newline and the spaces for `<pre>`, which `marko-html.json` marks
`preserveWhitespace`, `[C]chunk-src.js:3606`).

Invariant: in a normalizing body, a run that normalizes to `""` produces no
node; `raw` is never empty.

### 3.9 `MxPlaceholder`

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `escape` | `boolean` | no | `false` for `$!{…}` |
| `expression` | `MxExpression` | no | the expression |

Spans: `start` at `$`, `end` after `}`; `expression.span` inside the braces.
Source forms: `${x}` in HTML content, in parsed-text bodies (`<script>`: the
probe shows a `MarkoPlaceholder` inside `<script>`), and a bare `${expr}`
concise line.

Example: in `<p>$!{html}</p>` the placeholder is `[3, 11)` with `escape:
false`; `expression.span` `[6, 10)`.

### 3.10 `MxModuleStatement`, `MxScriptlet`, `MxStatements`

`MxModuleStatement` — `import`, `export`, `static`, `server`, `client`,
`class` written as a concise top-level line.

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `type` | `"MxModuleStatement"` | no | |
| `keyword` | `"import" \| "export" \| "static" \| "server" \| "client" \| "class"` | no | the first word |
| `code` | `MxStatements` | no | the whole statement for `import`/`export`/`class`, the part after the keyword for `static`/`server`/`client` |

Spans: `start` at the keyword; `end` at the end of the statement, line
terminator excluded (the IR already trims it, `lower.ts:2139-2150`).

Example: `static const GREETING = "Welcome"` is `[0, 33)`; `keyword` `[0, 6)`;
`code.span` `[7, 33)`.

Invariants: only in `MxDocument.body`; `export interface Input` is an
`MxModuleStatement { keyword: "export" }` whose payload is a
`TSInterfaceDeclaration` (the IR's `InputInterface` split is a lowering rule,
`lower.ts:2202-2204`). The keyword list is the one the front end recognizes;
it is the statement entries of `core-tags.json:75-90`.

`MxScriptlet` — `$ stmt` and `$ { block }`.

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `type` | `"MxScriptlet"` | no | |
| `block` | `boolean` | no | `$ { … }` form (htmljs reports it, `[Hs]src/states/INLINE_SCRIPT.ts:37-40`; Marko ignores it) |
| `code` | `MxStatements` | no | the statements (inside the braces for the block form) |

Spans: from `$` to the end of the statement or `}`. Example: `$ const z = 1;`
is `[0, 14)`, `code.span` `[2, 14)`. MX rejects scriptlets (decision 54,
`lower.ts:3339-3343`); the node exists so the error is positioned.

`MxStatements` — the expression container (§4) for statements:
`MxExpressionContainer<Statement[]> & { type: "MxStatements" }`. Span: the
statement text only; for a method body or a scriptlet block, inside the
braces, with `outer` including them. Used by `MxModuleStatement.code`,
`MxScriptlet.code`, `MxMethod.body`.

### 3.11 `MxComment`, `MxCDATA`, `MxDoctype`, `MxDeclaration`

| Node | Fields | Span |
|---|---|---|
| `MxComment` | `kind: "html" \| "line" \| "block"`, `value: string` (delimiters stripped), `valueSpan: Span` | delimiters included |
| `MxCDATA` | `value`, `valueSpan` | `<![CDATA[` through `]]>` |
| `MxDoctype` | `value` (e.g. `"doctype html"`, as Marko), `valueSpan` | `<!` through `>` |
| `MxDeclaration` | `value` (e.g. `"xml v"`), `valueSpan` | `<?` through `?>` |

Each of the four has `type` equal to its name (`MxNodeBase`, §3.0).

Examples: `<!-- a -->` is `[0, 10)`, `valueSpan` `[4, 7)`; `<![CDATA[ d ]]>`
is `[0, 15)`, `valueSpan` `[9, 12)`; `<!doctype html>` is `[0, 15)`,
`valueSpan` `[2, 14)`; `<?xml v?>` is `[0, 9)`, `valueSpan` `[2, 7)`.

`MxComment` also appears in `MxTag.attributes` for an open-tag comment
(`onOpenTagComment`). Invariant: `value === source.slice(valueSpan.start,
valueSpan.end)`.

### 3.12 Body modes and `tagShape`

`MxTag.bodyMode` records the parse shape `tagShape(name)` answered at
`onOpenTagName` (the value the front end returns to htmljs as a `TagType`,
`[H]util/tag-type.d.ts`):

| `bodyMode` | htmljs `TagType` | Text handling | Answered for |
|---|---|---|---|
| `"html"` | `html` | normalized | everything not listed below |
| `"parsed-text"` | `text` | normalized | `parseOptions.text` without `preserveWhitespace` (`<html-comment>`, `core-tags.json`) |
| `"parsed-text-preserve"` | `text` | authored | `text` + `preserveWhitespace`: `<script>`, `<style>`, `<textarea>` (`[C]chunk-src.js:3645-3747`), `<html-script>`, `<html-style>` (`core-tags.json`) |
| `"preserve"` | `html` | authored | `preserveWhitespace` alone: `<pre>` (`[C]chunk-src.js:3606`); a custom tag's `parseOptions.preserveWhitespace` (`custom-tags.ts:474-478`) |
| `"void"` | `void` | — | `openTagOnly` **as the parser receives it today**: the HTML/SVG/MathML void elements of Marko's built-in taglibs (`marko-html.json` starts at `[C]chunk-src.js:3057`; e.g. `<area>` at `:3110`) and the core tags marked `openTagOnly` (`<let>`, `<const>`, `<id>`, `<lifecycle>`, `<log>`, `<debug>`, `<return>`, `core-tags.json`) |

Preserving mode lasts until the tag that started it closes, and applies to
every descendant text (Marko's `preservingWhitespaceUntil`, set at
`[C]chunk-src.js:6082` and cleared at `:6185`).

A custom tag's `openTagOnly` is **not** a parse shape: core forwards only `text`
and `preserveWhitespace` to the parser (`custom-tags.ts:474-485`) and enforces
`openTagOnly` in lowering with a positioned call-site error
(`specification.md:2270`). `tagShape` never answers `"void"` for a custom tag.

`bodyMode` is a parse fact, not the IR's `Element.void`: lowering keeps taking
`Element.void` from `VOID_TAGS` (`core/src/core.ts:162`, read at
`lower.ts:3148`; IR spec §5.5).

Invariant: in a `parsed-text*` body no `MxTag` appears; `<x>` inside
`<script>` is text (probe: `MarkoText " <x>"`).

### 3.13 `MxParseError` and what a failed parse contains

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `type` | `"MxParseError"` | no | |
| `code` | `string` | no | a stable code: htmljs codes by name (`INVALID_ATTRIBUTE_VALUE`, `MISMATCHED_CLOSING_TAG`, … `[H]util/error-code.d.ts`, 31 codes, 0-30), `BABEL_<reasonCode>` for an expression sub-parse failure, `MX_<NAME>` for front-end rules |
| `source` | `"template" \| "expression" \| "front-end"` | no | which of the three produced it |
| `message` | `string` | no | one line, no code frame, no ANSI |
| `span` | `Span` | no | `start`/`end` of the node: what to underline; for an expression error the precise point when Babel reports one (Marko's `errorLoc`, bounded to the source range as `getBoundedRange` does, `[C]chunk-src.js:1040-1050`) |
| `context` | `Span \| null` | no | the whole construct when it differs from `span` (Marko's `source` range) |

Three producers, with different consequences:

1. **The template parser (htmljs) stops at its first error.**
   `Parser.emitError` calls `onError` and then sets `this.pos = this.maxPos +
   1` (`packages/parser/src/template/core/Parser.ts:171-188` on `main`;
   `[Hs]src/core/Parser.ts`), and `parse` loops `while (this.pos <= maxPos)`
   (`Parser.ts:299-301`), so no event follows `onError`: no close events for
   open tags, no further text. One parse therefore yields **at most one**
   template error. (Marko throws on it, `[C]chunk-src.js:5975-5984`, so MX
   today gets no tree at all.)
2. **Expression sub-parses** fail per container and do not stop the template
   parse (Marko's `tryParse` returns a `MarkoParseError` and continues,
   `[C]chunk-src.js:1009-1015`). There may be any number. When an attribute
   value written `{ … }` fails and parses once the braces are removed, the
   message gets Marko's hint "Attribute values in Marko are plain JavaScript
   expressions, not JSX; remove the wrapping `{ }`" (`withWrappedAttrValueHint`,
   `[C]chunk-src.js:6292-6297`), reworded for MX ("… in MX …").
3. **Front-end rules** (`MX_*`: second `:` name, `:` before `${…}`, statement
   tag in HTML mode, `<%`, attribute tag at the root, duplicate default value)
   are recorded and do not stop the parse.

**What the AST contains when the template parser reports an error** (from the
parser code above, not from what would be desirable):

- `MxDocument.complete` is `false`; `errors` ends with the template error.
- Every node whose closing event arrived before `onError` is complete and
  exact.
- Every tag still open at that point (the error's ancestors) exists with
  `incomplete: true`, `closeTag: null`, and `end` = the error's `start`; its
  `body` holds the children completed before the error.
- The construct the parser was inside exists only as far as its events
  arrived: htmljs emits each attribute part when that part ends and a text run
  when the next construct starts, so an attribute whose `onAttrName` arrived
  but whose value did not is an `MxAttribute` with `value: null`, and a text
  run pending at the error is absent. A consumer tells such a part from a
  genuine bare attribute only by the error's `start` falling inside the tag's
  head; the front end does not mark it.
- Nothing exists at or after the error's `start`.

What a consumer such as the language server may rely on: the template error's
`code`, `message` and `span`; every expression and front-end error before it;
and every complete node. It must not rely on the shape of an `incomplete`
tag's head or body beyond what is listed, and it gets no diagnostics for the
text after the error. Recovery (more than one template error per parse) is a
parser change; it is open question Q20 for mx-lead and the parser's owner, not
a property of this AST.

Examples: `<div x=(1 +)/>` gives a complete tree, one error `source:
"expression"`, `span` `[11, 11)`, `context` `[7, 12)`, and the attribute's
`value` container has `node: null`. `<div></span>` gives `errors` `[{ code:
"MISMATCHED_CLOSING_TAG", span: [5, 12) }]` (reviewer's probe: `onError
[5,12)/21`), `complete: false`, and one `MxTag` `div` `[0, 5)` with
`incomplete: true`.

When the error replaces an expression, the container's `node` is `null` and
its `error` is the same object as the entry in `errors` (§4).

### 3.14 `MxReturn`

Purpose: `<return=x/>` / `<return value=x/>` (decision 155, spec §10).

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `value` | `MxExpression \| null` | no | from the default value or a `value=` attribute; `null` when neither was written |
| `tag` | `MxTag` | no | the full tag as parsed, so lowering keeps its eleven shape errors (`lower.ts:2279-2330`) |

Spans: those of `tag`. Example: `<return=x/>` is `[0, 11)`, `value.span`
`[8, 9)`. Invariant: the front end produces `MxReturn` for every
tag whose static name is `return`; shape validation (no body, no spread, one
value, top level only, one per template) stays in lowering, as today.

### 3.15 Things that are not nodes

- **Wildcard children** (decision 147) have no syntax: a child tag keeps its
  authored name (`MxTagName.static`), and matching it against `children["*"]`
  patterns is contract validation in lowering. The AST's contribution is the
  invariant that a name is never rewritten and always has a span.
- **`defaultTag`** (decision 145): `MxTagName.unnamed`; the ladder is
  lowering's.
- **Structural tags** (`if`, `else`, `for`, `const`, `define`, `try`, …) are
  `MxTag`s: their meaning is resolution, and a file-local binding can shadow a
  name (spec §7). Only `<return>` gets its own node, because decision 158
  names it.

## 4. Expressions

### 4.1 The contract

Every field that holds embedded TypeScript is an **expression container**:

```ts
interface MxExpressionContainer<N> extends Span {
  source: string;            // the authored text, source.slice(start, end)
  outer: Span;               // the span with the position's delimiters (§3.4); equal to the span when none
  node: N | null;            // the Babel payload; null when the parse failed
  error: MxParseError | null;
  atoms: MxAtom[];           // §4.3, empty when none
}
type MxExpression    = MxExpressionContainer<Expression>   & { type: "MxExpression" };
type MxStatements    = MxExpressionContainer<Statement[]>  & { type: "MxStatements" };
type MxPattern       = MxExpressionContainer<LVal>         & { type: "MxPattern" };
type MxArguments     = MxExpressionContainer<(Expression | SpreadElement)[]> & { type: "MxArguments" };
type MxParameterList = MxExpressionContainer<FunctionParameter[]> & { type: "MxParameterList" };
type MxTypeArguments = MxExpressionContainer<TSTypeParameterInstantiation> & { type: "MxTypeArguments" };
type MxTypeParameters = MxExpressionContainer<TSTypeParameterDeclaration> & { type: "MxTypeParameters" };
```

- **Span** is on the original file (§5), exactly the characters the author
  wrote for this position, delimiters excluded.
- **`node`'s own positions are file-relative**: the sub-parse is given the
  container's `start`, line and column, as Marko already does with
  `startIndex`/`startLine`/`startColumn` (`[C]chunk-src.js:988-1003`). A
  wrapper prefix (`(…)=>{}`, `_(…)`) is compensated the same way Marko's
  `sourceOffset` does (956-983), so `node.start === container.start` for an
  expression.
- **`source`** is kept because lowering prints the authored slice, not the
  generated AST, so TypeScript type arguments survive (`core/src/core.ts:617-633`,
  `expr()`; IR spec §4, `code` row).
- **`node` is Babel-shaped and carries `loc`.** The IR spec requires a
  lowering to supply `Expr.node` "positioned, for every authored expression",
  with `loc.start`/`loc.end` as `{ line, column, index? }` (IR spec §4, `node`
  row), because three emitter-side consumers still read it: the TypeScript
  plugin maps through `node.loc` (`packages/tooling/typescript-plugin/src/mx-language.ts:689`),
  Angular's tag module walks `node` and regenerates `code` from it
  (`packages/hosts/angular/src/tag-module.ts:609-613`), and Preact reads a
  `by=` key's `node.value` (`packages/hosts/preact/src/emitter.ts:1817-1818`).
  `For.paramNodes` must also be positioned parser nodes (IR spec §5.9, E11;
  Angular reads them, `packages/hosts/angular/src/emitter.ts:2171-2180`). So
  until mx-lead moves those consumers to `Expr.span`/`Expr.code`, the Babel
  payload of every container keeps Babel's `start`, `end` **and** `loc` with
  `index`, all file-relative. This is the one place the AST stores `loc`
  (§5.1): inside Babel payloads, never on `Mx*` nodes.

### 4.1a Sharing and copying

Emitters mutate the IR: Solid appends to `For.bindings` and rewrites `code`
in place (`packages/hosts/solid/src/emitter.ts:1761`), Angular's tag module
replaces `input.x` members inside `Expr.node` in place by deleting their keys
(`packages/hosts/angular/src/tag-module.ts:592-596`) and regenerates `code`
(`:609-613`), and the IR spec forbids a lowering to share one `Expr` between
two scopes (IR spec §10.2, E21). For the AST this means:

- **Containers never share.** Two containers never hold the same Babel node
  or the same position object; two textually identical expressions get two
  containers and two Babel trees. Inside one payload Babel itself may share a
  position object between a parent and a child at a coincident boundary
  (`ir.ts:88-91`); the copy below makes that harmless.
- **The AST is read-only to lowering.** Lowering must not mutate an `Mx*`
  node or a container's Babel payload.
- **Lowering copies every parser node it puts in the IR.** Exactly two IR
  fields carry a parser node: `Expr.node` and `For.paramNodes` (`ir.ts:78`,
  `:324`, `:495`; `paramNodes` also inside `ForHead` for `AttributeTagFor`).
  Each gets its own copy of the AST payload, made at the point the `Expr` or
  the `For` head is created. The copy is required because one AST is lowered
  more than once: the custom-tag `analyze` pre-walk lowers the whole body on a
  scratch `Ctx` before the real walk (IR spec §1, step 3), and a tool may
  lower the same parse for several hosts.

**The copy procedure.** `copy(v)`: a primitive is returned as is; an array is
mapped through `copy`; an object with numeric `line` and `column` (a Babel
position) becomes a new `{ line, column }` plus `index` when the source has
one; any other object becomes a new object with every own enumerable key of
the source copied through `copy`, including `type`, `start`, `end`, `loc`,
`extra`, `range` and the comment arrays.

What each consumer needs, and why the procedure keeps it:

| Consumer | Reads | Kept because |
|---|---|---|
| TypeScript plugin | the root node's `loc.start`/`loc.end` `{ line, column }`, then checks `source.slice(…) === code` (`mx-language.ts:689-694`, `offsetAt` at `:722-731`) | `loc` is copied value for value, so the slice and the mapping are identical |
| `expr()` / lowering's slice | `node.start ?? node.loc?.start.index`, `node.end ?? …` (`core.ts:617-619`) | `start`/`end` are copied (so the same branch is taken as today) |
| Angular tag module | mutates the copy in place | every object in the copy is new, so the AST and any other `Expr` are untouched |
| Preact `by=` | `node.type`, `node.value` (`preact/src/emitter.ts:1817-1818`) | primitives copied |
| Angular `$index` alias | `For.paramNodes[i]` structure (`angular/src/emitter.ts:2171-2180`) | same procedure, per param node |

`@babel/types`' `cloneNode` does **not** satisfy this: it copies only the
declared fields, never `start`/`end`, and assigns `newNode.loc = node.loc`,
sharing the position objects (`[C]babel.js:13217-13241`). A structured clone
(`structuredClone`) would satisfy it for plain Babel data and is an acceptable
implementation of `copy`.

### 4.2 Compared with the IR's `Expr`

`Expr` is `{ code, shape, node, span?, file? }` (`packages/core/src/ir.ts:75-108`;
normative contract in the IR spec §4, `apps/docs/docs/architecture/ir-spec.md`
on `main` at `4053b158`, not on this branch's base).

| `Expr` | Expression container | Difference |
|---|---|---|
| `code` | `source` | `code` is after binding rewrites (decision 70); `source` is authored. Lowering produces `code` from `source` + `node`, as `expr()` does today. |
| `shape` | derived from `node.type` | `expressionShape` (`lower.ts:249-261`) stays in lowering. |
| `node` | `node` | `Expr.node` is a positioned **copy** of the container's payload (§4.1a); `null` on a synthesized `Expr` per IR spec §2.2 (but see Q14) |
| `span?` | `start`/`end` (required) | lowering writes `{ sourceStart: start, sourceEnd: end }`; same range, same units (IR spec §3.2). For a string literal the span includes the quotes in both (IR spec §3.3) |
| `file?` | (document level) | a container never names another file |

### 4.3 `MxAtom`

Decision 156: `:name` in an expression position is an atom. The container
lists each atom found in its `source`:

```ts
interface MxAtom extends Span { type: "MxAtom"; name: string }  // span covers ':' and the name
```

The Babel payload holds the atom as a `StringLiteral` with `extra.mxAtom =
true` at the same span, so every Babel-based consumer sees a string (the
approach measured in `scratch/reports/squad-atoms/parser-approach.md`, §1 and
§2). `::name` is an `MxParseError` (reserved, decision 156 §5).

Offsets: atom `title` `[15, 21)`, atom `rename-all` `[23, 34)` (the `:` included).

## 5. Positions

### 5.1 The rule

Every MX node has `start` and `end`: **0-based offsets into the original file,
in UTF-16 code units, half-open `[start, end)`** — the unit of a JavaScript
string index, which htmljs-parser already reports (`Range.start`/`end`,
`[Hs]src/util/constants.ts:22-31`) and which the IR's `SourceSpan` uses
(`packages/core/src/mapping.ts:4-7`, documented as UTF-16 in
`packages/core/src/fragment.ts:117-122`). This is the IR spec's `SourceSpan`
rule exactly: half-open, UTF-16, file-absolute, CRLF's `\r` belonging to its
line, `source.slice` yielding the authored text (IR spec §3.2). No `Mx*` node
stores `loc`; the Babel payloads inside containers do, for the reason in §4.1.

What lowering derives: every IR node's `loc` is the **start** of the construct
as a 1-based line and 0-based column (IR spec §3.1), which is
`lineColumnAt(node.start)`; the statement kinds' `end: Position` is
`lineColumnAt(node.end)`; each IR span is the AST span of the node or sub-part
the IR spec's §3.3 table names (for example `Attr.nameSpan` ←
`MxAttribute.nameSpan`, zero-width at the `=` for the default value, which is
invariant E7; `Interpolation.span` ← `MxPlaceholder` span, delimiters
included; `Element.nameSpan` ← `MxTagName.span`, and for an attribute tag the
name **after** the `@`, IR spec §3.3, so lowering trims one unit off
`MxAttributeTag.name.span`).

### 5.2 Line and column

Obtained on demand from the document: `MxDocument` keeps (or lazily builds) a
line-start index, one entry per `\n`, as htmljs's `getLines` does
(`[Hs]src/util/util.ts:55-64`). `lineColumnAt(offset)` returns a **1-based
line and 0-based column** (Babel's convention, and what `TranslateError` and
the spec's structured fields carry, `apps/docs/docs/specification.md:2667-2672`
and `:2705-2711`). htmljs's own positions are LSP-style, 0-based line and
`character` (`[Hs]src/util/constants.ts:4-14`); Marko adds 1 to the line
(`toBabelPosition`, `[C]chunk-src.js:6300-6303`), and MX does the same. A `\r`
is an ordinary column character (only `\n` starts a line), as in htmljs.

### 5.3 Fragments

A fragment parse takes `base = { offset, line, column }` with the meanings of
today's `FragmentBase` (`baseOffset`, zero-based `baseLine`, zero-based
`baseColumn`; `fragment.ts:88-175`) and its invariants (`baseOffset ===
baseColumn` on line 0; `baseOffset >= baseLine + baseColumn` otherwise).

- Every offset is `base.offset + local offset`, at creation; there is no
  post-hoc walk (today's `shiftNode`, `fragment.ts:229-264`, and its
  shared-position dedupe both disappear).
- `lineColumnAt` adds `base.line` to the line and, on the fragment's first
  line only, `base.column` to the column.
- A Babel sub-parse receives `startIndex = base.offset + local start`,
  `startLine = 1 + base.line + local line`, `startColumn` = local column plus
  `base.column` when on the first line. This is what `parseFragmentNative`
  already demonstrates through Marko's offset options (`fragment.ts:440-470`).

The IR spec states the required result, not the mechanism: "every `loc` and
every span in the IR is measured against the enclosing file", and a new
lowering over its own parser "has no reason to reproduce the shift mechanics"
(IR spec §3.4). Offsets at creation satisfy that. Parse errors are data
(§3.13), so the separately-shifted thrown error of today disappears too.

## 6. Mapping to the IR

IR kinds on `main`: `packages/core/src/ir.ts:396-628` defines **16** `IrNode`
kinds (Text, Interpolation, Element, Component, IfChain, For, Define, Const,
Static, Import, Export, InputInterface, Hoisted, DelegatedTag, DocumentType,
Comment), plus `Attr` (`:135-204`), `AttributeTag` (`:305-319`), `Block`
(`:215-220`) and the `Ir` root (`:631-681`). The IR spec lists the same 16
kinds (IR spec §5.2) and is the reference for every field below.

**Where the AST enters the IR spec's pipeline.** The IR spec's step 1 (tree
rewrites before any tag name is read) turns sugar into `name`/`id`/`class`
attributes and resolves the unnamed tag, and says "a new parser may produce
that tree directly; it must not hand an unnamed tag to the walk" (IR spec §1).
The MX AST deliberately does **not** produce that tree: it keeps
`MxShorthand` and `MxTagName.unnamed`, because the default-tag ladder needs
the host's `resolveDefaultTag` and the ancestor chain, which a parser does not
have. Step 1 therefore stays in lowering and reads the AST: each
`MxShorthand` becomes an `Attr` with `sugar` set to its token, and each
unnamed name is resolved before step 5. Steps 2 to 6 are unchanged.

### 6.1 IR kind ← AST

| IR | Lowered from | Fields |
|---|---|---|
| `Text` | `MxText`; also the empty `Text` `<return>` leaves (`lower.ts:2327-2329`) | `value` ← `value`; `span` ← node span |
| `Interpolation` | `MxPlaceholder` | `expr` ← `expression`; `escaped` ← `escape`; `span` ← node span |
| `Element` | `MxTag` resolved to a native element | `name` ← `name` (static, or unnamed after the ladder); `nameSpan` ← `name.span`; `attrs` ← `attributes` + `shorthands`; `children` ← `body`; `void` ← `VOID_TAGS` in lowering (`core.ts:162`, `lower.ts:3148`), not `bodyMode` (§3.12) |
| `Component` | `MxTag` resolved to an import, discovered tag, `<define>` or dynamic name | `target` ← `name`; `args` ← `args`; `var` ← `var`; `content.params` ← `params`; `attributeTags*` ← `MxAttributeTag` children (and those inside `if`/`for` children); `content` ← the other children |
| `IfChain` / `Branch` | consecutive `MxTag`s `if`, `else-if`/`else if`, `else` | `condition` ← the default value `MxAttribute.value` |
| `For` | `MxTag` `for` | `source` ← `of`/`in`/`from`/`to`/`until`/`step` attributes; `key` ← `by`; `params`, `paramNodes`, `paramSpans` ← `params` |
| `Define` | `MxTag` `define` | `name` ← `var`; `params` ← `params` |
| `Const` | `MxTag` `const` | `name` ← `var`; `init` ← default value |
| `Static` | `MxModuleStatement` `static` (and `server` on html, spec §2) | `code` ← `code.source`; `span` ← node span |
| `Import` | `MxModuleStatement` `import` | `code`, `bindings` ← parsed `ImportDeclaration` (no regex) |
| `Export` | `MxModuleStatement` `export` | `code` |
| `InputInterface` | `MxModuleStatement` `export` with an `Input` interface/type | `code` |
| `Hoisted` | none (a host hook's output, decision 70) | — |
| `DelegatedTag` | `MxTag` claimed by the host (`isDelegatedTag`) | as `Element`, plus `args`, `var`, `params`, attribute tags |
| `DocumentType` | `MxDoctype` | `value` |
| `Comment` | `MxComment` | `value`; `html` ← `kind === "html"` |
| `AttributeTag` | `MxAttributeTag` | `name`, `nameSpan`, `attrs`, `block.params` ← `params` |
| `Attr` `static` | `MxAttribute` with a string-literal value; `MxShorthand` with a static value | `valueSpan` ← `value.span` |
| `Attr` `static`, `value: ""` | `MxAttribute` with a colon name and `value === null` (an explicit valueless `value:foo`; IR spec §6 `static` row) | `valueSpan` ← zero-width at `nameSpan.end` (IR spec §3.3) |
| `Attr` `boolean` | `MxAttribute` with `value === null` | |
| `Attr` `dynamic` / `event` | `MxAttribute` with an expression value or `MxMethod` | `event` derived from `name` (lowering) |
| `Attr` `bound` | `MxAttribute` with `operator === ":="` | |
| `Attr` `spread` | `MxSpreadAttribute` | |
| `Attr.sugar` | `MxShorthand` | ← the authored token, `source.slice(start, end)` |
| `Ir.returnValue` | `MxReturn.value` | |

### 6.2 AST node → IR consumers

| AST | IR kinds that consume it |
|---|---|
| `MxDocument` | `Ir` |
| `MxTag` | Element, Component, IfChain/Branch, For, Define, Const, DelegatedTag, or an error |
| `MxAttributeTag` | AttributeTag (and `attributeTagTree`, `attrTagProps`) |
| `MxReturn` | `Ir.returnValue` (+ an empty Text) |
| `MxAttribute`, `MxShorthand`, `MxSpreadAttribute`, `MxMethod` | Attr |
| `MxText` | Text |
| `MxPlaceholder` | Interpolation |
| `MxModuleStatement` | Import, Export, Static, InputInterface, or an error (`client`, `class`) |
| `MxComment` | Comment (body); none (open-tag position) |
| `MxDoctype` | DocumentType |
| `MxScriptlet`, `MxCDATA`, `MxDeclaration` | none: errors (`lower.ts:3339-3359`) |
| `MxParseError` | none: a diagnostic |
| `MxAtom` | none on `main` (see below) |

### 6.3 Gaps

The IR needs, and the AST as drafted does not carry:

- **Resolution facts**: which tag is native, a component, a define, a custom
  tag; the binding registry; `Element.void` for targets whose void list differs
  from the parse shape. These are lowering's by design.
- **`Expr.code` after rewrites** and `ExprShape`: derived in lowering from
  `source` + `node`.

The AST carries, and no IR kind reads:

- `MxComment.kind` `line` vs `block` (IR has only `html: boolean`), and
  open-tag comments.
- `typeArgs`, `typeParams` (rejected today, `core.ts:1127-1132`).
- `MxTag.openTag`/`closeTag` spans, `concise`, `selfClosed` (tools only).
- `MxCDATA`, `MxDeclaration`, `MxScriptlet` (errors only).
- `MxAtom`: decision 156 §1 names an IR node `atom { name, span }`, but
  `ir.ts` on `main` has none (`rg -i atom packages/core/src/ir.ts` returns
  nothing). See Q3.

### 6.4 Who sees the AST and who sees the IR

| Extension point | Sees | Evidence |
|---|---|---|
| Custom-tag sidecars, L2 hooks (decision 87) | IR: a `TagCall` of `Attr[]`, `Block`, `AttributeTag[]` | `packages/core/src/custom-tags.ts:124-141` |
| Sidecar `parseOptions` | neither; they configure the parse | `custom-tags.ts:460-485` (only `text`, `preserveWhitespace` reach the parser) |
| L3 raw hooks (decision 87(b): Marko's exact signatures, MX 1 only) | would see Marko's AST; **not implemented** | no `raw` field in `custom-tags.ts` (the only `raw` match is a comment at `:417`) |
| User tag macros (decision 80) | IR in, IR out, by design | decision 80 text |
| Host **emitters** (`Emitter<Out>`), first- and third-party (decision 148) | IR only | `packages/core/AGENTS.md:9-10` ("A host then emits from that IR and never walks a Marko node"); IR spec §5.13 |
| Host **declarations** (`HostDeclarations` hooks), first- and third-party | **parser nodes**, today Marko's | the table below |
| The data target's unknown-tag scan (first-party) | Marko's AST directly | `packages/targets/data/src/scan.ts:140-175` |

The `HostDeclarations` hooks that receive a parser node
(`packages/core/src/declarations.ts`), and what each receives after the port:

| Hook | Line | Receives today | Receives after the port | Known readers |
|---|---|---|---|---|
| `resolveDelegatedTag(name, node, ctx)` | 156-160 | `MarkoTag` | `MxTag` | html reads `node.name` (`targets/html/src/translate.ts:429-445`); Preact passes it to `rawFail` (`hosts/preact/src/emitter.ts:216-226`) |
| `rejectModifier(attr, on)` | 169 | `MarkoAttribute` | `MxAttribute` | Preact reads `attr.name` and **`attr.modifier`** (`hosts/preact/src/emitter.ts:227-246`) |
| `resolveModifier(attr, on)` | 177-180 | `MarkoAttribute` | `MxAttribute` | |
| `rejectAttributeMethod`, `resolveAttributeMethod` | 189, 220 | `MarkoAttribute` | `MxAttribute` | |
| `resolveDefaultTag(node, parents, context)` | 214-218 | `MarkoTag` (+ `DefaultTagParent.node`, `:30-36`) | `MxTag` | |
| `rejectElementAttributeTags`, `rejectComponentTag`, `rejectUnknownTag` (`name, node, ctx`) | 229, 240, 268 | `MarkoTag` | `MxTag` | |
| `checkBinding(target, what)` | 293 | a Babel `LVal` | the `MxPattern` payload | |

Every host `fail`/`rawFail(msg, node)` reads the node's position; after the
port it takes an `Mx*` node and reports `lineColumnAt(node.start)`.

Consequence: `MxAttribute` has no `modifier` (A2, D4), so Preact's
`rejectModifier` would print `undefined:undefined` unless it is re-typed to
read `attr.name` alone (which already holds `class:x`). Re-typing the
declarations is open question Q19.

## 7. Mapping from parser events

htmljs-parser 5.18.0 defines 27 handlers (`[H]util/constants.d.ts:64-90`;
source `[Hs]src/util/constants.ts:79-105`).

| Event | Payload | MX node or field |
|---|---|---|
| `onText` | `Range` | `MxText`; normalized with lookahead as Marko, except in a preserving body (§3.8, §3.12) |
| `onPlaceholder` | `Placeholder { value, escape }` | `MxPlaceholder` |
| `onComment` | `Value` | `MxComment` (kind from the source, as `getCommentKind`) |
| `onCDATA` | `Value` | `MxCDATA` |
| `onDeclaration` | `Value` | `MxDeclaration` |
| `onDoctype` | `Value` | `MxDoctype` |
| `onScriptlet` | `Scriptlet { value, block }` | `MxScriptlet` (keeps `block`) |
| `onOpenTagStart` | `Range` | `MxTag.start`, `openTag.start` (Marko does not handle it; it derives the start from the name, `[C]chunk-src.js:6075`) |
| `onOpenTagName` | `Template` | `MxTag.name` (or `MxAttributeTag.name` for `@…`); returns the `TagType` for `tagShape(name)` (§3.12); for a static name, splits at the first `:` (§3.3); records `MX_STATEMENT_IN_HTML_MODE` / `MX_RESERVED_TAG_NAME` (§3.2) |
| `onTagShorthandId` / `onTagShorthandClass` | `Template` | one or two `MxShorthand`s in `shorthands` (`position: "tag"`), split per §3.6 "Splitting a shorthand value" |
| `onTagTypeArgs` | `Value` | `MxTag.typeArgs` |
| `onTagVar` | `Value` | `MxTag.var` |
| `onTagArgs` | `Value` | `MxTag.args` |
| `onTagTypeParams` | `Value` | `MxTag.typeParams` (on the tag, not the body) |
| `onTagParams` | `Value` | `MxTag.params` (`MxParameterList`, span inside the pipes) |
| `onAttrName` | `Range` | `MxAttribute.name`/`nameSpan`; a name `#x`, `.x` or `:x` becomes `MxShorthand` (`position: "attribute"`); an empty range is the default value (`name: null`) |
| `onAttrArgs` | `Value` | `MxAttribute.args` |
| `onAttrValue` | `AttrValue { value, bound }` | `MxAttribute.value`, `operator`; on a shorthand, `MxShorthand.default` |
| `onAttrMethod` | `AttrMethod { params, body, typeParams, async }` | `MxMethod` (§3.5a); `params.value` → `MxParameterList` span, `params` range → its `outer`; extends `MxAttribute.start` per §3.5 |
| `onAttrSpread` | `Value` | `MxSpreadAttribute` |
| `onOpenTagComment` | `Value` | `MxComment` in `MxTag.attributes` |
| `onOpenTagEnd` | `OpenTagEnd { selfClosed }` | `openTag.end`, `selfClosed`; no merge |
| `onCloseTagStart` | `Range` | `closeTag.start` |
| `onCloseTagName` | `Range` | `closeTag.name`/`nameSpan`, the written name with sugar (`</div:x>` → `"div:x"`); for `</>` htmljs emits it with an empty range (`packages/parser/src/template/states/CLOSE_TAG.ts:97-100`, `core/Parser.ts:196` on `main`), which gives `name: null`, `nameSpan: null`. Never re-checked: htmljs reports `MISMATCHED_CLOSING_TAG` (21) itself |
| `onCloseTagEnd` | `Range` | `closeTag.span.end`, `MxTag.end`; ends a preserving body started by this tag; nothing moves |
| `onError` | `Error { code, message }` | `MxParseError` (`source: "template"`, code by name); the last event of the parse: open tags become `incomplete`, `complete: false` (§3.13) |

### 7.1 Inputs from outside the source text

Every option or signal Marko's front end reads that does not come from the
source, and where it comes from for the MX front end. A node field may only
depend on an input marked "front end" in the last column.

| Marko input | Read at | Today's sources | MX front end |
|---|---|---|---|
| `tagDef.parseOptions.openTagOnly` → `TagType.void` | `[C]chunk-src.js:6084` | built-in element taglibs (`marko-html.json` `[C]chunk-src.js:3057`, MathML `:5175`, SVG `:5348`); `core-tags.json` | **front end**, via `tagShape(name)` → `bodyMode: "void"`. Not for custom tags (§3.12) |
| `tagDef.parseOptions.text` → `TagType.text` | `:6085` | built-in taglibs (`<script>`, `<style>`, `<textarea>`), `core-tags.json`, custom tags (`custom-tags.ts:474-476`), the data target's overrides (`targets/data/src/taglib.ts:85-100`) | **front end**, via `tagShape` → `"parsed-text"` / `"parsed-text-preserve"` |
| `tagDef.parseOptions.preserveWhitespace` | `:6082` | as above (`<pre>`, `<script>`, `<style>`, `<textarea>`; custom tags `custom-tags.ts:477-478`; data overrides) | **front end**, via `tagShape` → `"preserve"` / `"parsed-text-preserve"`; decides `MxText.value` |
| `tagDef.parseOptions.statement` → `TagType.statement` | `:6083` | `core-tags.json:75-90` | **front end**, by rule: the six keywords on a concise top-level line (§3.10). Not configurable |
| `tagDef.parseOptions.rawOpenTag` → `rawValue` | `:6173-6177` | `core-tags.json` statement tags, `<style>` | dropped (A18) |
| `tagDef.parseOptions.controlFlow` and `tagDef.controlFlow` | `:6196`, `:6200` | `core-tags.json:4-16` | moves to **lowering** (attribute tags are not moved, D2) |
| `tagDef.parser` hook (parse visitors) | `:6184-6191` | none in MX: `core-tags.json` and `customTagTaglib` carry no `parser` | dropped |
| `htmlParseOptions.preserveWhitespace` (file-wide) | `:5898-5899` | not passed by MX (`fragment.ts:468` passes only offsets, in the unused `parseFragmentNative`) | dropped |
| `tagDiscoveryDirs` (`tags/*.marko` found by Marko's scanner) | taglib lookup | the html target passes `["tags"]` (`targets/html/src/compiler.ts:52-55`) | **not received**; a `.marko` tag's parse options would be lost (Q22) |
| Babel parser options (`typescript` plugin, `allow*` flags) | `:6699-6705` | the compiler | **front end**, fixed configuration of the expression sub-parser |
| `file.___hasParseErrors`, `watchFiles` | `:1028`, `:6190` | internal | dropped (errors are data; dependency tracking is core's) |

So the front end takes exactly one external input, `tagShape(name) →
bodyMode`, supplied by core from the active target (its element shapes, the
core tags, the custom tags' `text`/`preserveWhitespace`, and a target's
overrides such as the data target's). Every other decision Marko made from a
tag definition moves to lowering or disappears. Who owns the element-shape
table once `@marko/compiler` is dropped is Q21.

**Events the MX patch adds or changes.** None added. The patch
(`patches/htmljs-parser@5.18.0.patch`, hunks at `dist/index.js` 311, 1147,
1382, 1432, mirrored in `index.mjs`; on `main` the same rules live as source in
`packages/parser/src/template/states/ATTRIBUTE.ts:116` and
`packages/parser/src/template/states/EXPRESSION.ts:194-200`, `:601-612`,
`:766-780`) changes **where `onAttrValue` ends**:
it marks named-attribute and spread values (`expr.attrValue`), skips `??`
and `?.` when counting ternary depth, and inside such a value lets a `:`
followed by an identifier (or a bare `:` at a tag end) and a `.` followed by an
identifier, after whitespace, terminate the value so `onAttrName` fires for the
next sugar (decision 146 §3). The atoms approach (`parser-approach.md` §5)
would add atom recording inside `EXPRESSION`, which this catalogue receives as
`MxAtom` lists, not as a new event.

## 8. Design choices and alternatives

**D1. One `MxAttribute` node with a nullable name, plus a separate
`MxShorthand`.** Alternative: one `MxAttribute` with `kind: "named" |
"default" | "sugar"`. Chosen because sugar has a sigil, a position and an
optional `default` that named attributes never have, and a default value is a
named attribute without a name, not a third shape.

**D2. Flat children list; attribute tags stay where they were written.**
Alternative: typed slots (`body`, `attributeTags`) filled by the front end, as
Marko does. Chosen because lowering already rebuilds the structure from source
order (three views, `lower.ts:1508-1517`), moving changes spans' parentage,
and Marko's move depends on `controlFlow` taglib flags the AST should not know.

**D3. Structural tags are `MxTag`, only `<return>` is its own node.**
Alternative: `MxIf`, `MxFor`, `MxConst` nodes. Chosen because a structural
name can be shadowed by a file-local binding (spec §7, decision 113), so the
front end cannot know; `<return>` cannot be shadowed (reserved word) and
decision 158 names it.

**D4. Attribute names keep their colons.** Alternative: keep Marko's
`modifier` split. Chosen because MX's lowering re-joins the split for every
name except the `class:`/`style:`/`on:` prefixes (`lower.ts:241-246`,
`:590-593`), so the split encodes Marko's semantics, not MX's.

**D5. Spans only, no stored `loc`.** Alternative: Babel-style `loc` on every
node. Chosen because offsets are what the IR, Volar and LSP consume, line and
column are cheap from one index, and shared position objects were a measured
bug source (`packages/core/AGENTS.md`, `parseFragment` bullet).

**D6. `MxText` carries both normalized `value` and `raw`.** Alternative: raw
only, normalize in lowering. Chosen because normalization needs neighbour
lookahead that the front end already has while building the list; `raw` keeps
the authored text for tools. In a preserving body `value` equals `raw` (§3.8).

**D7. One `MxModuleStatement` with a `keyword`.** Alternative: `MxImport`,
`MxExport`, `MxStatic`. Chosen because the payload is a Babel statement list in
every case and the per-keyword meaning is lowering's; `client` and `class` must
still parse to give a positioned error.

**D8. Errors in one list, referenced from the failed container.** Alternative:
errors only inline (Marko) or only in a list. Chosen so a consumer can report
all errors without walking, and lowering can still find "this expression
failed" locally.

**D9. Parse shape by callback (`tagShape(name) → "html" | "parsed-text" |
"parsed-text-preserve" | "preserve" | "void"`).** Alternative: a fixed
built-in list. Chosen because custom tags' `parseOptions` and a target's own
overrides change the parse (spec §9.3, `custom-tags.ts:460-485`,
`targets/data/src/taglib.ts:85-100`).

**D10. Expressions keep a Babel payload.** Alternative: store only `source`
and spans and let lowering parse on demand. Chosen because the IR spec
requires a positioned `Expr.node` and `For.paramNodes` today (IR spec §4,
E11), and parsing once in the front end gives every expression error a place
in `errors` at parse time.

**D11. Lowering copies parser nodes; the AST never shares.** Alternatives:
the AST hands its own nodes to the IR (breaks the second lowering after an
emitter mutates them, E21), or the front end pre-makes one copy per future
`Expr` (it cannot know how many lowerings there will be). Chosen: copy at the
one point an `Expr` or `For` head is made, with the procedure in §4.1a.

**D12. `MxAttributeTag` is its own node.** Alternative: an `MxTag` with an
`attributeTag: true` flag. Chosen because its name is a property key with
different rules (never split, never resolved, never unnamed), and a distinct
`type` lets a walker skip or collect attribute tags without inspecting names.

**D13. Open-tag comments live in `MxTag.attributes`.** Alternative: a
separate `comments` list on the tag. Chosen because the attribute list is the
only place that preserves their position relative to the attributes.

**D14. `MxDocument.source`/`base` and `MxTag.concise`/`selfClosed` are
stored.** Alternative: recompute them from the original text. Chosen because a
fragment parse's consumers (region bridges, tools) receive the document without
the enclosing file, and formatters need the authored form.

**D15. A failed template parse returns a partial tree.** Alternative: return
no tree, as Marko does by throwing. Chosen because the parser's events up to
the error are exact and the language server benefits from them; the limits are
stated in §3.13.

## 9. Open questions for mx-lead

Numbers are stable across revisions; resolved items keep their number.

- **Q1.** Spec "Name sugar" (`specification.md:742-743`) still lists "a value on
  the sugar (`:x=1`)" as an error; decision 146 addendum 4 makes `#name=expr`
  set the default value. Recommendation: follow the decision; `MxShorthand.default`
  carries it; update the spec.
- **Q2.** Text bodies: htmljs's `TagType.text` (`[H]util/tag-type.d.ts`) parses
  placeholders (probe: `<script>`). Is there a text mode with **no**
  placeholders in MX? Recommendation: no; §3.12 defines none.
- **Q3.** Atom IR node (decision 156 §1) is absent from `ir.ts` and from the
  IR spec (§9: "not yet in the IR"). Proposal for mx-lead to decide (not part
  of this catalogue's normative text): an `atoms?: { name, span }[]` list on
  `Expr`, as `parser-approach.md` §5 suggests, so `MxAtom` maps one to one.
- **Q4.** Should `export interface Input` be split in the AST (an `MxInputInterface`)
  or stay a lowering rule? Recommendation: lowering (today's `lower.ts:2202`).
- **Q5.** `server`/`client`: spec §2 says `server` runs and hoists like `static` on
  html, but `lowerStatement` rejects any keyword other than
  `import`/`static`/`export` (`lower.ts:2208-2212`). Which is current?
  Recommendation: the AST represents both; lowering decides per host.
- **Q6.** *Resolved in round 1:* `MxText` span follows Marko's trimming
  (§3.8), so the IR's `Text.span` is unchanged.
- **Q7.** Open-tag comments have no IR home. Recommendation: drop them at
  lowering; keep them in the AST for formatters.
- **Q8.** Default value on a tag that also has `value=`: today both are
  `name: "value"` and the duplicate rule applies. With `name: null`, lowering
  must treat "default value" and `value=` as one key on tags whose input is
  `value`. Recommendation: lowering maps `null` to `"value"` for every tag;
  record it as the one place MX keeps Marko's convention.
- **Q9.** *Resolved in round 1:* concise `MxTag.end` is the `onCloseTagEnd`
  range end, the last descendant's end (§3.2, probe).
- **Q10.** Agreement with the parser-grammar document (branch
  `chore/parser-grammar-spec`, not on `main`): names of expression positions
  (`var`, `args`, `params`, `typeArgs`, `typeParams`) and span rules (§3.4,
  §5) must match it. Recommendation: whichever merges second adopts the
  first's names.
- **Q11.** `MarkoComment.kind` already exists but lowering re-slices the source
  (`lower.ts:3334`). Recommendation: read `MxComment.kind` after the port.
- **Q12.** The data target's scan (`targets/data/src/scan.ts:140-175`) parses
  with Marko directly. Recommendation: port it to the MX AST in the same
  change as `lower()`.
- **Q13.** Babel payloads: should container `node`s come from `@mxlang/babel`
  with MX node types registered, or plain Babel types only? Recommendation:
  plain Babel types inside containers; `Mx*` types never nest inside Babel
  nodes, so Babel's validators stay unpatched (removes A1 entirely).
- **Q14.** IR spec vs `ir.ts`: the spec says a synthesized `Expr` has `node:
  null` (IR spec §2.2, §4), but `ir.ts:78` types `node: Node` (not nullable).
  Recommendation: make the type `Node | null` before the port.
- **Q15.** IR spec §6 says `<div :foo/>` produces a `static` attr with `value:
  ""` (Marko's `value:foo`), but decision 146 and `divergences.md:131` make bare
  `:foo` the name sugar (`name="foo"`), and the IR spec's own §1 step 1 rewrites
  sugar first. Recommendation: the `value: ""` row applies only to an explicit
  `value:foo`; correct the spec's example.
- **Q16.** The IR spec has no node for atoms or wildcard children (IR spec §9).
  The AST carries `MxAtom` lists (§4.3); per mx-lead's rule nothing here adds
  an IR field. Q3 is the proposal.
- **Q17.** `Expr.node` and `For.paramNodes` must stay positioned Babel nodes
  (IR spec §4, E11), which keeps `loc` alive in the AST's payloads (§4.1).
  Recommendation: once the TypeScript plugin, Angular and Preact read
  `Expr.span`/`Expr.code` instead, drop `loc` from payloads and keep only
  `start`/`end`.
- **Q18.** Attribute-tag `nameSpan` excludes the `@` in the IR (IR spec §3.3)
  while Marko's name `loc` includes it (probe) and this draft's
  `MxAttributeTag.name.span` includes it. Recommendation: keep the AST span
  over `@name` (what was written) and let lowering trim, as stated in §5.1.
- **Q19.** Who re-types the `HostDeclarations` hooks that receive parser
  nodes (§6.4: `resolveDelegatedTag`, `rejectModifier`, `resolveModifier`,
  `rejectAttributeMethod`, `resolveAttributeMethod`, `resolveDefaultTag`,
  `rejectElementAttributeTags`, `rejectComponentTag`, `rejectUnknownTag`,
  `checkBinding`), and in which change? They are public and third-party hosts
  implement them; Preact's `rejectModifier` reads the removed `modifier` field.
  Recommendation: the lowering-port change re-types them to `Mx*` nodes in one
  step, with a `divergences`-style note for third-party hosts; core's
  descriptor version is still `0`.
- **Q20.** Template-parser recovery: htmljs stops at the first error (§3.13).
  Decision 157 addendum 1 asks for structured errors; several per parse needs
  `emitError` to record and continue. Question for mx-lead and native-parser
  (the parser's owner). Options: (a) keep one error per parse and the partial
  tree of §3.13; (b) recovery in `packages/parser/src/template` at the
  points where htmljs knows how to resynchronize (a closing tag, a new line in
  concise mode), which changes `complete`/`incomplete` from "after the error"
  to "around the error". Recommendation: (a) for the port, (b) as its own
  parser task with its own tests.
- **Q21.** `tagShape` needs the element-shape table (void, text,
  preserve-whitespace elements) that comes from `@marko/compiler`'s built-in
  `marko-html.json`/SVG/MathML today (§7.1). When `@marko/compiler` is dropped
  (decision 158 §2), who owns that table: core (beside `VOID_TAGS`), the
  target registry, or each target? Recommendation: each target descriptor
  supplies its shapes, defaulting to an html-family table in core, because
  the data target already overrides them (`targets/data/src/taglib.ts:85-100`).
- **Q22.** `tagDiscoveryDirs: ["tags"]` lets Marko read a `tags/*.marko` file's
  parse options (`targets/html/src/compiler.ts:52-55`). The MX front end does
  not receive that. Decision 87(a) says no Marko taglib finder in the product
  path. Recommendation: drop it with `@marko/compiler`; record a divergence if
  any fixture depends on it.
- **Q23.** A tag's parse shape is decided by its name before lowering knows
  whether a file-local binding shadows it (D3). Marko has the same order
  (`[C]chunk-src.js:6080`). Recommendation: keep it; a shadowed `<pre>`
  component still parses its body with preserved whitespace, as today.
