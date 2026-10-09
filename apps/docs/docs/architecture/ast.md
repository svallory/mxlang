---
title: "The MX AST"
description: "Draft catalogue of MX2's own syntax tree: Marko's AST as it is today, the accommodations removed, the MX node types, and how they map to parser events and to the IR."
---

# The MX AST

> **Status: draft for review** (decisions 158 and 163). Owners: mx-lead (IR,
> lowering) and native-parser (parser, node types). The MX AST, its front end
> and the ported lowering are not implemented yet. Section 1 describes what
> exists today; sections 2 to 9 are the proposal, and where they describe
> today's code (the IR's atoms in §4.3, the shorthand merge in §6.1a, today's
> statement and error behaviour) they say so. Every statement about Marko,
> htmljs-parser or the current code cites the file and symbol it was read
> from (Marko's installed bundle by line), or a probe that was run.

Decision 158 gives MX2 its own syntax tree: node types defined in MX's Babel
fork (`@mxlang/babel`), built by a front end in `@mxlang/parser` from the
template parser's events, and read directly by `lower()` in `@mxlang/core`.
This page is the catalogue those three pieces are built from.

**Citation shorthand.** `[C]` is the installed compiler,
`node_modules/.bun/@marko+compiler@5.42.10/node_modules/@marko/compiler/dist/`.
`[H]` is the installed template parser,
`node_modules/.bun/htmljs-parser@5.18.0/node_modules/htmljs-parser/dist/`.
Template-parser source is cited in this repository, under
`packages/parser/src/template/` (htmljs-parser 5.18.0 copied in, byte-identical
to upstream except `states/ATTRIBUTE.ts` and `states/EXPRESSION.ts`, which
carry the MX patch as source; see its `PROVENANCE.md`). "The IR spec" is
[the IR specification](/architecture/ir-spec/). Paths without a prefix are
relative to the repo root. "Probe" means a script run on 2026-10-05 against the installed
compiler, kept outside the repo under `~/tmp/mx2-ast/` (`raw.ts`: parse-only
translator, as `parseFragment` uses; `core.ts`: MX's core taglib registered
the way `packages/targets/html/src/compiler.ts` `host` registers it).

**Version.** The workspace resolves `@marko/compiler` **5.42.10** (the only
copy under `node_modules/.bun/`; `bun.lock`, its `@marko/compiler` entries; `packages/core/package.json` `dependencies`)
and `htmljs-parser` **5.18.0** with the MX patch (root `package.json`: `devDependencies` `htmljs-parser` and `patchedDependencies`).
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
`loc.start.index`. `packages/core/src/fragment.ts` `shiftNode` relies on exactly
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
| `name` | `Expression` (a `StringLiteral` for a static name, a template literal or other expression for `<${x}>`) | required | everywhere a tag is dispatched: `core/src/lower.ts` `lowerChildList` (`name?.value === "if"`), `lowerTemplate` (statement scan), `core/src/default-tag.ts` `isUnnamedTag` (empty-span test), `core/src/name-sugar.ts` `rewriteNameSugar`, `targets/data/src/scan.ts` `scanAuthoredTags` |
| `attributes` | `(MarkoAttribute \| MarkoSpreadAttribute)[]` | default `[]` | `core/src/lower.ts` `lowerAttrs`, `lowerReturn` (`<return>`), `core/src/name-sugar.ts` `rewriteAttributes` |
| `body` | `MarkoTagBody` | required | `lower.ts` `lowerBlock` (`node.body?.body`), `lowerReturn` |
| `arguments` | `(Expression \| SpreadElement)[] \| null` | optional | `lower.ts` `rejectArgsWithProps`, `lowerDelegatedTag`, `lowerComponent`, `lowerAuthoredTag` |
| `typeArguments` | `TSTypeParameterInstantiation \| null` | optional | `core/src/core.ts` `rejectUnsupportedFields` (rejected: "type arguments on … are not supported") |
| `rawValue` | `string \| null` | optional | not read (the statement lowerer re-slices the source instead, `lower.ts` `lowerStatement`) |
| `var` | `LVal \| null` | optional | `lower.ts` `lowerConst` (`<const>`, `<define>`), `lowerCustomTag` (components), `lowerChildList`, `core/src/reserved-bindings.ts` `checkReservedBindings` |
| `attributeTags` | `(MarkoTag \| MarkoScriptlet \| MarkoComment)[]` | default `[]` | `lower.ts` `containsAttributeTags`, `lowerAuthoredAttributeTag`, `lowerAttributeTags`, `validateCustomAttributeTagBodies`, `lowerCustomTag`, `lowerAuthoredTag` |

Also set at runtime but not a declared field, so dropped by the clone:
`tagDef` (`[C]chunk-src.js:6080`). Not in the builder but declared in the
d.ts: none beyond the table.

#### `MarkoTagBody`

Defined `[C]babel.js:8200-8232`; declared `[C]types.d.ts:3696-3702`. Aliases
`Marko`, `BlockParent`, `FunctionParent`, `Scope`, `Scopable` (it is the
Babel scope for tag params). Probe: it carries **no `loc`**.

| Field | Type | Optional | Read by MX |
|---|---|---|---|
| `body` | `(MarkoTag \| MarkoCDATA \| MarkoText \| MarkoPlaceholder \| MarkoScriptlet \| MarkoComment)[]` | default `[]` | `lower.ts` `lowerBlock`, `lowerReturn` and every child walk |
| `params` | `FunctionParameter[]` | default `[]` | `lower.ts` `paramsOf`, `hasParams`, `rejectLoopParamInBy`, `lowerForHead`; `core.ts` `rejectUnsupportedFields` |
| `attributeTags` | `boolean` | default `false` | not read |
| `typeParameters` | `TSTypeParameterDeclaration \| null` | optional | `core.ts` `rejectUnsupportedFields` (rejected) |

#### `MarkoAttribute`

Defined `[C]babel.js:8162-8193`; declared `[C]types.d.ts:3681-3689`. Alias
`Marko` only (not `Expression`, not `Statement`).

| Field | Type | Optional | Read by MX |
|---|---|---|---|
| `name` | `string` | required | `lower.ts` `lowerAttrNamed`, `lowerReturn` |
| `value` | `Expression` (a `BooleanLiteral true` when no value was written, `[C]chunk-src.js:6117`) | required | `lower.ts` `lowerAttrNamed` (kind derivation) |
| `modifier` | `string \| null` | optional | `lower.ts` `attrNameSpan`, `isOrdinaryColonName`, `lowerAttrNamed` |
| `arguments` | `(Expression \| SpreadElement)[] \| null` | optional | `lower.ts` `lowerAttrNamed` |
| `default` | `boolean \| null` | optional | `lower.ts` `attrNameSpan`, `validateBuiltinValueAttributes`, `lowerReturn` |
| `bound` | `boolean \| null` | optional | `lower.ts` `validateBoundAttributes`, `lowerAttrNamed` |

MX adds four ad hoc fields to attributes it synthesizes for name sugar:
`sugarNameSpan`, `sugarLabel`, `sugarAt` and real `start`/`end`
(`core/src/name-sugar.ts` `sugarAttr`, `mergeClassTokens`); `lower.ts` `attrNameSpan`,
`lowerAttr` and `lowerAttrNamed` read them.

#### `MarkoSpreadAttribute`

Defined `[C]babel.js:8194-8199`; `[C]types.d.ts:3691-3694`. One field,
`value: Expression`, required. Read by `lower.ts` `lowerAttrNamed`.

#### `MarkoText`

`[C]babel.js:8115-8119`; `[C]types.d.ts:3658-3661`. `value: string`,
required, **already whitespace-normalized** by the front end
(`[C]chunk-src.js:5985-6037`). Read by `lower.ts` `lowerChildList`, `isLayout`,
`lowerIfChain`, `authoredChildTree`; `core.ts` `hasContent`.

#### `MarkoPlaceholder`

`[C]babel.js:8120-8131`; `[C]types.d.ts:3663-3667`. `value: Expression`
required; `escape: boolean` default `true`. Read by `lower.ts` `lowerChildList`
(both fields).

#### `MarkoScriptlet`

`[C]babel.js:8132-8151`; `[C]types.d.ts:3669-3674`. `body: Statement[]`
required; `static: boolean` default `false`; `target: "server" \| "client"`
optional. MX reads only the type: `lower.ts` `lowerChildList` rejects every scriptlet
(decision 54). `static` and `target` are not read; they are never set by the
front end either (`[C]chunk-src.js:6067` builds `markoScriptlet(block.body)`).

#### `MarkoComment`

`[C]babel.js:8104-8114`; `[C]types.d.ts:3652-3656`. `value: string`
required (delimiters stripped); `kind: "html" \| "line" \| "block"` optional,
set by `getCommentKind` (`[C]chunk-src.js:6250-6256`). MX reads `value`
(`lower.ts` `lowerChildList`) but **not `kind`**: it re-derives "is this an HTML
comment" by slicing the source (`lower.ts` `lowerChildList`).

#### `MarkoCDATA`, `MarkoDocumentType`, `MarkoDeclaration`

`[C]babel.js:8099-8103`, `:8089-8093`, `:8094-8098`; `[C]types.d.ts:3647`,
`:3637`, `:3642`. Each has one required `value: string`, delimiters stripped
(probe: `<!doctype html>` gives `"doctype html"`, `<?xml v?>` gives
`"xml v"`). `MarkoDocumentType.value` is read by `lower.ts` `lowerChildList`;
`MarkoCDATA` and `MarkoDeclaration` are rejected by type (`lower.ts` `lowerChildList`,
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
`lower.ts` `exprOf` (`label`, `errorLoc`, `loc`),
`core/src/stock-parser.ts` `stockParserError`, `hosts/solid/src/compile.ts` `repairEmbeddedTsx` (`source`).

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

- `parseFragment` (`packages/core/src/fragment.ts`) with
  `PARSE_ONLY_TRANSLATOR` (`fragment.ts`): **no core taglib**. Probe:
  `import x from "./y"` parses as a `MarkoTag` named `import` with attributes
  `x`, `from` and `"./y"`; `class { x = 1 }` as a tag `class` with one
  attribute named `{ x = 1 }`. `name-sugar.ts` `CORE_STATEMENT_TAGS` carries a fallback list
  of statement tag names for exactly this case.
- `compileSource` (`packages/core/src/compile.ts`) with the host's
  translator (`compile.ts` `createTranslator`), which registers MX's core taglib
  (`packages/core/src/taglib/core-tags.json`; `statement: true,
  rawOpenTag: true` for `import`, `static`, `export`, `client`, `server`,
  `class` at lines 75-90; `controlFlow: true` for `if`, `else`, `else-if`,
  `for` at 4-16). Probe `core.ts`: the same statement then parses as a
  `MarkoTag` named `import` with no attributes and `rawValue: "import x from
  \"./y\""`. `lower()` runs in the translator's `Program.exit`
  (`compile.ts` `createTranslator`).

## 2. Accommodations removed

One row per thing Marko's AST or front end does to fit Marko. "Why" is
Marko's reason as far as the source shows it; where the source does not say,
the row says "not stated".

| # | What Marko does | Why (Marko's need) | What MX needs instead | Replaced by |
|---|---|---|---|---|
| A1 | The Marko node family lives inside a patched `@babel/types` (`[C]babel.js:8065-8280`), members of Babel's `Node` union (`[C]types.d.ts:381`); `Program` gains `params` (`[C]babel.js:5511`). | Marko's translator is a Babel plugin: it traverses and replaces Marko nodes with Babel's own `NodePath`, scope and builders, so the nodes must be Babel nodes. `MarkoTagBody` is a Babel `Scope`/`FunctionParent` (`[C]babel.js:8201-8207`) so tag params get Babel bindings. | MX never runs Marko's translator. MX needs node types it owns, defined in `@mxlang/babel` without patching Babel's own definitions, and traversable by MX's own walker. | The `Mx*` family (§3), declared as a separate union in `@mxlang/babel`. Babel nodes appear only inside expression containers (§4). |
| A2 | The attribute name is split at the **last** `:` into `name` + `modifier` (`[C]chunk-src.js:6111-6115`). Decision 170 settled the open question: the split is data MX keeps. | Marko's translator implements modifiers (`class:x`, `value:fn:=x`, `x:scoped`). | `class:`/`style:` reach the host through a hook, but every consumer was re-splitting the string (`lower.ts` `isOrdinaryColonName`, `lowerAttrNamed`); carrying the split as fields removes the re-derivation. | `MxAttribute.name` stays the authored name, colons included, **and** carries `modifier` + `modifierSpan` (decision 170, §3.5). The differential compares the split field by field (§8 D4). |
| A3 | An attribute with an empty head is named `"value"` with `default: true` (`[C]chunk-src.js:6117`), so `<if=a>` and bare `:x` both become `value`; the default attribute's `loc` starts at the `=` and has no name text (`lower.ts` `attrNameSpan`). | Marko's tags read their default input as `input.value`. | `<if=a>` is "the tag's default value", not an attribute named `value`. Bare `:x` is the name sugar (decision 146, divergence `divergences.md`, row "Bare `:x` is `name="x"`"). | `MxAttribute.name: null` for the default attribute (§3.5); bare `:x` is `MxShorthand { sigil: ":" }` (§3.6). |
| A4 | Tag-adjacent `#id`/`.class` are buffered and merged into `class`/`id` attributes at `onOpenTagEnd` (`[C]chunk-src.js:6148-6171`); several classes become one string, a template, or an array; the merged attributes have **no `loc`** (probe: `MarkoAttribute@noloc`). A shorthand `id` beside an `id` attribute throws (6168). | Marko's output is HTML; merging gives the translator one `class` attribute. | Shorthands are their own syntax with their own spans; MX's name sugar has to recover them (`name-sugar.ts` exists for this; `lower.ts` `lowerAttrNamed` falls back to the tag position). Merging and duplicate rules are language semantics, owned by lowering. | `MxShorthand` nodes, in source order, each with its own span (§3.6). No merge in the AST. |
| A5 | An empty tag name becomes `"div"` (`[C]chunk-src.js:6078`), leaving the `StringLiteral` with an empty span. | Marko has one host. | Decision 145: an unnamed tag resolved by the `defaultTag` ladder. MX detects it today by an empty-span test (`default-tag.ts` `isUnnamedTag`, `targets/data/src/scan.ts` `scanAuthoredTags`). | `MxTagName { kind: "unnamed" }` (§3.3). |
| A6 | A tag name containing `:` is one name (`<a:b>` is tag `a:b`); a `:` inside a shorthand is part of the class (`.c:b`). | htmljs-parser's tag-name rule; Marko has no name sugar. | Decision 146 and addendum (`divergences.md`, row "A static tag name may not contain `:`", and row "A shorthand class or id cannot contain `:`"): the head splits into tag, `:name`, `#id`, `.class` in any order. MX does it post-parse (`name-sugar.ts`, header comment). | `MxShorthand` items in `MxTag.shorthands`; the name never contains `:` (§3.3, §3.6). |
| A7 | Attribute tags are moved out of the body into `tag.attributeTags`, with preceding comments (`[C]chunk-src.js:5915-5927`); a `controlFlow` tag holding attribute tags has its body and `attributeTags` swapped and is moved into the **parent's** `attributeTags`, with `body.attributeTags = true` (`[C]chunk-src.js:6194-6227`). The moved list is then re-sorted by `start` (`attributeTags.sort(sortByStart)`, `[C]chunk-src.js:6213`). Probe: `<Card><@head/><if=a><@item/></if></Card>` puts the `<if>` in `Card.attributeTags`. | Marko's translator compiles attribute tags as input properties of the parent; moving them at parse time saves a pass. | Lowering already re-derives structure: three synchronized views (`attributeTags`, `attributeTagTree`, `attrTagProps`) and source-order merging (`lower.ts` `mergeBySourceOffset`, `lowerAttributeTags`). The AST should show what was written, where it was written. | Attribute tags stay in `body` in source order as `MxAttributeTag` nodes; nothing moves (§3.7, §8 D2). |
| A8 | Statement tags (`import`, `export`, `static`, `server`, `client`, `class`) are tags whose open tag is kept raw (`rawOpenTag`, `[C]chunk-src.js:6173-6177`) and whose meaning comes from the taglib (`core-tags.json`, `<import>` through `<class>`); without the taglib they parse as tags with garbage attributes (probe, §1.4). MX recovers the statement by slicing the source on `loc` (`lower.ts` `lowerStatement`, `lowerTemplate`) and regexes (`lower.ts` `lowerStatement`). Spec §2 documents the cost (`apps/docs/docs/specification.md` ("Syntax")). | Marko's grammar is tag-shaped at the top level; the translator gives the statement tags meaning. | They are TypeScript statements. MX needs the parsed statement, its keyword and its span. | `MxModuleStatement { keyword, statements }` with a parsed Babel statement list (§3.10). |
| A9 | `MarkoClass` (`[C]babel.js:8152-8161`), a `Class`-aliased node. | Marko 5's class components. | MX has no class components; `class` is not a statement MX accepts (`lower.ts` `lowerStatement` rejects anything but `import`/`static`/`export`). | No node. `class { }` at the top level is an `MxModuleStatement { keyword: "class" }` that lowering rejects (§3.10), so the error keeps its position. |
| A10 | `MarkoParseError` is an `Expression` and `Statement` alias (`[C]babel.js:8070-8074`) put in place of the failed expression; `onError` from the template parser **throws** (`[C]chunk-src.js:5975-5984`). Two error channels, neither carries a code. | Lets the translator keep going until it reaches the bad expression, then throw. | Decision 157 addendum 1 asks for structured errors. MX needs every error as data: a code, a range, a message. Several template errors per parse would need parser recovery, which decision 163 rules out for now (Q20). | `MxParseError { code, origin, message, start, end }` in `MxDocument.errors`, and an `error` field on the expression container that failed (§3.13, §4). Expression and front-end errors no longer throw; a template-parser error still ends the parse (htmljs `emitError`), but the tree built so far is kept (§3.13); `compileSource` lowers no document with errors and reports them all (§3.13, decisions 161-162). |
| A11 | Tag params and tag type parameters are stored on **`MarkoTagBody`** (`[C]chunk-src.js:6059`, `:6102`), not on the tag. | `MarkoTagBody` is the Babel scope that binds them (A1). | The params belong to the tag head the author wrote; scope is a lowering concern. | `MxTag.params`, `MxTag.typeParams` (§3.2). The body is a plain child list. |
| A12 | Positions: Marko nodes get `start`/`end` and a `loc` without `index` (`withLoc`, `[C]chunk-src.js:5909-5914`), then lose `start`/`end` in the clone (`[C]chunk-src.js:6710`, `[C]babel.js:13217-13241`); Babel nodes keep `loc.index`. Position objects are shared between nodes (`packages/core/AGENTS.md`, `parseFragment` bullet). Fragments are shifted by a tree walk afterwards (`fragment.ts` `shiftNode`). `Program.end` is `code.length - 1` (`[C]chunk-src.js:6241`). | Babel's `File`/`loc` model; the clone is how the compiler hands the tree to Babel. | One numeric span on every node, file-relative, in UTF-16 units, with line/column computed on demand (§5). | `start`/`end` on every MX node; no `loc` stored (§5). |
| A13 | Text is whitespace-normalized in the front end, with neighbour lookahead (`[C]chunk-src.js:5985-6037`); the node's `loc` is moved to the trimmed text. | Marko's HTML output rules. | MX needs both: the normalized value the IR's `Text.value` carries, and the authored span (`ir.ts` `ComponentTarget`). | `MxText { value, raw }` plus span (§3.8, §8 D6). |
| A14 | Open-tag comments become Babel comments attached to the next attribute, the last attribute, or the tag (`[C]chunk-src.js:5941-5948`). | Babel's comment attachment model. | A comment is source; tools need it where it was written. | `MxComment` items in `MxTag.attributes` order (§3.11). |
| A15 | The tag's parse mode (text, void, statement, preserve-whitespace) comes from a taglib lookup at name time (`[C]chunk-src.js:6080-6086`), fed by Marko's built-in element taglibs (`marko-html.json` at `[C]chunk-src.js:3057`, SVG at `:5348`, MathML at `:5175`), MX's `core-tags.json`, and custom tags' `text`/`preserveWhitespace` (`core/src/custom-tags.ts` `customTagTaglib`). | Marko's taglibs. | The parse mode is still name-dependent. MX needs it as an explicit input to the front end, not a taglib. | A `tagShape(name)` callback on the front end, and `MxTag.bodyMode` recording what was answered (§3.12; the full input list is §7.1). |
| A16 | `MarkoScriptlet.static`/`target` and `MarkoComment.kind` exist but MX does not read them; `MarkoTagBody.attributeTags` is an internal flag (A7). | Translator needs. | Fields the language does not use are noise. | Dropped, except comment `kind`, which MX keeps and lowering should read instead of re-slicing (§9, Q11). |
| A17 | `<${x}>` names are parsed as template strings: a static-only template becomes a `StringLiteral`, one expression with empty quasis becomes that expression (`[C]chunk-src.js:5954-5973`). | One code path for all names. | A dynamic name is an expression with a span; a static name is a string with a span. | `MxTagName` kinds `static` and `dynamic` (§3.3). |
| A18 | `rawValue` (`[C]babel.js:8267`) holds the raw open tag for `rawOpenTag` tags (statement tags and `<style>`, `core-tags.json`). | Marko's `<style>` and statement handling. | Not needed once statements are parsed (A8); `<style>` content is a body. | No field. |
| A19 | A `{ … }`-wrapped attribute value that fails to parse gets a hint appended to its `MarkoParseError` label: "Attribute values in Marko are plain JavaScript expressions, not JSX; remove the wrapping `{ }`" (`withWrappedAttrValueHint`, `[C]chunk-src.js:6292-6297`, applied at `:6129`). | A common mistake from JSX authors. | The same hint, in MX's words. | The front end applies the same test to an `MxExpression` error and rewords the message (§3.13). |
| A20 | The tag name `%` throws "`<% scriptlets %>` are no longer supported" (`[C]chunk-src.js:6079`). | Marko 3 scriptlet syntax removed. | MX never had it; a clear error is still better than an unknown `%` tag. | `MxParseError` `MX_RESERVED_TAG_NAME`, recorded, parse continues (§3.2). |
| A21 | A statement tag written in HTML mode (`<import …>`) throws `statementTagInHTMLModeError` (`[C]chunk-src.js:6087`, message at `:6278-6284`). | Statement tags are top-level concise lines. | The same rule; `import` is an `MxModuleStatement` only on a concise top-level line. | `MxParseError` `MX_STATEMENT_IN_HTML_MODE` with Marko's message, recorded (§3.2). |
| A22 | Comments inside statement blocks are kept as Babel `innerComments`: a scriptlet's (`[C]chunk-src.js:6067-6069`) and every block `parseBlock` builds, method bodies included (`[C]chunk-src.js:949-951`). Open-tag comments are attached to attributes or the tag (A14). | Babel's comment model. | Comments inside TypeScript belong to the Babel payload; a dropped directive changes semantics. | Kept on the `MxStatements` container's `innerComments` (and the block's `directives` with them), as Babel produces them. |

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
`packages/babel/src/types.ts` contain no `Mx` prefix (`rg 'type: "Mx'`
returns 0), while unprefixed candidates would collide (`Placeholder` is a Babel
type in `packages/babel/src/types.ts`, as is `TemplateLiteral`).

```ts
interface Span { readonly start: number; readonly end: number }      // §5
interface MxNodeBase extends Span { readonly type: `Mx${string}` }

type MxChild =
  | MxTag | MxAttributeTag | MxReturn | MxText | MxPlaceholder
  | MxScriptlet | MxComment | MxCDATA | MxDoctype | MxDeclaration
  | MxModuleStatement | MxTrigger    // MxTrigger: a line trigger (§4.4)
  | MxBlockTag | MxFilter;           // §4.5

type MxNode =
  | MxDocument | MxChild
  | MxAttribute | MxShorthand | MxSpreadAttribute | MxMethod
  | MxParseError | MxAtom | MxTrigger
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
| `errors` | `MxParseError[]` | no | one list, every producer (expression, front end, template parser), ordered by `start`; the template-parser error, at most one, is always last (§3.13) |
| `complete` | `boolean` | no | `false` when the template parser reported an error (the parse stopped there) |
| `source` | `string` | no | the text that was parsed (the fragment, for a fragment parse) |
| `base` | `{ offset: number; line: number; column: number }` | no | §5.3; `{0, 0, 0}` for a whole file |

There is no document-level mode: htmljs decides concise or HTML per line, and
each `MxTag.concise` records it per tag.

Spans: `start = base.offset`, `end = base.offset + source.length` (not
`length - 1`, unlike `[C]chunk-src.js:6241`). A leading byte-order mark is
skipped by the parser (`packages/parser/src/template/core/Parser.ts` `Parser.parse`), so the first node can start at offset 1.

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
| `attributes` | `(MxAttribute \| MxShorthand \| MxSpreadAttribute \| MxComment \| MxTrigger)[]` | no | attribute list in source order, attribute-position sugar, open-tag comments and attribute triggers (§4.4) included |
| `body` | `MxChild[] \| null` | no | `null` for a self-closed tag and for a tag the parser closed at its open tag (`bodyMode: "void"`); children in source order, attribute tags included |
| `bodyMode` | `"html" \| "parsed-text" \| "preserve" \| "parsed-text-preserve" \| "void"` | no | the parse shape `tagShape(name)` answered (§3.12) |
| `selfClosed` | `boolean` | no | `/>` written |
| `concise` | `boolean` | no | written in concise mode |
| `openTag` | `Span` | no | `<` (or the first name character in concise mode) through `>`/`/>` (or, in concise mode, the head's last non-whitespace character) |
| `closeTag` | `MxCloseTag \| null` | no | the written closing tag; `null` when none was written (self-closed, void, concise) |
| `incomplete` | `boolean` | no | `true` when the template parser stopped (§3.13) before this tag's end event |

`MxCloseTag` is `{ span: Span; name: string \| null; nameSpan: Span \| null }`:
`span` is `</` through `>`; `name` is the **written** closing name, sugar
included (`</div:x>` gives `"div:x"`, spec "Name sugar",
`specification.md` ("Name sugar: `:name`, `#id` and `.class` anywhere on a tag"); `divergences.md`, row "A static tag name may not contain `:`"), from `onCloseTagName`;
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
arrived) is the `start` of the template-parser error or the end of the last
node or part attached to the tag, whichever is later (§3.13, decision 163
addendum 8). Sub-spans:
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
  | { readonly kind: "static"; readonly value: string; readonly span: Span }
  | { readonly kind: "dynamic"; readonly expression: MxExpression; readonly span: Span }  // <${x}>, <my-${x}>
  | { readonly kind: "unnamed"; readonly span: Span };                                     // <#a>, <.b>, <:c>, concise #a
```

- `static`: the authored name with the head sugar removed. The written name
  (htmljs's `onOpenTagName` range) is split at its **first** `:`
  (`specification.md` ("Name sugar: `:name`, `#id` and `.class` anywhere on a tag"); decision 146, 23:23 addendum): before it is
  `value`, from it on is a tag-position `MxShorthand { sigil: ":" }` (§3.6).
  `<input:email>` is `value: "input"`, `span` `[1, 6)`. So `value` never
  contains `:` (`divergences.md`, row "A static tag name may not contain `:`"). An empty part before the `:`
  (`<:email>`) makes the name `unnamed`. Marko splits attribute names at the
  **last** `:` (A2); that rule does not apply here. Attribute tags are not
  split (§3.7). `tagShape` receives the written static name, before the
  split (`<input:email>` asks `tagShape("input:email")`, `<.x>` asks
  `tagShape("")`); a dynamic name is not looked up and is `"html"`; an
  attribute tag is not asked either, its body is `"html"`. `tagShape` is
  not only asked about tags: unless the caller passes `tagTypes`, the front
  end's pre-scan asks it about every run of the source that could be a
  static tag name, text words included, and the statement keywords are
  asked before the parse (§7.1), so it must answer any string without
  throwing (`"html"` for a name it does not know). The statement-keyword test reads the written name too, so
  `import:x` is a tag (decision 163 addenda 7 and 8). Because the split happens after htmljs has read the name,
  htmljs still sees the written name `input:email` when deciding whether the
  tag is void or may self-close, so `<input:email type="email"/>` needs its
  `/>` in HTML mode and the closing tag repeats the written name
  (`specification.md` ("Name sugar: `:name`, `#id` and `.class` anywhere on a tag")). Which table decides self-closing after
  `@marko/compiler` is dropped (today its `self-closing-tags` dependency,
  `bun.lock`) belongs to the element-shape table (§3.12, ruling Q21).
- `dynamic`: htmljs reports a `Template` (`packages/parser/src/template/util/constants.ts` `Ranges.Template`).
  `expression` is the whole name as one container, built by Marko's
  template-string rule (`parseTemplateString`, `[C]chunk-src.js:5954-5973`),
  which the front end **keeps on purpose** (the "replaced" of A17 does not
  apply to it): one `${…}` with both quasis empty is that expression, except
  that a `StringLiteral` result is wrapped in a one-quasi `TemplateLiteral`
  (`<${"div"}>`, `[C]chunk-src.js:5962-5963`); any other name is a Babel
  `TemplateLiteral` over the whole written text. It is needed because
  `Expr.code` for a dynamic name is printed from that node today (`` `my-${x}` ``,
  `` `div` ``; §7.1, generator row). There is no separate list of quasis or
  inner expressions: they would re-parse the same text into a second Babel
  tree. `span` covers the written name, `${` and `}` included.
- `unnamed` (decision 145): `span` is empty, at the offset right after `<`
  (concise: at the first sugar character). Lowering resolves it through the
  `defaultTag` ladder (spec "The unnamed tag"); the AST never writes `div`.

Examples (`<input:email>`, `<${x}>`, `<.card>`): `static` `[1, 6)`;
`dynamic` `span` `[1, 5)`, `expression.span` `[3, 4)`; `unnamed` `[1, 1)`.

### 3.4 Head parts: `MxPattern`, `MxArguments`, `MxParameterList`, `MxTypeArguments`, `MxTypeParameters`

Each is an expression container (§4) with a specific Babel payload. One span
rule for all five: **`start`/`end` cover the text inside the delimiters
(htmljs's `value` range); `outer: Span` covers the delimiters too (htmljs's
event range)** (`Ranges.Value`, `packages/parser/src/template/util/constants.ts`).

| Type | Source | Babel payload | Delimiters (`outer`) |
|---|---|---|---|
| `MxPattern` | `/x`, `/{ a, b }` | `LVal` | from `/` |
| `MxArguments` | `(a, ...b)` on a tag or an attribute | `(Expression \| SpreadElement)[]` | `(` `)` |
| `MxParameterList` | `\|a, b = 1\|` on a tag; `(a, b)` on a method | `FunctionParameter[]` | `\|` `\|` or `(` `)` |
| `MxTypeArguments` | `<string>` after a name | `TSTypeParameterInstantiation` | `<` `>` |
| `MxTypeParameters` | `<T>` before tag params or a method's params | `TSTypeParameterDeclaration` | `<` `>` |

For a method, htmljs's `AttrMethod.params` range includes the parentheses and
its `value` excludes them (`packages/parser/src/template/states/ATTRIBUTE.ts` `ATTRIBUTE`), so `MxParameterList` for `onInput(e) { … }` has span `(e)`'s
inside and `outer` the parenthesised text.

### 3.5 `MxAttribute`

Purpose: one named attribute, or the tag's default value.

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `name` | `string \| null` | no | the authored name's head before the **last** `:` (`class:x` → `class`), colons kept before it (`a:b:c` → `a:b`); `null` for the default value (`<if=a>`) (decision 163 addendum 12) |
| `nameSpan` | `Span` | no | the head (`onAttrName` up to the last colon); zero-width at the `=`/`(` for the default value |
| `modifier` | `string \| null` | no | the text after the **last** `:` of the authored name (`class:x` → `x`), `null` without one; a trailing colon (`x:`) is `""` (decision 170) |
| `modifierSpan` | `Span \| null` | no | the modifier's own span, colon excluded, starting at `nameSpan.end + 1`; zero-width there for the empty modifier; `null` with `modifier` |
| `operator` | `"=" \| ":=" \| null` | no | `null` for a bare attribute or a method |
| `value` | `MxExpression \| MxMethod \| null` | no | `null` for a bare attribute (`disabled`) |
| `args` | `MxArguments \| null` | no | `name(args)` without a body: Marko 5's attribute-arguments form (`onAttrArgs`). Kept so lowering can position its error: today lowering only rejects it (`Unsupported arguments on …`) or hands it to the host's `resolveAttributeMethod` (`lowerAttrNamed`, `lower.ts`) |

Spans, one rule: `start = min(nameSpan.start, value?.start)` and `end =` the
end of `value`, of `args`, or of `nameSpan`, whichever is last. The `min`
matters for an `async` method, whose range starts at `async`, before the name
(`packages/parser/src/template/util/constants.ts` `Ranges.AttrMethod`; `ATTRIBUTE.ts` `ATTRIBUTE`; probe:
`<div async onLoad<T>(e: T) { a() }/>` gives the method `1:5-1:34` and the
name `1:11`). For the default value, `start` is the `=` (or `(`) and
`nameSpan` is zero-width there (htmljs reports an empty `onAttrName` range).
For an expression value, `value.span` is htmljs's `AttrValue.value` (after
`=`/`:=` and whitespace, `ATTRIBUTE.ts` `ATTRIBUTE`).

```mx
<input disabled type="email" value:=draft onInput(e) { set(e) }/>
```

Offsets:
- `disabled`: `[7, 15)`, `nameSpan` the same, `operator` and `value` `null`
- `type="email"`: `[16, 28)`; `nameSpan` `[16, 20)`; `value.span` `[21, 28)` (quotes included, as the IR's string spans)
- `value:=draft`: `[29, 41)`; `name: "value"`, `operator: ":="`; `value.span` `[36, 41)`
- `class:x` (a name with a modifier): `modifier: "x"` and `modifierSpan` the last character of `nameSpan` (decision 170); `x:` gives `modifier: ""` and a zero-width `modifierSpan` at `nameSpan.end`
- `onInput(e) { set(e) }`: `[42, 63)`; `nameSpan` `[42, 49)`; `value` is an `MxMethod` `[49, 63)`

Invariants: `operator === ":="` implies `value` is an `MxExpression` (bound
attribute); `value.type === "MxMethod"` implies `operator === null`. The AST
records every default value written, and never decides whether a second one
is an error: that depends on the host and on the position (an attribute-position
`#x=1` is no default value on a host that claims `#`, P8), so the rule is
lowering's (§6.1a, `MX_DUPLICATE_DEFAULT`). Lowering reads a default value
(`name: null`) as the attribute `value` through one adapter, with the
zero-width `nameSpan` kept (IR invariant E7): the one Marko convention MX keeps
on purpose, because every tag reads its default input as `value`. Bound attributes keep
their full name: `value:=x` is `name: "value"`, because htmljs reports `:=`
as the operator (`part.bound`, `[C]chunk-src.js:6127`); a bound name with a
colon (`a:b:=x`) keeps the split `modifier: "b"` for the same reason.

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
type parameters' `<`, else from `(`, through `}` (`ATTRIBUTE.ts` `ATTRIBUTE`). There is no Babel `FunctionExpression` in the AST; lowering builds
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
(`onAttrSpread` range, `ATTRIBUTE.ts` `ATTRIBUTE`); `value.span` is the
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
| `operator` | `"=" \| ":=" \| null` | no | what directly follows the token (whitespace allowed): `=`, `:=`, or nothing / a method (decision 146 addendum 4) |
| `default` | `MxExpression \| MxMethod \| null` | no | decision 146 addendum 4: the value after `=` or `:=`, or the method, in `#name=expr` / `#name(params) { body }`; it sets the tag's default value |
| `args` | `MxArguments \| null` | no | arguments written right after the sugar with no body (`.c(p)`, `#x(p)`, `:x(p)`); `null` otherwise. Kept on the node with their atoms; `MX_SUGAR_ARGUMENTS` is raised at the sugar (rule 6; decision 163 addendum 11) |

```ts
type MxShorthandValue =
  | { readonly kind: "static"; readonly value: string; readonly span: Span }
  | { readonly kind: "dynamic"; readonly template: MxExpression; readonly quasis: readonly Span[];
      readonly expressions: readonly MxExpression[]; readonly span: Span };   // tag position only: <div.a${x}>
```

Spans: `start` = the sigil; `end` = end of `value` (not of `default`, which has
its own span). `value.span` excludes the sigil. The node's span is the
authored token (`#x`, `.c`, `:n`), kept exactly: lowering takes `Attr.sugar`
and, on a host that claims `#`, the attribute name `#x` from it (P8, §6.1).

What each sigil takes (`specification.md` ("Name sugar: `:name`, `#id` and `.class` anywhere on a tag")): `:name` an identifier,
`[A-Za-z_$][\w$-]*`; `#x` and `.x` what Marko's shorthand takes, a run up to
whitespace, `=`, `(`, `/`, `|`, `<`, `,` or `>`, with `.` and `#` starting the
next part.

**Splitting a shorthand value: one rule for both positions.** htmljs reports
a tag-adjacent `#d:b` as **one** `onTagShorthandId` `Template` (reviewer's
probe: `[4, 8)` for `<a.c#d:b …>`), and an attribute-position `.c#m.d:y` as
**one** attribute name. The front end splits each into `MxShorthand`s with the
same rule (`specification.md` ("Name sugar: `:name`, `#id` and `.class` anywhere on a tag"); today `rewriteHead` and
`rewriteAttributes` in `core/src/name-sugar.ts`, where the attribute-position
chain is cut into `.`/`#` parts outside any `${…}` by `splitShorthandChain`):

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
   sigil (tag position, `rewriteHead`); in attribute position an empty part
   (`.`, `#`) is an error, as today (`rewriteAttributes`: "`.` needs a name
   after it").
5. A `${…}` in an attribute-position shorthand is an `MxParseError`
   `MX_SUGAR_DYNAMIC` at its sigil (today: "a dynamic shorthand works only
   tag-adjacent", `rewriteAttributes`).
6. Arguments without a body after a sugar (`#x(p)`, `.c(p)`, `:x(p)`) are an
   `MxParseError` `MX_SUGAR_ARGUMENTS` at the sugar (today `checkNearSugar`,
   two branches: `#`/`.` and `:`). The arguments are kept on the node
   (`args`); the error is raised at the sugar. With a body, `#x(p) { … }` is a method
   default (decision 146 addendum 4), `operator: null`.
7. `:=` after a sugar (`:n:=y`, `.c:=y`, `#x:=y`) is `operator: ":="` and an
   `MxParseError` `MX_SUGAR_BOUND` at the sugar ("a bound value is not
   supported on name sugar", `checkNearSugar`), except where the sugar is not
   one: attribute-position `#x` on a host that claims `#` (P8). Because that
   depends on the host, the front end records `MX_SUGAR_BOUND` for `:` and `.`
   only, and lowering raises it for `#`. Today, a `:n:=y` whose value cannot
   be bound (not an identifier or member expression) keeps the ordinary bound
   value error instead (`checkNearSugar`, `bindable`).

```mx
<a.c#d:b title="t" .big :mail/>
```

Offsets:
- tag position: `.c` `[2, 4)` (`value.span` `[3, 4)`), `#d` `[4, 6)`, `:b` `[6, 8)` (split out of htmljs's `#d:b` `[4, 8)`)
- attribute position: `.big` `[19, 23)`, `:mail` `[24, 29)`
- `<a.${x}:b>`: `.` `[2, 7)` with `value.span` `[3, 7)` and `template.span` `[5, 6)`; `:b` `[7, 9)`

Invariants: a tag has at most one `:` sugar in its head; `value.kind ===
"dynamic"` implies `position === "tag"`; `default !== null` implies
`position === "attribute"` (tag-adjacent `<a#x=1>` is an ordinary default
attribute, `MxAttribute { name: null }`, because htmljs ends the shorthand
at `=`); `operator === null` and `default !== null` implies `default` is an
`MxMethod`; order within `shorthands` and within
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
Because nothing moves, two things Marko's front end did at parse time become
lowering's, at today's positions (P7): the error "Cannot have attribute tags
and body content under a control flow tag." (Marko throws it at the first
body child, `[C]chunk-src.js:6206`; lowering already raises the same message
for the multi-branch and nested cases, `lower.ts` `lowerAttributeIf` and
`lowerAttributeTags`, and takes over the single-tag case at Marko's position), and
comments directly before an attribute tag, which Marko moves into
`attributeTags` with it (`[C]chunk-src.js:5918-5926`) and lowering skips as
layout.

### 3.8 `MxText`

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `value` | `string` | no | in a `"html"` or `"parsed-text"` body: normalized by Marko's rule (`[C]chunk-src.js:5991-6036`, spec §3 "Whitespace"); in a `"preserve"` or `"parsed-text-preserve"` body: the authored text unchanged, as Marko does when `preserveWhitespace` is on (`[C]chunk-src.js:5987-5989`) |
| `raw` | `string` | no | `source.slice(start, end)`, the authored run |
| `valueSpan` | `Span` | no | the range `value` was normalized from, which feeds the IR's `Text.span` |

Spans: the node span is the whole `onText` range, newline-led whitespace
included (formatters need the authored run). `valueSpan` in a normalizing body is Marko's `withLoc` range
(`[C]chunk-src.js:6029-6033`): `start = part.start +
rawValue.indexOf(trimmed)` and `end = start + trimmed.length`, where `trimmed`
is the text after the newline-led runs at each end were removed and before
inner whitespace was collapsed into `value`; in a preserving body it equals
the node span. Lowering writes `Text.span` from `valueSpan`, which keeps it
exactly what it is today (the goldens are unchanged). Concise `--` text lines
produce `MxText` too, starting after `-- `.

Examples: `<p>  a\n  b</p>` gives `value: " a b"`, span `[3, 10)`, `valueSpan`
`[3, 10)`; `<p>\n  a</p>` gives span `[3, 7)` and `valueSpan` `[6, 7)`;
`<pre>  a\n  b</pre>` gives `value: "  a\n  b"` (probe: Marko keeps the
newline and the spaces for `<pre>`, which `marko-html.json` marks
`preserveWhitespace`, `[C]chunk-src.js:3606`).

Invariant: in a normalizing body, a run that normalizes to `""` produces no
node (its whitespace is layout, with no node, as in Marko); `raw` is never
empty; `valueSpan` lies inside the node span.

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

`MxModuleStatement` — a statement keyword of the target (see "Statement
keywords per target" below) written as a concise top-level line.

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `type` | `"MxModuleStatement"` | no | |
| `keyword` | `string`: one of the target's statement keywords (the language's six, `"import" \| "export" \| "static" \| "server" \| "client" \| "class"`, or the target's subset) | no | the first word |
| `code` | `MxStatements` | no | the whole statement for `import`/`export`/`class`, the part after the keyword for `static`/`server`/`client` |
| `untrimmedEnd` | `number` | no | the end of htmljs's statement range, trailing whitespace and line breaks included; the source of the IR statement kinds' `end: Position` (below) |

Spans: the htmljs statement range, right-trimmed of whitespace, as for every
node (a node's `start`/`end` slice to the node): `start` at
the keyword, `end` after the last non-whitespace character on the line, so a
trailing same-line comment is **inside** the span (today's `statementSpan`,
`lower.ts`, which trims the Marko range whose end sits on the next
line; IR spec §3.3, `Import`/`Export`/`Static` row). `code.span` is the
authored statement text, right-trimmed like the node: from the keyword for
`import`/`export`/`class`, after the keyword and its whitespace for
`static`/`server`/`client`, so a trailing comment is inside it too; Babel's
statement range, which ends before such a comment, is the payload's own range
(§4.1), not the container's (decision 163 addendum 7). Neither is the source of
any IR text. The untrimmed end is its own field, `untrimmedEnd` (decision 163
addendum 6).

What lowering takes from where (P2):

| IR field | Source |
|---|---|
| `Static.code` | `source.slice(span)` minus the leading `static` and its whitespace (today `line.replace(/^static\s+/, "")`, `lowerStatement`) |
| `Import.code`, `Export.code`, `InputInterface.code` | `source.slice(span)` |
| `span` (`Import`/`Export`/`Static`), `loc` | the node span (right-trimmed) |
| `end: Position` (`Import`, `Export`, `Static`, `InputInterface`) | **untrimmed**: `lineColumnAt(untrimmedEnd)`, the end of htmljs's statement range, as today (below) |
| `Import.bindings`, the `Input` test | the Babel payload (`code.node`) |

Example: `static const A = 1 // trailing` is `[0, 30)` and `Static.code` is
`const A = 1 // trailing` (a direct probe); `code.span` is `[7, 30)`
and the payload's statement range `[7, 18)`.

**`end` is a separate fact** (decision 163 addendum 1). Today `end` is
`endPosOf(node)` (`lower.ts`), Marko's `loc.end` of the statement tag, which
is **not** trimmed: it is the end of htmljs's statement range, trailing
whitespace and following line breaks included (probes: `static const A = 1   ` then
`<div/>` gives `end` `{ line: 1, column: 21 }` with `span` `[0, 18)`;
`export const B = 2` followed by two blank lines and `<div/>` gives `end`
`{ line: 1, column: 18 }`, the range stopping at its own line's end; probed
on the IR of an html compile, 2026-10-06). The port reproduces it from `untrimmedEnd`, the untrimmed
range's end; `end` stays the trimmed extent. This is how "`span` trimmed, `end`
untrimmed" is realised: it describes the IR, not a second meaning of the
node's `end`. Two readers
use it: the TypeScript plugin's block mapping (`mx-language.ts`
`locateSourceCode`, `item.end`) and Astro's statement mappings
(`astro-template.ts`, `statement.end`). Whether they depend on it is being
measured under MX1 TODO `statement-end-untrimmed`.

Invariants: only in `MxDocument.body`; `export interface Input` is an
`MxModuleStatement { keyword: "export" }` whose payload is a
`TSInterfaceDeclaration`. Splitting it out is lowering's, by payload type,
keeping today's asymmetry: `export interface Input` becomes `InputInterface`
(`lowerStatement`, `lower.ts`), while `export type Input` stays an
ordinary `Export` in the IR but is still read as the template's own input
(`lower.ts` `lowerTemplate`, which matches `interface|type`).

**Statement keywords per target** (decision 163 addenda 1 and 3). The keyword
set is an **input to the front end, supplied per target**, beside `tagShape`
(§7.1). The language's set is the same six on every target, `import`,
`export`, `static`, `server`, `client` and `class`, with one documented
exception: on the tree target `class`, `client` and `server` are vocabulary
names, so its set is `import`, `static`, `export`. A keyword outside the
target's set is an ordinary tag name there: `server` and `client` are
`MxModuleStatement`s only where the target's set includes them (Q5/P5).

Today, by target:

| Targets | Statement set at parse time | Declared by |
|---|---|---|
| html | the six | `targets/html/src/compiler.ts` `host` registers `CORE_TAGLIB` (`core-tags.json`, `<import>` through `<class>`, `parseOptions.statement`) |
| data | `import`, `static`, `export` | `targets/data/src/taglib.ts` (`"<import>"`, `"<static>"`, `"<export>"` entries; header comment: the host-owned names "stay ordinary data tag names"), registered by `parse.ts` `parseData`, `scan.ts`, `translator.ts` |
| Preact, React, Hono (`hosts/preact/src/compile.ts` `host`: `tagDiscoveryDirs` only), Angular (`hosts/angular/src/index.ts` and `tag-module.ts`, no `taglibs`), and every `parseFragment` caller (Solid, Astro, the regions; `fragment.ts` `PARSE_ONLY_TRANSLATOR`, custom tags only) | none | — |

On the last row a statement line parses as a tag with attributes (probe:
`static const a = 1` is the tag `static` with attributes `const`, `a`), and
lowering recovers `Static`/`Import`/`Export` by name (`lowerAuthoredTag`'s
switch) and by slicing the source (`lowerStatement`); `isStatementTag`
(`name-sugar.ts`) answers from the compile's lookup, so the name sugar runs
on those tags under `compileSource` and does not under `parseFragment`
(`CORE_STATEMENT_TAGS`). This is an accident, not a rule: MX1 TODO
`statement-tags-not-declared-on-five-hosts` (decision 163 addendum 3) makes
those hosts pass the core set before the port, with the moved goldens listed
in that change, so the port carries nothing.

`MxScriptlet` — `$ stmt` and `$ { block }`.

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `type` | `"MxScriptlet"` | no | |
| `block` | `boolean` | no | `$ { … }` form (htmljs reports it, `packages/parser/src/template/states/INLINE_SCRIPT.ts` `INLINE_SCRIPT`; Marko ignores it) |
| `code` | `MxStatements` | no | the statements (inside the braces for the block form) |

Spans: from `$` to the end of the statement or `}`. Example: `$ const z = 1;`
is `[0, 14)`, `code.span` `[2, 14)`. MX rejects scriptlets (decision 54,
`lower.ts` `lowerChildList`); the node exists so the error is positioned.

`MxStatements` — the expression container (§4) for statements:
`MxExpressionContainer<Statement[]> & { type: "MxStatements" }`, carrying the
sub-parse's `directives` (`"use strict"` changes semantics) and
`innerComments` beside the payload (§4.1). Span: the
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

`MxTag.bodyMode` records the parse shape `tagShape(name)` answers. The template
parser takes the matching `TagType` (`[H]util/tag-type.d.ts`) from the syntax
table's `tagTypes`, computed before the parse and keyed by the full written
static name (decision 182 addenda 2 and 3; `statement` applies only on a
concise line); `onOpenTagName` returns nothing. A caller passes the table as
`ParseOptions.tagTypes`; otherwise the front end builds it from `tagShape`
and `statementKeywords` by pre-scanning the source (interim until core builds
it), and checks every tag's `bodyMode` against it (`MX_TAG_TYPES_MISMATCH` for
a caller's table that disagrees):

| `bodyMode` | htmljs `TagType` | Text handling | Answered for |
|---|---|---|---|
| `"html"` | `html` | normalized | everything not listed below, and the unnamed tag (`<.x>`: `tagShape("")` answers `"html"`) |
| `"parsed-text"` | `text` | normalized | `parseOptions.text` without `preserveWhitespace`: `<title>` (Marko's html taglib, `"<title>": { "parse-options": { "text": true } }`, `[C]chunk-src.js:3787`), `<html-comment>` (`core-tags.json`) |
| `"parsed-text-preserve"` | `text` | authored | `text` + `preserveWhitespace`: `<script>`, `<style>`, `<textarea>` (`[C]chunk-src.js:3645-3747`), `<html-script>`, `<html-style>` (`core-tags.json`) |
| `"preserve"` | `html` | authored | `preserveWhitespace` alone: `<pre>` (`[C]chunk-src.js:3606`); a custom tag's `parseOptions.preserveWhitespace` (`custom-tags.ts` `customTagTaglib`) |
| `"void"` | `void` | — | `openTagOnly` **as the parser receives it today**: the HTML/SVG/MathML void elements of Marko's built-in taglibs (`marko-html.json` starts at `[C]chunk-src.js:3057`; e.g. `<area>` at `:3110`) and the core tags marked `openTagOnly` (`<let>`, `<const>`, `<id>`, `<lifecycle>`, `<log>`, `<debug>`, `<return>`, `core-tags.json`) |

Preserving mode lasts until the tag that started it closes, and applies to
every descendant text (Marko's `preservingWhitespaceUntil`, set at
`[C]chunk-src.js:6082` and cleared at `:6185`).

A custom tag's `openTagOnly` is **not** a parse shape: core forwards only `text`
and `preserveWhitespace` to the parser (`custom-tags.ts` `customTagTaglib`) and enforces
`openTagOnly` in lowering with a positioned call-site error
(`specification.md` ("9.4 Units")). `tagShape` never answers `"void"` for a custom tag.

`bodyMode` is a parse fact, not the IR's `Element.void`: lowering keeps taking
`Element.void` from `VOID_TAGS` (`core/src/core.ts`, read at
`lower.ts` `lowerAuthoredTag`; IR spec §5.5).

Invariant: in a `parsed-text*` body no `MxTag` appears; `<x>` inside
`<script>` is text (probe: `MarkoText " <x>"`), and so is `<b>` inside
`<title>`.

The table also records, for each name it knows, whether that name is an
element. Today that is the `html` flag of Marko's tag definition, which
`contractDefaultTag`'s `isStructural` (`core/src/contract-default-tag.ts`)
reads to treat a known non-element (`await`, `define`) as structure (§6.4).

**Who owns the table.** The element-shape table belongs to the target
descriptor, with a core default (the html family's void, text and
preserve-whitespace elements); a target overrides entries, as the tree target
does today (`targets/data/src/taglib.ts` `neutralizations`). It is **one table with two
readers**: the front end's `tagShape` and decision 145's check that a
`defaultTag` has a plain parse shape (`adr-default-tag.md` ("Decision")).

**Shape before shadowing** (ruling Q23). `tagShape` answers from the name
alone, before lowering knows whether a file-local binding shadows that name
(§3.15, D3). A file-local component named `pre` therefore still has its body
parsed with whitespace preserved, as today: Marko makes the same choice at the
same point (`[C]chunk-src.js:6080`, the `tagDef` lookup in `onOpenTagName`).

### 3.13 `MxParseError` and what a failed parse contains

| Field | Type | Opt. | Meaning |
|---|---|---|---|
| `type` | `"MxParseError"` | no | |
| `code` | `string` | no | a stable code: htmljs codes by name (`INVALID_ATTRIBUTE_VALUE`, `MISMATCHED_CLOSING_TAG`, … `[H]util/error-code.d.ts`, 31 codes, 0-30), `BABEL_<reasonCode>` for an expression sub-parse failure, `MX_<NAME>` for front-end rules |
| `origin` | `"template" \| "expression" \| "front-end"` | no | which of the three produced it |
| `message` | `string` | no | one line, no code frame, no ANSI |
| `start`, `end` | `number` | no | the node's own range (`MxNodeBase`, §3.0): what to underline; for an expression error the precise point when Babel reports one (Marko's `errorLoc`, bounded to the source range as `getBoundedRange` does, `[C]chunk-src.js:1040-1050`) |
| `context` | `Span \| null` | no | the whole construct when it differs from `start`/`end` (Marko's `source` range) |

Three producers, with different consequences:

1. **The template parser (htmljs) stops at its first error.**
   `Parser.emitError` calls `onError` and then sets `this.pos = this.maxPos +
   1` (`packages/parser/src/template/core/Parser.ts` `Parser.emitError`), and `parse` loops `while (this.pos <= maxPos)`
   (`Parser.parse`), so no event follows `onError`: no close events for
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
3. **Front-end rules** are recorded and do not stop the parse. Each has a
   code. The ones that exist today as positioned errors in
   `core/src/name-sugar.ts` (and, for the last four, in Marko's front end)
   are:

   | Code | Today | Where today |
   |---|---|---|
   | `MX_SECOND_NAME` | a second `:name` on a tag (`<a:b:c>`, `<a.c:b:d>`, `:x:y`, `.c:x:y`) | `SECOND_NAME` in `rewriteHead`, `checkNearSugar`, `rewriteAttributes` |
   | `MX_COLON_BEFORE_DYNAMIC` | a `:` before a `${…}` in a shorthand | `headNamesIn` |
   | `MX_SUGAR_NAME_MISSING` | a sigil with nothing after it: `:` in a tag name with no name, a bare attribute-position `:`, an empty `.`/`#` part | `checkToken`, `checkNearSugar`, `rewriteAttributes` |
   | `MX_SUGAR_NAME_INVALID` | a `:name` that is not `[A-Za-z_$][\w$-]*` | `checkToken`, `rewriteAttributes` (`SUGAR_TOKEN`) |
   | `MX_SHORTHAND_INVALID` | an attribute-position `.x`/`#x` word Marko's shorthand would not accept | `rewriteAttributes` (`isShorthandWord`) |
   | `MX_SUGAR_DYNAMIC` | a `${…}` in an attribute-position shorthand | `rewriteAttributes` ("a dynamic shorthand works only tag-adjacent") |
   | `MX_SUGAR_ARGUMENTS` | arguments without a body after a sugar | `checkNearSugar` |
   | `MX_SUGAR_BOUND` | `:=` after a sugar (front end for `:` and `.`; lowering for `#`, §3.6 rule 7) | `checkNearSugar` (`BOUND_ON_SUGAR`) |
   | `MX_SUGAR_ON_STATEMENT` | a `:name` on a statement keyword (`<import:x/>`) | `rewriteNameSugar` |
   | `MX_STATEMENT_IN_HTML_MODE` | `<import …>` written with `<` | Marko, `[C]chunk-src.js:6087` |
   | `MX_RESERVED_TAG_NAME` | the tag name `%` | Marko, `[C]chunk-src.js:6079` |
   | `MX_ATTRIBUTE_TAG_AT_ROOT` | an attribute tag with no enclosing tag | Marko, `[C]chunk-src.js:5917` |
   | `MX_TAG_NAME_MISSING` | a `,` line or `<,/>` with no tag above: the comma continues the attributes of a tag that was never named; the nameless node stays in the tree beside the error (decision 163 addendum 9) | new (`<,/>` today throws `MISSING_END_TAG` in the template parser) |
   | `MX_UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE` | `$!{…}` as an attribute value (`<div x=$!{a}/>`) | rejected by `@marko/compiler` today; the port removes that layer (decision 166 item 1, decision 163 addendum 5) |
   | `MX_TAG_TYPES_MISMATCH` | a caller-supplied `tagTypes` (decision 182 addenda 2, 3) gives a static tag a type its `tagShape` body mode does not match; positioned at the tag name, the tag parsed with the table's type. A table that contradicts the statement rule never gets this far: it is a `TypeError` before the parse (§7.1) | new (decision 182, PR B) |
   | `MX_FRONT_END_INTERNAL` | the front end itself failed (an exception inside a handler): always an MX bug, never the author's. The parse does not throw; the error is recorded with the partial tree, its message a fixed MX sentence ending "not yours: an MX bug" (decision 161's wording) followed by the raw exception message, no stack or code frame | new (decision 163 addendum 7) |

   A duplicate default value is not among them: it is lowering's
   (`MX_DUPLICATE_DEFAULT`, §3.5, §6.1a), as is `MX_SUGAR_BOUND` for `#`.
   This table lists front-end errors only. Errors lowering raises (those two,
   "Cannot have shorthand id and id attribute." of §6.1a, the control-flow
   attribute-tag error of §3.7, and every error lowering raises today) are
   out of this document's error table: they keep today's text and position,
   and coding them is the IR spec's "Errors" section (decision 162).
   Today every one of them throws, so only the first is reported; as data,
   all are kept (decision 162).

All three go into one list, `MxDocument.errors`, ordered by `start`, with
the template error (at most one) last even when an earlier-recorded entry
starts after it.

**What the AST contains when the template parser reports an error** (from the
parser code above, not from what would be desirable):

- `MxDocument.complete` is `false`; `errors` ends with the template error.
- Every node whose closing event arrived before `onError` is complete and
  exact.
- Every tag still open at that point (the error's ancestors) exists with
  `incomplete: true`, `closeTag: null`, and `end` = the error's `start` or the
  end of the last node or part attached to it, whichever is later; its `body`
  holds every child whose events arrived before the error (decision 163
  addendum 8).
- The construct the parser was inside exists only as far as its events
  arrived: htmljs emits each attribute part when that part ends and a text run
  when the next construct starts, so an attribute whose `onAttrName` arrived
  but whose value did not is an `MxAttribute` with `value: null`, and a text
  run pending at the error is absent. A consumer tells such a part from a
  genuine bare attribute only by the error's `start` falling inside the tag's
  head; the front end does not mark it.
- A statement the error cuts short (`static const x = (`) is kept as an
  `MxModuleStatement`: `untrimmedEnd` is the error's `start` or the end of its
  keyword, whichever is later, and `end` is that range right-trimmed; it has
  no `incomplete` field, and `complete: false` says the parse stopped
  (decision 163 addendum 10).
- Every node whose events arrived is kept, even when it lies after the error's
  `start`: `MISSING_END_TAG` fires at the end of input and is ranged on the
  unclosed open tag, after the events that follow it.

What a consumer such as the language server may rely on: the template error's
`code`, `message`, `start` and `end`; every expression and front-end error before it;
and every complete node. It must not rely on the shape of an `incomplete`
tag's head or body beyond what is listed, and it gets no diagnostics for the
text after the error. There is no parser recovery (ruling Q20 (a), decision
163): a parse yields at most one template error, and recovery is not planned
until a tool can project a partial template, which is a lowering feature.

**What `compileSource` does with the errors.** `complete === false` implies the
document is **not lowered**; neither is a document with any entry in
`errors`. Decision 162 makes compiling report every error as data rather than
throw the first one (decision 161 makes the same rule for diagnostics whose
generated position has no mapping: never dropped). For a
document with errors, `compileSource` therefore throws a `TranslateError`, whose
`.errors: TranslateError[]` holds **every** entry of `errors`, in the order
above (template error last), and which is itself `.errors[0]`, the first error, in
today's frame format (today a document with several expression errors throws
one aggregate, `[C]chunk-src.js:5975-5984`, `:6474`), so the 14 host-dispatch goldens
(`tooling/tsc/src/fixtures/host-dispatch/__golden__/`, each recording
`"name": "CompileError"` and Marko's code frame) keep their first message.
The three post-processors that rewrite Marko's errors today (`compile.ts`,
the `catch` around `compileSync`: `annotateCloseTagOpener` from
`close-tag-opener.ts`, `hintParseError` from `parse-error-hints.ts`, and
`sugarAfterDefaultError`/`stockParserError`/`stockAtomError` from
`stock-parser.ts`) key on `MxParseError.code` instead of matching message
text. **Status on main:** decision 162 is implemented for lowering
(`TranslateError.errors`, IR spec §13); a Marko parse error still arrives as
one aggregate, and decision 161 is separate. The rest of this paragraph follows
the decision text.

Examples: `<div x=(1 +)/>` gives a complete tree, one error `origin:
"expression"`, `start`/`end` `[11, 11)`, `context` `[7, 12)`, and the attribute's
`value` container has `node: null`. `<div></span>` gives `errors` `[{ code:
"MISMATCHED_CLOSING_TAG", start: 5, end: 12 }]` (reviewer's probe: `onError
[5,12)/21`), `complete: false`, and one `MxTag` `div` `[0, 5)` with
`incomplete: true`. `<div><p>x` gives `errors` `[{ code: "MISSING_END_TAG",
start: 5, end: 8 }]` (the events: `Text [8,9)`, then `onError [5,8)/22`),
`complete: false`, `div` `[0, 9)` and `p` `[5, 9)`, both `incomplete`, and
`p`'s text `[8, 9)`.

When the error replaces an expression, the container's `node` is `null` and
its `error` is the same object as the entry in `errors` (§4).

### 3.14 `MxReturn`

Purpose: `<return=x/>` / `<return value=x/>` (decision 155, spec §10).

Fields: exactly those of `MxTag` (§3.2), with `type: "MxReturn"`; no nested
tag and no `value` field. Lowering reads the returned value as it reads any
tag's default value (the `name: null` attribute or `value=`, §3.5), and keeps
its shape errors (`lowerReturn`).

Spans: as `MxTag`. Example: `<return=x/>` is `[0, 11)`; its default value's
`value.span` is `[8, 9)`. Invariant: the front end produces `MxReturn` for
every tag whose static name is `return`; shape validation (no body, no spread,
one value, top level only, one per template) stays in lowering, as today.

### 3.15 Things that are not nodes

- **Wildcard children** (decision 147) have no syntax, so they are not an AST
  node (ruling C1 of decision 163, which amends decision 158 §1's list). A
  child tag keeps its authored name (`MxTagName.static`), and matching it
  against `children["*"]` patterns is contract validation in lowering. The IR
  records the match as merged in #347/#354: `TagAlias { authored, span?,
  groups }` (`ir.ts` `TagAlias`) on `Component.alias` and `DelegatedTag.alias`,
  where `authored` and `span` come from `MxTagName.static`'s `value` and
  `span` and `groups` from the pattern match. The AST's contribution is the
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
  readonly source: string;   // the authored text, source.slice(start, end)
  readonly outer: Span;      // the span with the position's delimiters (§3.4); equal to the span when none
  readonly node: N | null;   // the Babel payload; null when the parse failed
  readonly error: MxParseError | null;
  readonly atoms: readonly MxAtom[];   // §4.3, empty when none
  readonly triggers?: readonly MxTrigger[];   // §4.4, present only when there are any
}
type MxExpression    = MxExpressionContainer<Expression>   & { readonly type: "MxExpression" };
type MxStatements    = MxExpressionContainer<Statement[]>  & { readonly type: "MxStatements";
  readonly directives: readonly Directive[]; readonly innerComments: readonly Comment[] };
type MxPattern       = MxExpressionContainer<LVal>         & { readonly type: "MxPattern" };
type MxArguments     = MxExpressionContainer<(Expression | SpreadElement)[]> & { readonly type: "MxArguments" };
type MxParameterList = MxExpressionContainer<FunctionParameter[]> & { readonly type: "MxParameterList" };
type MxTypeArguments = MxExpressionContainer<TSTypeParameterInstantiation> & { readonly type: "MxTypeArguments" };
type MxTypeParameters = MxExpressionContainer<TSTypeParameterDeclaration> & { readonly type: "MxTypeParameters" };
```

- **Span** is on the original file (§5), exactly the characters the author
  wrote for this position, delimiters excluded.
- **`node`'s own positions are file-relative**: the sub-parse is given the
  container's `start`, line and column, as Marko already does with
  `startIndex`/`startLine`/`startColumn` (`[C]chunk-src.js:988-1003`). A
  wrapper prefix (`(…)=>{}`, `_(…)`) is compensated the same way Marko's
  `sourceOffset` does (956-983). The payload's own range is **not** the
  container's: the container span is htmljs's `value` range, which includes
  inner whitespace (`${ y }` is `[2, 5)` in `${ y }`), while the node covers
  the expression alone (`[3, 4)`). Lowering takes `Expr.span`, `paramSpans`
  and every `For` param span from the **payload** node, never from the
  container (P1). Today's `exprSpan` (`lower.ts`) reads the Babel node's
  `loc` (through `offsetOf`, which prefers `loc.start.index`) and returns
  `undefined` for a node without `loc`; the payload's `start`/`end` are the
  same offsets, so the port may read either.
- **`source`** is kept because lowering prints the authored slice, not the
  generated AST, so TypeScript type arguments survive (`core/src/core.ts` `expr`,
  `expr()`; IR spec §4, `code` row).
- **`node` is Babel-shaped and carries `loc`.** The IR spec requires a
  lowering to supply `Expr.node` "positioned, for every authored expression",
  with `loc.start`/`loc.end` as `{ line, column, index? }` (IR spec §4, `node`
  row), because three emitter-side consumers still read it: the TypeScript
  plugin maps through `node.loc` (`packages/tooling/typescript-plugin/src/mx-language.ts` `locateSourceCode`),
  Angular's tag module walks `node` and regenerates `code` from it
  (`packages/hosts/angular/src/tag-module.ts` `rewriteInputReads`), and Preact reads a
  `by=` key's `node.value` (`packages/hosts/preact/src/emitter.ts` `PreactEmitter`).
  `For.paramNodes` must also be positioned parser nodes (IR spec §5.9, E11;
  Angular reads them, `packages/hosts/angular/src/emitter.ts` `AngularEmitter`). So
  until mx-lead moves those consumers to `Expr.span`/`Expr.code`, the Babel
  payload of every container keeps Babel's `start`, `end` **and** `loc` with
  `index`, all file-relative. This is the one place the AST stores `loc`
  (§5.1): inside Babel payloads, never on `Mx*` nodes.

### 4.1a Sharing and copying

The IR spec makes the IR read-only to emitters (IR spec §10.2, E21): one
lowered `Ir` may be emitted more than once, and **a lowering may share an
object** (an `Expr`, a `loc`) between two places. An emitter that rewrites
`Expr.code`, `For.bindings` or a parser node first takes a private copy with
`cloneIr` (`packages/core/src/clone-ir.ts`): Solid copies each `For` it
rewrites (`packages/hosts/solid/src/emitter.ts` `SolidEmitter`), and Angular's tag module
copies the whole `Ir`, parser nodes included (`cloneIr(lowered, { nodes: true
})`, `packages/hosts/angular/src/tag-module.ts` `compileTagModule`), before rewriting
`input.x` reads in place (`rewriteInputReads`). `ir-readonly.test.ts` in every host
freezes the IR, parser nodes included, so a write throws. For the AST this
means:

- **Containers never share.** Two containers never hold the same Babel node
  or the same position object; two textually identical expressions get two
  containers and two Babel trees. Inside one payload Babel itself may share a
  position object between a parent and a child at a coincident boundary
  (`ir.ts`, `Expr.span` comment).
- **The AST is read-only.** Neither lowering nor anything after it mutates an
  `Mx*` node or a container's Babel payload. The types enforce it for the
  nodes: every field is `readonly` and every array a `readonly T[]` (the
  tables below carry no `readonly` column), while the Babel payloads stay as
  Babel types them (decision 163 addendum 6). One AST is lowered more than once
  (the custom-tag `analyze` pre-walk lowers the whole body on a scratch `Ctx`
  before the real walk, IR spec §1, step 3; a tool may lower the same parse
  for several hosts), and that is safe only because of this rule.
- **No copy is required at the AST/IR seam.** Since E21 forbids emitters to
  mutate and allows a lowering to share, `Expr.node` and `For.paramNodes`
  (`ir.ts`, `Expr.node`, `For.paramNodes`, `ForHead`) may be the container's
  payload itself; an emitter that edits one copies it first with `cloneIr`.
  The host test suites freeze the IR, parser nodes included
  (`ir-readonly.test.ts`), so the port's lowering must not mutate a payload
  either: anything it changes (the shorthand merge of §6.1a included) it
  builds as a new node.

What each consumer reads, and why it is unaffected:

| Consumer | Reads | Why sharing is safe |
|---|---|---|
| TypeScript plugin | the root node's `loc.start`/`loc.end` `{ line, column }`, then checks `source.slice(…) === code` (`mx-language.ts` `locateSourceCode`, `offsetAt`) | read only |
| `expr()` / lowering's slice | `node.start ?? node.loc?.start.index`, `node.end ?? …` (`core.ts`, `expr()`) | read only |
| Angular tag module | mutates parser nodes | on its `cloneIr(…, { nodes: true })` copy |
| Preact `by=` | `node.type`, `node.value` (`preact/src/emitter.ts` `PreactEmitter`) | read only |
| Angular `$index` alias | `For.paramNodes[i]` structure (`angular/src/emitter.ts` `AngularEmitter`) | read only |

### 4.2 Compared with the IR's `Expr`

`Expr` is `{ code, shape, node, span?, file?, atoms? }` (`packages/core/src/ir.ts`;
normative contract in [the IR spec §4](/architecture/ir-spec/),
`apps/docs/docs/architecture/ir-spec.md`).

| `Expr` | Expression container | Difference |
|---|---|---|
| `code` | `source` | `code` is after binding rewrites (decision 70); `source` is authored. Lowering produces `code` from `source` + `node`, as `expr()` does today. |
| `shape` | derived from `node.type` | `expressionShape` (`lower.ts`) stays in lowering. |
| `node` | `node` | `Expr.node` is the container's payload (§4.1a); `null` on a synthesized `Expr` (IR spec §2.2). The type is ruled `Node \| null` (Q14, decision 163); `ir.ts` on main still declares `node: Node`. While `Node` is `any` (`core.ts`) the change has no effect on any type check, so it documents intent only |
| `span?` | the payload node's range, **not** the container's `start`/`end` | lowering writes `{ sourceStart: node.start, sourceEnd: node.end }`, the range today's `exprSpan` reads from `node.loc`; the container span includes inner whitespace and would move every `Expr.span` over `${ x }`, `( a )` or `\| a \|` (P1). For a string literal the span includes the quotes (IR spec §3.3) |
| `atoms?` | the container's `atoms` | one IR `Atom { kind: "atom", name, span }` per `MxAtom`, absent when there are none (`ir.ts`, `Expr.atoms`) |
| `file?` | (document level) | a container never names another file |

### 4.3 `MxAtom`

Decision 156: `:name` in an expression position is an atom. A container
lists each atom found in its `source` and not inside a nested container (the
`template` of a tag-adjacent dynamic shorthand lists none of the atoms in its
`expressions`; decision 163 addendum 8):

```ts
interface MxAtom extends Span { readonly type: "MxAtom"; readonly name: string }  // span covers ':' and the name
```

The Babel payload holds the atom as a `StringLiteral` whose `value` is the
name and whose `extra.mxAtom` is `{ span }`, the atom's own span, `:`
included (`MxAtomMark`, `ir.ts`; decision 156 addendum 1, item 1, which makes
that node shape public API of `@mxlang/core` and `@mxlang/data`). Every
Babel-based consumer sees a string. Today the template parser lexes the atom,
reports it through `onAtom` and hands Babel a numeric stand-in of the same
length (`0.`), and core's `convertAtoms` (`core/src/atoms.ts`) turns the
stand-in into that `StringLiteral`; the front end builds the `StringLiteral`
directly. `::name` is a template-parser error (`INVALID_EXPRESSION`,
reserved, decision 156 §5; `packages/parser/src/template/PROVENANCE.md`,
"Atoms").

What the IR makes of atoms is what shipped (#342, #346, #348, #357):

- `Expr.atoms?: Atom[]`, one per `MxAtom` of the container, and `Expr.code`
  holds each as its string literal (core splices `JSON.stringify(name)` at
  each atom's span; IR spec §4, `atoms` row).
- A whole value that is one atom (`mode=:strict`) is a `static` `Attr` with
  `atom?: Atom`, `value` the name and `valueSpan` the atom's span; so is the
  `name` the `:name` sugar sets (decision 156 addendum 1, item 2; `ir.ts`,
  `Attr`; IR spec §6, `static` row).
- In `parseData`, such a value is `DataAttr { kind: "atom", name, value,
  nameSpan?, span }` (`targets/data/src/tree.ts` `DataAttr`), the sugar-derived `name` included; nested atoms stay
  `StringLiteral` + `extra.mxAtom`.

`MxExpressionContainer.atoms` stays: lowering needs the spans to splice the
literal into `Expr.code` and to fill `Expr.atoms`.

**Where the atom lexer runs**, per container field (ruling C11 of decision
163, amended to describe main; `PROVENANCE.md`, "Atoms", and the
`expr.atoms = true` sites in `packages/parser/src/template/states/`):

| Field | Atoms | Where main turns lexing on |
|---|---|---|
| `MxAttribute.value` (named, default, bound), `MxSpreadAttribute.value`, `MxShorthand.default` | yes | `ATTRIBUTE.ts` (value) |
| `MxAttribute.args`, `MxMethod.params` | yes: one position. The `(` after an attribute name opens the arguments expression with lexing on, and htmljs learns it was a method only when `{` follows (`ATTR_STAGE.ARGUMENT`, then `BLOCK`), so method parameters lex atoms (`<div onInput(a = :b) { x }/>` reports `:b`). Intended (decision 163 addendum 1) | `ATTRIBUTE.ts` (the `(` branch) |
| `MxMethod.body` | yes (a method body is an attribute value) | `ATTRIBUTE.ts` (the `{` branch) |
| `MxTag.args` | yes | `OPEN_TAG.ts` (tag arguments) |
| `MxPlaceholder.expression`, in every body mode | yes | `PLACEHOLDER.ts` |
| `${…}` in a dynamic tag name or a tag-adjacent shorthand | yes | `TAG_NAME.ts` (the `${` branch; the tag name state also reads the shorthands) |
| `${…}` of a template literal inside any of the above | inherited | `TEMPLATE_STRING.ts` |
| `MxTag.var`, `MxTag.params` (defaults included) | no | — (`OPEN_TAG.ts` enters them without `atoms`) |
| `MxTag.typeArgs`, `MxTag.typeParams`, `MxMethod.typeParams` | no | — (`ATTRIBUTE.ts` `<` branch, `OPEN_TAG.ts`: type expressions, no `atoms`) |
| `MxModuleStatement.code`, `MxScriptlet.code` | no (TypeScript statements, decision 156 addendum 2) | — |

Inside a lexed field, a `:` is an atom only where an expression is expected,
never as TypeScript's ternary, type or optional marker (decision 156 addenda
2 and 3; `PROVENANCE.md`, "Behaviour").

```mx
<input accept=[:title, :rename-all]/>
```

Offsets: atom `title` `[15, 21)`, atom `rename-all` `[23, 34)` (the `:` included).

### 4.4 `MxTrigger`

A syntax-table trigger (decision 182; design note
`language-extensions/core.md`, "The syntax table"). Only a table with
triggers produces one; the `.mx` default row has none, so no default-row
tree contains this node.

```ts
interface MxTrigger extends MxNodeBase {
  readonly type: "MxTrigger";
  readonly id: string;                                       // the table row's id
  readonly position: "expression" | "attribute" | "line";    // the list that armed it
  readonly text: string;                                     // the authored text the matcher matched, from `start`
  readonly value: MxExpression | null;                       // `=value` of an attribute or line trigger
}
```

Where it sits follows its position: an expression trigger is in the
`triggers` of the innermost container whose source holds it (beside its
`atoms`; the key is present only when non-empty); an attribute trigger is in
the tag's `attributes`, in source order; a line trigger (a tagless concise
line, decision 182 addendum 1) is a child of the enclosing body. The span
covers the text and, when there is one, `=value`. A container's payload is
parsed from the trigger's same-length stand-in (`&status` reads as
`_status`), and the one payload node at exactly the trigger's span carries
`extra.mxTrigger: { id, span, text }`. The front end lowers nothing: core's
`lowerTrigger` builds what the row's `node` rule says.

```mx
entity Order
  &title
  &amount=qty * price
```

Offsets: line trigger `&title` `[15, 21)`, line trigger `&amount` `[24, 43)`
with `value` `[32, 43)`.

### 4.5 `MxBlockTag`, `MxFilter`

A syntax table's block tag and filter (decision 182), in HTML content only
(never in a text-only tag's body, an attribute or a concise head). Both are
raw: the body is not parsed, and nothing here pairs `{% for %}` with
`{% endfor %}`; core's `lowerBlockTag` and `lowerFilter` do. The `.mx`
default row has neither.

```ts
interface MxBlockTag extends MxNodeBase {
  readonly type: "MxBlockTag";
  readonly value: string;      // the body between `blockTag.open` and the first `blockTag.close`
  readonly valueSpan: Span;
}
interface MxFilter extends MxNodeBase {
  readonly type: "MxFilter";
  readonly name: string;       // `filter.open`, a name, `filter.close`: the head
  readonly nameSpan: Span;
  readonly value: string;      // the body up to the next `filter.close`
  readonly valueSpan: Span;
}
```

```mx
<ul>{% for x in xs %}<li/>{% endfor %}</ul>
```

Offsets: block tag `[4, 21)` with `value` `[6, 19)`, block tag `[26, 38)`.

## 5. Positions

### 5.1 The rule

Every MX node has `start` and `end`: **0-based offsets into the original file,
in UTF-16 code units, half-open `[start, end)`** — the unit of a JavaScript
string index, which htmljs-parser already reports (`Range.start`/`end`,
`packages/parser/src/template/util/constants.ts` `Range`) and which the IR's `SourceSpan` uses
(`packages/core/src/mapping.ts` `SourceSpan`, documented as UTF-16 in
`packages/core/src/fragment.ts` `FragmentBase`). This is the IR spec's `SourceSpan`
rule exactly: half-open, UTF-16, file-absolute, CRLF's `\r` belonging to its
line, `source.slice` yielding the authored text (IR spec §3.2). No `Mx*` node
stores `loc`; the Babel payloads inside containers do, for the reason in §4.1.

What lowering derives: every IR node's `loc` is the **start** of the construct
as a 1-based line and 0-based column (IR spec §3.1), which is
`lineColumnAt(node.start)`; the statement kinds' `end: Position` is the
`lineColumnAt(MxModuleStatement.untrimmedEnd)` (§3.10), not `lineColumnAt(node.end)`; each IR span is the AST span of the node or sub-part
the IR spec's §3.3 table names (for example `Attr.nameSpan` ←
`MxAttribute.nameSpan`, zero-width at the `=` for the default value, which is
invariant E7; `Interpolation.span` ← `MxPlaceholder` span, delimiters
included; `Element.nameSpan` ← `MxTagName.span`, and for an attribute tag the
name **after** the `@`, IR spec §3.3, so lowering trims one unit off
`MxAttributeTag.name.span`).

### 5.2 Line and column

Obtained on demand through a front-end function, `lineColumnAt(document, offset)`
(decision 163 addendum 6): the line-start index, one entry per `\n` as htmljs's
`getLines` builds it (`packages/parser/src/template/util/util.ts`), is private to
it, and `MxDocument` stays plain data with no index member. It returns a **1-based
line and 0-based column** (Babel's convention, and what `TranslateError` and
the spec's structured fields carry, `apps/docs/docs/specification.md` ("The contract")
and "One base for every printed position (ruling #227)"). htmljs's own positions are LSP-style, 0-based line and
`character` (`packages/parser/src/template/util/constants.ts` `Position`); Marko adds 1 to the line
(`toBabelPosition`, `[C]chunk-src.js:6300-6303`), and MX does the same. A `\r`
is an ordinary column character (only `\n` starts a line), as in htmljs.

### 5.3 Fragments

A fragment parse takes `base = { offset, line, column }` with the meanings of
today's `FragmentBase` (`baseOffset`, zero-based `baseLine`, zero-based
`baseColumn`; `fragment.ts` `FragmentBase`) and its invariants (`baseOffset ===
baseColumn` on line 0; `baseOffset >= baseLine + baseColumn` otherwise).

- Every offset is `base.offset + local offset`, at creation; there is no
  post-hoc walk (today's `shiftNode`, `fragment.ts`, and its
  shared-position dedupe both disappear).
- `lineColumnAt` adds `base.line` to the line and, on the fragment's first
  line only, `base.column` to the column.
- A Babel sub-parse receives `startIndex = base.offset + local start`,
  `startLine = 1 + base.line + local line`, `startColumn` = local column plus
  `base.column` when on the first line. This is what `parseFragmentNative`
  already demonstrates through Marko's offset options (`fragment.ts`).

The IR spec states the required result, not the mechanism: "every `loc` and
every span in the IR is measured against the enclosing file", and a new
lowering over its own parser "has no reason to reproduce the shift mechanics"
(IR spec §3.4). Offsets at creation satisfy that. Parse errors are data
(§3.13), so the separately-shifted thrown error of today disappears too.

## 6. Mapping to the IR

IR kinds today: `packages/core/src/ir.ts` `IrNode` defines **16** `IrNode`
kinds (Text, Interpolation, Element, Component, IfChain, For, Define, Const,
Static, Import, Export, InputInterface, Hoisted, DelegatedTag, DocumentType,
Comment), plus `Attr`, `AttributeTag`, `Block`
and the `Ir` root (each its own type in `ir.ts`). The IR spec lists the same 16
kinds (IR spec §5.2) and is the reference for every field below.

**Where the AST enters the IR spec's pipeline.** The IR spec's step 1 (tree
rewrites before any tag name is read) turns sugar into `name`/`id`/`class`
attributes and resolves the unnamed tag, and says "a new parser may produce
that tree directly; it must not hand an unnamed tag to the walk" (IR spec §1).
The MX AST deliberately does **not** produce that tree: it keeps
`MxShorthand` and `MxTagName.unnamed`, because the default-tag ladder needs
the host's `resolveDefaultTag` and the ancestor chain, which a parser does not
have. Step 1 therefore stays in lowering and reads the AST: the
`MxShorthand`s become `Attr`s by the merge of §6.1a, and each unnamed name is
resolved before step 5. Steps 2 to 6 are unchanged.

**What the port must reproduce.** The port's contract is byte-identity with
MX's own output before the port (goldens, oracles), not Marko parity
(decision 157); a deliberate change of output is allowed only as its own
recorded change, never inside the port (decision 163).

### 6.1 IR kind ← AST

| IR | Lowered from | Fields |
|---|---|---|
| `Text` | `MxText`; also the empty `Text` `<return>` leaves (`lowerReturn`) and an inert disposition leaves | `value` ← `value`; `span` ← `valueSpan` (§3.8) |
| `Interpolation` | `MxPlaceholder` | `expr` ← `expression`; `escaped` ← `escape`; `span` ← node span |
| `Element` | `MxTag` resolved to a native element | `name` ← `name` (static, or unnamed after the ladder); `nameSpan` ← `name.span`; `attrs` ← `attributes` + `shorthands`; `children` ← `body`; `void` ← `VOID_TAGS` in lowering (`core.ts`, `lower.ts` `lowerAuthoredTag`), not `bodyMode` (§3.12) |
| `Component` | `MxTag` resolved to an import, discovered tag, `<define>` or dynamic name | `target` ← `name`; `args` ← `args`; `var` ← `var`; `content.params` ← `params`; `attributeTags*` ← `MxAttributeTag` children (and those inside `if`/`for` children); `content` ← the other children |
| `IfChain` / `Branch` | consecutive `MxTag`s `if`, `else-if`/`else if`, `else` | `condition` ← the default value `MxAttribute.value` |
| `For` | `MxTag` `for` | `source` ← `of`/`in`/`from`/`to`/`until`/`step` attributes; `key` ← `by`; `params`, `paramNodes`, `paramSpans` ← `params` |
| `Define` | `MxTag` `define` | `name` ← `var`; `params` ← `params` |
| `Const` | `MxTag` `const` | `name` ← `var`; `init` ← default value |
| `Static` | `MxModuleStatement` `static` only | `code` ← the statement span's text minus `static ` (§3.10); `span` ← node span |
| `Import` | `MxModuleStatement` `import` | `code` ← the statement span's text; `bindings` ← parsed `ImportDeclaration` (no regex) |
| `Export` | `MxModuleStatement` `export`, including `export type Input` | `code` ← the statement span's text |
| `InputInterface` | `MxModuleStatement` `export` whose payload is a `TSInterfaceDeclaration` named `Input` | `code` ← the statement span's text; no span (IR spec §3.3) |
| `Hoisted` | none (a host hook's output, decision 70) | — |
| `DelegatedTag` | `MxTag` claimed by the host (`isDelegatedTag`); also `MxModuleStatement` `server` on a host that claims it (html: `CLAIMED`, `targets/html/src/translate.ts`, which returns `{ kind: "statement", code }` sliced from the node, `resolveDelegatedTag`) | as `Element`, plus `args`, `var`, `params`, attribute tags; `alias` from a wildcard match (§3.15) |
| `DocumentType` | `MxDoctype` | `value` |
| `Comment` | `MxComment` | `value`; `html` ← `kind === "html"` |
| `AttributeTag` | `MxAttributeTag` | `name` ← `name.value`; `nameSpan` ← `name.span` minus the `@`; `span` ← node span; `attrs` ← `attributes` + shorthands; `block.params`/`hasParams` ← `params`; `block.children` ← `body` minus nested attribute tags; `hasBody` ← body content (`hasContent`); its own `attributeTags`/`attributeTagTree`/`attrTagProps` ← nested `MxAttributeTag` children, recursively (IR spec §8) |
| `Attr` `static` | `MxAttribute` with a string-literal value (any name, colons kept), or whose whole value is one atom (`atom` set); `MxShorthand` with a static value, by the merge of §6.1a | `valueSpan` ← `value.span` |
| `Attr` `static`, `value: ""` | `MxAttribute`, not bound, `value === null`, whose name contains a `:` that is an ordinary colon name: any colon name on a component, attribute tag or delegated tag, and on a native element any colon name except the reserved `class:`/`style:`/`on:` prefixes (`isOrdinaryColonName`, `lower.ts`). Today's condition is `name !== attr.name` at `lower.ts` `lowerAttrNamed`, `name` being the rejoined `attr.name:attr.modifier` (`lower.ts` `lowerAttrNamed`), so it covers `value:foo`, `x:foo` and the empty-suffix `x:` (`divergences.md`, row "Bare `:x` is `name="x"`") alike | `valueSpan` ← zero-width at `nameSpan.end` (IR spec §3.3) |
| `Attr` `boolean` | `MxAttribute`, `value === null`, whose name has no `:` (`lower.ts` `lowerAttrNamed`; a colon name takes the row above, a reserved-prefix name the `dynamic` row) | |
| `Attr` `dynamic` / `event` | `MxAttribute` with an expression value or `MxMethod`; also a reserved-prefix colon name on a native element (`class:x`, `style:x`, `on:x`) whose host `resolveModifier` returns a name, any value (`lower.ts` `lowerAttrNamed`; refused otherwise, `lowerAttrNamed`) | `event` derived from `name` (lowering), only on a native element with an expression value |
| `Attr` `bound` | `MxAttribute` with `operator === ":="` | `name` ← `name`; a refinement `v:fn:=q` is `refinement` (an identifier `Expr` over `fn`, with its span), as Marko's `q = fn(next)` change handler. A refinement that is no valid identifier (`x::=q`, `v:no-update:=q`) is Marko's positioned error at the colon (decision 169 was withdrawn; the earlier `:`-in-a-bound-name error is gone) |
| `Attr` named `#x` (`boolean`, `static`, `dynamic` or `bound` by its value) | `MxShorthand` `#` with `position: "attribute"` on a host that sets `claimsAttributeHash` (Angular's template reference, decision 146 addendum 3) | `name` ← the authored token (`#x`), `nameSpan` ← the node span, **no `sugar`**; its `default`, if any, is this attribute's value, not the tag's default value (today: `rewriteAttributes` leaves the attribute untouched, `name-sugar.ts`, and the host must also set `acceptsForeignAttrNames`; probe: `<div x=1 #r/>` gives `boolean` `#r`, `nameSpan` `[9, 11)`) |
| `Attr` `spread` | `MxSpreadAttribute` | |
| `Attr.sugar` | `MxShorthand` | ← the authored tokens, by the merge of §6.1a |
| `Attr.sugarValueOf` | `MxShorthand` with `default` | on the `value` `Attr` the default makes: the token plus `=…` or `(…)` (`#x=…`), §6.1a |
| `Ir.returnValue` | `MxReturn`'s default value (§3.14) | |

### 6.1a The shorthand merge, a lowering step

Today Marko's front end merges tag-adjacent shorthands (`onOpenTagEnd`,
`[C]chunk-src.js:6143-6171`), and `core/src/name-sugar.ts` merges the
attribute-position ones on top (`rewriteAttributes`, `mergeClassTokens`); the
`Attr` fields then come from `lowerAttr`/`lowerAttrNamed`/`attrNameSpan`
(`lower.ts`). With the MX AST the whole merge is lowering's. It reproduces
main as it is after #338 (`666d0f56e`, real `nameSpan` for a tag's own
shorthand) and `474258b65` (a dynamic shorthand's `nameSpan` covers
its sigil), field by field.

Order and grouping:

1. All `.` shorthands of a tag become **one** `class` `Attr`; tag-adjacent `#`
   becomes one `id` `Attr`. Tag-adjacent `class` comes before `id`
   (Marko pushes class first, `[C]chunk-src.js:6148-6170`).
2. Attribute-position `.x` tokens are merged into that `class` (or start one at
   the first token's position if there is none); attribute-position `#x` is
   its own `id` `Attr` at its position. Marko's shorthand `class`, when
   present, is moved before the first attribute-position `id`, and a
   tag-adjacent `id` beside an attribute-position `#` is moved first
   (`rewriteAttributes`, end). Duplicates then resolve last-wins with decision
   135's warning (`<div#a #b/>` keeps `id "b"`).
3. A tag-adjacent `#x` beside an authored `id=` is an error ("Cannot have
   shorthand id and id attribute.", `[C]chunk-src.js:6168`).
4. `:name` becomes a `name` `Attr` at its own position, `static`, with
   `atom` set (§4.3).
5. A sugar's `default` becomes a separate default value (`value`) `Attr`
   right after the sugar's own, with `sugarValueOf` the token plus `=…` or
   `(…)`, its `nameSpan` zero-width at the value, and `loc` at the value.
   A second default value on the tag, when at least one comes from a sugar,
   is the error `MX_DUPLICATE_DEFAULT` at the second ("`#x=…` would set the
   default attribute (`value`), but the tag already has a default value (at
   …)", `ALREADY_HAS_DEFAULT`); two authored `value=` stay decision 135's
   warning; a host that claims `#` exempts attribute-position `#x` (P8).

The `class` value, by case (probed on main from source, `lower()` with a
plain element host; offsets in each input alone):

| Input | `kind`, value / `code` | `valueSpan` | `nameSpan` | `loc` | `sugar` |
|---|---|---|---|---|---|
| `<div#a.b.c/>` (all static, tag-adjacent) | `static` `"b c"`; `id` `static` `"a"` | `[7, 10)` (first value to last); id `[5, 6)` | `[6, 10)`; id `[4, 6)` (sigil + value) | the tag (`1:0`) | none |
| `<div.${x}/>` (one dynamic) | `dynamic` `x` | — | `[4, 9)` (`.${x}`) | the tag | none |
| A tag-adjacent `class` or `id` whose merged value has **no `loc`**, with no attribute-position token of the same name and no authored attribute of that name. Marko builds such a value in two places: the array it makes from two or more class parts that are not all static (`onOpenTagEnd`, `[C]chunk-src.js:6150-6153`, `arrayExpression` with no `withLoc`), and the template literal it makes for one part that is neither plain text nor a single `${…}` alone: text beside a `${…}`, or two or more `${…}` (`parseTemplateString`, `[C]chunk-src.js:5967-5972`, `parseTemplateLiteral`, reached when the part has two or more expressions, or one with a non-empty text part). Probed examples: `<div.a.${x}/>`, `<div.${x}.${y}/>`, `<div.${x}.a/>`, `<div.a.${x}.b/>`, `<div#i.a.${x}/>` (class), `<div.a${x}/>`, `<div.${x}a/>`, `<div.${x}${y}/>` (class, one part), `<div#a${x}/>`, `<div#${x}${y}/>`, `<div#a${x} .b/>` (id) | `dynamic`: an array in written order (`["a", x]`, `[x, y]`, …) or a template (`` `a${x}` ``, `` `${x}${y}` ``); generator output, §7.1 | — | **`{ NaN, NaN }`: a bug**, MX1 TODO `shorthand-dynamic-class-nan-namespan` (scope: any merged shorthand value with no `loc`; intended span: first sigil to the end of the last token); fixed before the port, which carries nothing | the tag | none |
| Counter-examples, real spans: one part that is a single `${…}` (`<div.${x}/>`, `<div#${x}/>`: the expression itself, which has a `loc`), a single `${"…"}` string (`<div.${"a"}/>`: Marko's `withLoc` wrap, `[C]chunk-src.js:5962-5963`), or the same values with an attribute-position `.` (`<div.a${x} .b/>`) or an authored `class` (`<div.a${x} class="y"/>`) | as their rows | — | `[4, 9)`, `[4, 9)`, `[4, 11)`; `[11, 13)` (`.b`); `[11, 16)` (`class`) | the tag; `1:11`; `1:11` | none; `".b"`; none |
| `<div.${x}.a .b/>`, `<div.a.${x} .b/>` (the same, plus an attribute-position `.`) | `dynamic` `[x, "a", "b"]`, `["a", x, "b"]` | — | `[12, 14)` (`.b`) | `1:12` | `".b"` |
| `<div.a.${x} class="y" .d/>` | `dynamic` `["a", x, "d", "y"]` (the token joins the shorthand part, before the authored value) | — | `[22, 24)` (`.d`) | `1:22` | `".a .d"` |
| `<div.${x} class="y" .d/>` | `dynamic` `[x, "d", "y"]` | — | `[20, 22)` | `1:20` | `".d"` |
| `<div.a.b .c/>` | `static` `"a b c"` | `[5, 8)` | `[9, 11)` | `1:9` | `".a .b .c"` |
| `<div.a.b class="x"/>` (static + authored string) | `dynamic` `` `${"a b"} ${"x"}` `` (generator output) | — | `[9, 14)` (`class`) | the `class` attribute | none |
| `<div.a class=y/>` (static + authored expression) | `dynamic` `["a", y]` | — | `[7, 12)` (`class`) | the `class` attribute | none |
| `<div.a.${x} class="y"/>` | `dynamic` `["a", x, "y"]` | — | `[12, 17)` (`class`) | the `class` attribute | none |
| `<div.a .b/>` (tag-adjacent + attribute-position) | `static` `"a b"` | `[5, 6)` (the first token only) | `[7, 9)` (the first attribute-position token) | `1:7` | `".a .b"` |
| `<div.c class="x" .d/>` | `dynamic` `` `${"c d"} ${"x"}` `` | — | `[17, 19)` (`.d`) | `1:17` | `".c .d"` |
| `<div class="x" .d/>` (authored string + attribute-position) | `static` `"x d"` | `[11, 14)` (the authored literal) | `[15, 17)` | `1:15` | `".d"` |
| `<div class=y .d/>` | `dynamic` `[y, "d"]` | — | `[13, 15)` | `1:13` | `".d"` |
| `<div x=1 .c#m.d/>` (attribute-position chain) | `static` `"c d"`; `id` `static` `"m"` | `[10, 15)`; id `[12, 13)` | `[9, 15)`; id `[11, 13)` | `1:9`; id `1:11` | `".c .d"`; `"#m"` |
| `<div #x=1/>` | `id` `static` `"x"`; then `value` `dynamic` `1` | `[6, 7)` | `[5, 7)`; `value` `[8, 8)` | `1:5`; `1:8` | `"#x"`; `sugarValueOf` `"#x=…"` |

Rules behind the table (`mergeClassTokens`, `attrNameSpan`,
`lowerAttrNamed`). Today these are in-place edits of Marko's nodes; the port
builds each resulting value as a **new** node and never edits a payload
(§4.1a). Value:

- Tag-adjacent only (Marko's merge, `[C]chunk-src.js:6148-6171`): one part
  is that part; several all-static parts are one string joined by spaces;
  otherwise an array of the parts in written order. Beside an authored
  `class`: both strings gives the template `` `${shorthand} ${class}` ``;
  anything else an array, shorthand parts first.
- Attribute-position `.` tokens (all static) are joined by spaces into one
  string and merged by cases (`mergeClassTokens`): no `class` yet, a new
  `static` attribute; a shorthand-only `class` (no authored attribute), the
  string grows when it is one string, else the token is appended to the
  array (a single expression becomes `[expr, token]`); a `class` that holds
  shorthand parts beside an authored value, the token joins the last
  shorthand part (a single string part grows, else the token is inserted after
  it), so it lands before the authored value; an authored string literal with
  no shorthand, the token joins the literal on the side it was written; an
  authored `false`, `0`, `null` or `undefined` is replaced by the token; an
  authored other number or `true` is joined with the token into one string;
  any other authored value becomes an array in written order.

`nameSpan`: from the first to the last attribute-position token when such
tokens took part; else (no own position) the value's span plus the sigil
before it, `${`/`}` included for a single dynamic part; else the authored
`class` name. When none of these exists, which happens exactly when the value
Marko merged has no `loc` and nothing else gave the attribute a position, the
span is `NaN` (the bug row above): `attrNameSpan` then falls through to
`offsetOf` on an empty position.

`loc`: the first attribute-position token when such tokens took part; else
the authored attribute; else the tag.

`sugar` (the label), set only when an attribute-position token took part:
the tag-adjacent words, then the attribute-position tokens, each with its
`.`. The tag-adjacent words are included only when they are one static
string (`mergeClassTokens`, `mark`): for a shorthand-only `class`, when the
merged value is a string literal (`<div.a.b .c/>` gives `.a .b .c`;
`<div.a.${x} .b/>` gives `.b`); beside an authored value, the words of the
first shorthand part when it is a string literal (`<div.a.${x} class="y"
.d/>` gives `.a .d`; `<div.${x} class="y" .d/>` gives `.d`). Dynamic parts
never appear in it.

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
| `MxModuleStatement` | Import, Export, Static, InputInterface; DelegatedTag (`server` on html); nothing (an `inert` disposition) or an error (`client`, `class`) |
| `MxComment` | Comment (body); none (open-tag position) |
| `MxDoctype` | DocumentType |
| `MxScriptlet`, `MxCDATA`, `MxDeclaration` | none: errors (`lower.ts` `lowerChildList`) |
| `MxParseError` | none: a diagnostic |
| `MxAtom` | `Expr.atoms`, `Attr.atom` (§4.3) |

### 6.3 Gaps

The IR needs, and the AST as drafted does not carry:

- **Resolution facts**: which tag is native, a component, a define, a custom
  tag; the binding registry; `Element.void`, which is lowering's (`VOID_TAGS`,
  `core.ts`), not a parse fact. These are lowering's by design.
- **`Expr.code` after rewrites** and `ExprShape`: derived in lowering from
  `source` + `node`.

The AST carries, and no IR kind reads:

- `MxComment.kind` `line` vs `block` (IR has only `html: boolean`), and
  open-tag comments.
- `typeArgs`, `typeParams` (rejected today, `core.ts` `rejectUnsupportedFields`).
- `MxTag.openTag`/`closeTag` spans, `concise`, `selfClosed` (tools only).
- `MxCDATA`, `MxDeclaration`, `MxScriptlet` (errors only).
- `MxText.span` beyond `valueSpan` (newline-led whitespace; formatters only).

### 6.4 Who sees the AST and who sees the IR

| Extension point | Sees | Evidence |
|---|---|---|
| Custom-tag sidecars, L2 hooks (decision 87) | IR: a `TagCall` of `Attr[]`, `Block`, `AttributeTag[]` | `packages/core/src/custom-tags.ts` |
| Sidecar `parseOptions` | neither; they configure the parse | `custom-tags.ts` `customTagTaglib` (only `text`, `preserveWhitespace` reach the parser) |
| L3 raw hooks (decision 87(b): Marko's exact signatures, MX 1 only) | would see Marko's AST; **not implemented** | no `raw` field in `custom-tags.ts` (the only `raw` match is a comment in `IrBuilders`) |
| User tag macros (decision 80) | IR in, IR out, by design | decision 80 text |
| Host **emitters** (`Emitter<Out>`), first- and third-party (decision 148) | IR only | `packages/core/AGENTS.md`, opening section ("A host then emits from that IR and never walks a Marko node"); IR spec §5.13 |
| Host **declarations** (`HostDeclarations` hooks), first- and third-party | **parser nodes** today (Marko's); after the port a narrow view built by lowering, never `Mx*` nodes | the table below |
| The tree target's unknown-tag scan (first-party) | Marko's AST directly today (`scanAuthoredTags`, `packages/targets/data/src/scan.ts`); ported to the MX AST in the same change as `lower()` (ruling Q12) | — |

**The view the hooks receive after the port** (ruling Q19, decision 163,
widened by addendum 1). The hooks are re-typed in the port change, but not to
`Mx*` nodes: that would make the whole AST public API of `@mxlang/core`
through third-party hosts (decision 148), and every later AST edit a
host-breaking change. Lowering builds a narrow view, as plain data, and hands
that over:

```ts
interface HostTagView {
  name: string;                 // the tag name; for a module statement, its keyword
  nameSpan: Span;
  span: Span;                   // the whole tag, or the statement span of §3.10
  attributes: (                // what lowering produced, in source order
    | { kind: "attribute";
        name: string;           // before the last `:` (Marko's split, as hooks read it today);
                                // "value" for a default value
        modifier: string | null; // after the last `:`; null without one
        nameSpan: Span;         // zero-width at the `=` for a default value (Q8)
        value?: Expr }
    | { kind: "spread"; span: Span; value: Expr }
  )[];
  var: { span: Span } | null;                   // the tag variable's pattern range, when written
  attributeTags: { name: string; span: Span }[]; // `@`-names as written, in source order
  params: { span: Span; count: number } | null; // the body parameters, when pipes were written
  dynamicName: Expr | null;                     // the `<${…}>` name expression
  handle: MxNodeHandle;                         // opaque, below
}
```

Every field, and the hook that reads it today (opened on main):

| Field | Read today by | File, symbol |
|---|---|---|
| `name` | every tag hook's message (most hooks also receive it as an argument) | all hosts below |
| `span` | every `fail`/`rawFail(msg, node)` position; html's `server` code slice | html `translate.ts` `resolveDelegatedTag` (`sliceLoc(ctx, node.loc)`), `rejectComponentTag`, `rejectUnknownTag`; Preact `emitter.ts` `createJsxDeclarations` (`resolveDelegatedTag`, `rejectUnknownTag`; also React and Hono); Solid `emitter.ts` `rejectUnknownTag`, `solidDeclarations.resolveDelegatedTag`; Angular `emitter.ts` `rejectUnknownTag`, `resolveDelegatedTag`; Astro `astro-template.ts` `rejectUnknownTag`, `resolveDelegatedTag`, `rejectComponentTag`; data `declarations.ts` `rejectComponentTag` (`node.loc.start`) |
| `attributes[].name`, `.modifier` | `rejectModifier` (all five implementations build `name:modifier`; Solid keys its replacement on `name`) | html `translate.ts` `rejectModifier`; Preact `emitter.ts` `createJsxDeclarations`; Solid `emitter.ts` `solidDeclarations`; Angular `emitter.ts` `rejectModifier`; Astro `astro-template.ts` `rejectModifier`, `rejectAttributeMethod` (`attr.name`) |
| `attributes[].nameSpan` | the position of those errors | as above |
| `attributes[].value` | html's `<let>`/`<const>` initial value (`attrByName(node, "value") ?? node.attributes[0]`, then `.value`) | html `translate.ts` `resolveDelegatedTag` |
| `var` | html's `<let>`/`<const>` "without a variable name" check (`!node.var`) | html `translate.ts` `resolveDelegatedTag` |
| `attributeTags` | the first attribute tag's name and position; html's `<try>` `@placeholder` lookup | html `translate.ts` `policy.rejectElementAttributeTags`, `resolveDelegatedTag` (`<try>`); Astro `astro-template.ts` `rejectElementAttributeTags` |
| `params` (`count`) | Astro refuses tag params on a component only when there is at least one (`node.body.params.length`) | Astro `astro-template.ts` `rejectComponentTag` |
| `dynamicName` | the dynamic tag's target expression (`expr(ctx, node.name)`, `node: node.name`, its span) | html `translate.ts` `resolveDelegatedTag` (`DYNAMIC_TAG`); Angular `emitter.ts` `resolveDelegatedTag` |

What `attributes` holds (decision 163 addendum 4, item 2): what lowering
produced, as hooks see the post-rewrite node today. A default value is an
entry named `"value"` with a zero-width `nameSpan` (the Q8 adapter); a spread
is its own entry kind, in source order, so `attributes[0]` means the first
authored entry; attributes made from shorthands (`class`, `id`, `name`, a
sugar's default value) appear as the merge of §6.1a produced them. The one
hook that reads `node.attributes` on main, html's `<let>`/`<const>` in
`translate.ts` `resolveDelegatedTag`, reads `attrByName(node, "value") ??
node.attributes[0]`, then its `.value` (`core.ts` `attrByName` skips
spreads):

| `<let>` / `<const>` input | Today | With the view |
|---|---|---|
| default value (`<let/x=1/>`) | `attrByName` finds it (Marko names it `value`) | the `"value"` entry |
| `value=1` | found by `attrByName` | the same |
| a spread first (`<let/x ...y/>`) | no `value`, so `attributes[0]` is the spread and its `.value` (`y`) becomes the initial value; `validateBuiltinValueAttributes` (`lower.ts`) does not reject it for `let`, and rejects any second attribute for `const` | `attributes[0]` is the spread entry, `.value` the same `Expr` |
| a shorthand (`<let.a/x/>`) | the merged `class` is `attributes[0]` (the post-sugar tree), so its `.value` becomes the initial value | the merged entry, the same |
| nothing | `"undefined"` | the same |

Probed through `lower()` with a host that claims `let` and makes html's read (`attrByName(node, "value") ?? node.attributes[0]`): `<let/x ...y/>` picks the spread, initial value `y`; `<let.a/x/>` picks `class`, `"a"`; `<let/x=1/>` and `<let/x value=2/>` pick `value`; `<let/x/>` picks nothing.

`resolveModifier` has no implementation in any host on main; `resolveAttributeMethod`
is `() => true` wherever it is set (Preact, Solid, Angular, data) and reads
nothing. `resolveDefaultTag` receives the parents as views: every host passes
them to core's `contractDefaultTag`, which reads `name`, `attributeTag`, the tag
definition and, through the handle, the wildcard match (`wildcard-resolve.ts`
`wildcardMatchOf`). The tag definition today is Marko's `tagDef`
(`DefaultTagParent.tagDef`), and `isStructural` (`contract-default-tag.ts`)
reads only its `html` flag: a name the lookup knows that is not an element is
structure. With Marko dropped it comes from the target's element-shape table
(§3.12), which records, per known name, whether it is an
element.

**The handle.** `MxNodeHandle` is opaque: it has no fields, is not
serialisable, and is valid only during the hook call. Only core's exported
helpers can resolve it to the AST node, so a third-party host cannot read
through it. Hosts keep their call sites: **no check moves**, so error order and
text are untouched by the port. The reads served through the handle today:

| Read | Helper | Called from |
|---|---|---|
| attribute tags (first name and position), tag arguments (presence, first argument's position), tag variable (presence, and its printed text in the message), type arguments and type parameters (presence), body parameters (at least one) | `rejectUnsupportedFields` (`core/src/core.ts`) | html `translate.ts` `resolveDelegatedTag` (`<html-comment>`, `<html-script>`, `<html-style>`, `<style>`, `<let>`/`<const>`); Astro `astro-template.ts` `resolveDelegatedTag` (`<html-comment>`) |
| whether the tag variable binds a given name | `bindingSpan(target, name): Span \| null` (a handle or a pattern payload) (decision 163 addendum 4, item 1), the one generic core helper; core has no `input` rule | html's `rejectInputShadowing` (`translate.ts`), from `resolveDelegatedTag` (`<let>`/`<const>`) |
| the wildcard match of a parent | `contractDefaultTag` / `wildcardMatchOf` (`core/src/contract-default-tag.ts`, `wildcard-resolve.ts`) | every host's `resolveDefaultTag` |

**`bindingSpan(target, name): Span | null`.** `target` is a view's handle
(the tag variable inside it) or a binding pattern payload (a plain Babel
pattern, as `checkBinding` receives). It returns the span of the binding
identifier named `name` inside that pattern, the first in source order, or
`null` when the pattern binds no such name. It finds exactly the identifiers html's
`bindingNames` (`translate.ts`) finds today: the pattern itself when it is an
identifier; in an object pattern, each property's value (shorthand
`{ input }`, renamed `{ a: input }`) or rest argument (`{ ...input }`); in an
array pattern, each element, holes skipped; through a default, its left side
(`{ input = 1 }`, `[input = 1]`); and a rest element's argument. html keeps its
check, its message and its position: `rejectInputShadowing` uses
`bindingSpan(…, "input") !== null` as the presence test, called with
whichever it holds (the handle from `resolveDelegatedTag`, the pattern from
`checkBinding`), and fails at the
start of the pattern, as today (core `fail` reports `target.loc.start`, the
pattern node's start). That start equals
`view.var.span.start`: the view's `var` span is the pattern payload's range,
which starts at the first character after `/` (probe: `<let/x=1/>`,
`<let/{ a: input }=1/>` and `<let/[b, input]: T=1/>` all start at offset 5,
before any type annotation). html's `checkBinding` keeps calling the same
function on the Babel pattern it already receives, which passes that pattern
to `bindingSpan` and fails at its start, as today. (Addendum 4 item 1, applied
as option (a) by the lead under decision 163's frame.)

`server` and `client` are `MxModuleStatement`s in the AST where the target's
statement set includes them (§3.10), and route through the same machinery as
tags (ruling Q5/P5): first the host's `declarations.tags` disposition
(`inert`/`error`, with `rejectInertShape`, `lower.ts` `lowerAuthoredTag`,
which is how html's `client` disposition, `targets/html/src/translate.ts`
`TAGS`, applies), then `isDelegatedTag` / `resolveDelegatedTag`
(`lower.ts` `lowerAuthoredTag`) with the statement's view, so html's `server`
stays a `DelegatedTag` `{ kind: "statement" }` whose code html slices from the
view's `span` (today from `node.loc`, `translate.ts` `resolveDelegatedTag`).
The view's fields are the decision text; its TypeScript names are the port's.

The `HostDeclarations` hooks (`packages/core/src/declarations.ts`
`HostDeclarations`) and what each receives:

| Hook | Receives today | Receives after the port |
|---|---|---|
| `resolveDelegatedTag(name, node, ctx)` | `MarkoTag` | the tag's view, or a module statement's (`server`) |
| `rejectModifier(attr, on)`, `resolveModifier(attr, on)` | `MarkoAttribute` | an attribute entry of the view |
| `rejectAttributeMethod`, `resolveAttributeMethod` | `MarkoAttribute` | an attribute entry |
| `resolveDefaultTag(node, parents, context)` | `MarkoTag` (+ `DefaultTagParent.node`) | the tag's view (and its parents' views) |
| `rejectElementAttributeTags`, `rejectComponentTag`, `rejectUnknownTag` (`name, node, ctx`) | `MarkoTag` | the tag's view |
| `checkBinding(target, what)` | a Babel `LVal` | the `MxPattern` payload (a Babel node, not an `Mx*` node) |
| `claimsAttributeHash` (flag) | — | — (decides the `#x` row of §6.1 and the `#` exemptions of §3.6 and §6.1a, P8) |

Every host `fail`/`rawFail(msg, node)` reads the node's position; after the
port it takes a view (or an attribute entry) and reports
`lineColumnAt(span.start)` (or `nameSpan.start`).

**After the port, possibly.** Moving the checks the handle serves into
lowering (hosts pass flags, not nodes) would remove the handle; reporting
html's `input` collision at the identifier (`bindingSpan`'s span) instead of
the pattern start would be a better position. Neither is part of the port:
each changes output (which error fires first, or where), so each is its own
change with its own goldens, if it is made.

## 7. Mapping from parser events

htmljs-parser 5.18.0 defines 27 handlers (`[H]util/constants.d.ts:64-90`); the
in-repo template parser adds a 28th, `onAtom` (decision 156; source
`packages/parser/src/template/util/constants.ts` `ParserOptions`).

| Event | Payload | MX node or field |
|---|---|---|
| `onAtom` | `Value` (range: the whole atom; `value`: its name) | one `MxAtom` in the enclosing container's `atoms`, in source order (§4.3) |
| `onTrigger` | `Trigger { id, position, standIn, text, value? }` (range: the text, then `=value`) | one `MxTrigger` (§4.4): in the enclosing container's `triggers`, in the tag's `attributes`, or a body child |
| `onBlockTag` | `Value` (range: the whole form; `value`: its body) | `MxBlockTag`, a body child (§4.5) |
| `onFilter` | `Filter { name, value }` | `MxFilter`, a body child (§4.5) |
| `onText` | `Range` | `MxText`; normalized with lookahead as Marko, except in a preserving body (§3.8, §3.12) |
| `onPlaceholder` | `Placeholder { value, escape }` | `MxPlaceholder` |
| `onComment` | `Value` | `MxComment` (kind from the source, as `getCommentKind`) |
| `onCDATA` | `Value` | `MxCDATA` |
| `onDeclaration` | `Value` | `MxDeclaration` |
| `onDoctype` | `Value` | `MxDoctype` |
| `onScriptlet` | `Scriptlet { value, block }` | `MxScriptlet` (keeps `block`) |
| `onOpenTagStart` | `Range` | `MxTag.start`, `openTag.start` (Marko does not handle it; it derives the start from the name, `[C]chunk-src.js:6075`) |
| `onOpenTagName` | `Template` | `MxTag.name` (or `MxAttributeTag.name` for `@…`); returns nothing: the type comes from `tagTypes` (§3.12), checked against `tagShape(name)`; for a static name, splits at the first `:` (§3.3); records `MX_STATEMENT_IN_HTML_MODE` / `MX_RESERVED_TAG_NAME` (§3.2) |
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
| `onCloseTagName` | `Range` | `closeTag.name`/`nameSpan`, the written name with sugar (`</div:x>` → `"div:x"`); for `</>` htmljs emits it with an empty range (`packages/parser/src/template/states/CLOSE_TAG.ts` `ensureExpectedCloseTag`, `core/Parser.ts` `Parser.closeTagEnd`), which gives `name: null`, `nameSpan: null`. Never re-checked: htmljs reports `MISMATCHED_CLOSING_TAG` (21) itself |
| `onCloseTagEnd` | `Range` | `closeTag.span.end`, `MxTag.end`; ends a preserving body started by this tag; nothing moves |
| `onError` | `Error { code, message }` | `MxParseError` (`origin: "template"`, code by name); the last event of the parse: open tags become `incomplete`, `complete: false` (§3.13) |

### 7.1 Inputs from outside the source text

Every option or signal Marko's front end reads that does not come from the
source, and where it comes from for the MX front end. A node field may only
depend on an input marked "front end" in the last column.

| Marko input | Read at | Today's sources | MX front end |
|---|---|---|---|
| `tagDef.parseOptions.openTagOnly` → `TagType.void` | `[C]chunk-src.js:6084` | built-in element taglibs (`marko-html.json` `[C]chunk-src.js:3057`, MathML `:5175`, SVG `:5348`); `core-tags.json` | **front end**, via `tagShape(name)` → `bodyMode: "void"`. Not for custom tags (§3.12) |
| `tagDef.parseOptions.text` → `TagType.text` | `:6085` | built-in taglibs (`<script>`, `<style>`, `<textarea>`), `core-tags.json`, custom tags (`custom-tags.ts` `customTagTaglib`), the tree target's overrides (`targets/data/src/taglib.ts` `neutralizations`) | **front end**, via `tagShape` → `"parsed-text"` / `"parsed-text-preserve"` |
| `tagDef.parseOptions.preserveWhitespace` | `:6082` | as above (`<pre>`, `<script>`, `<style>`, `<textarea>`; custom tags `custom-tags.ts` `customTagTaglib`; data overrides) | **front end**, via `tagShape` → `"preserve"` / `"parsed-text-preserve"`; decides `MxText.value` |
| `tagDef.parseOptions.statement` → `TagType.statement` | `:6083` | `core-tags.json` (`<import>` through `<class>`) for html; the data taglib's three; none on the other hosts (§3.10) | **front end**: the statement keyword set, supplied per target (§3.10), on a concise top-level line |
| `tagDef.parseOptions.rawOpenTag` → `rawValue` | `:6173-6177` | `core-tags.json` statement tags, `<style>` | dropped (A18) |
| `tagDef.parseOptions.controlFlow` and `tagDef.controlFlow` | `:6196`, `:6200` | `core-tags.json` (`<if>`, `<else>`, `<else-if>`, `<for>`) | moves to **lowering** (attribute tags are not moved, D2) |
| `tagDef.parser` hook (parse visitors) | `:6184-6191` | none in MX: `core-tags.json` and `customTagTaglib` carry no `parser` | dropped |
| `htmlParseOptions.preserveWhitespace` (file-wide) | `:5898-5899` | not passed by MX (`fragment.ts` `parseFragmentNative` passes only offsets, in the unused `parseFragmentNative`) | dropped |
| `tagDiscoveryDirs` (`tags/*.marko` found by Marko's scanner) | taglib lookup | the html target passes `["tags"]` (`targets/html/src/compiler.ts` `host`) | **dropped** with `@marko/compiler` (ruling Q22): no `marko-tag.json`/`marko.json` exists, and the two discovered `.marko` tags (`targets/html/fixtures-marko/tags-discovery/tags/badge.marko`, `fixtures-marko/try-child-throw/tags/boom.marko`) carry no parse options (a `.marko` file can only get them from a `marko-tag.json`), so nothing depends on it |
| Babel parser options (`typescript` plugin, `allow*` flags) | `:6699-6705` (`manipulateOptions(opts) {` is at `:6699`) | the compiler | **front end**, fixed configuration of the expression sub-parser |
| The expression sub-parser itself | `parseExpression` and friends, `[C]chunk-src.js:947-1016` | Marko's bundled `@babel/parser` **7.29.7** (`[C]babel.js`, region `@babel+parser@7.29.7`) | **front end**: MX's Babel fork (`packages/babel/src`, from `@babel/parser` 7.29.8). It must produce node shapes equal to today's, including `extra.raw`, `extra.parenthesized` and comments, or emitted code changes (ruling Q13/P3) |
| The generator and Babel support packages | `printExpression` (`core/src/compile.ts`, `generator(node, { concise: true })`); `expr()` for loc-less nodes; `declName` | Marko's bundled `@babel/generator`, `@babel/traverse`, `@babel/types` **7.29.7** (`[C]babel.js`; `markoBabel`, `core/src/core.ts`) | **lowering**, not the front end: the port pins `@babel/{types,traverse,generator}` at 7.29.7 with today's generator options (`concise: true`). The generator is part of the byte contract: it prints `Const.name`, `Define`/`Component.var`/`DelegatedTag.var` names, unsliceable `For` params, attribute-method values and dynamic tag names, and rewrites authored text (`<const/{ a,b }=x/>` gives `"{ a, b }"`, the reviewer's probe c). Replacing generator output with source slices is wanted, but as a separate recorded change after the port (TODO `ir-generated-text-to-source-slices`) |
| `file.___hasParseErrors`, `watchFiles` | `:1028`, `:6190` | internal | dropped (errors are data; dependency tracking is core's) |

So the front end takes two required external inputs, both supplied per
target: the statement keyword set (§3.10) and `tagShape(name) → bodyMode`,
supplied by core from the active target (its element shapes, the core tags,
the custom tags' `text`/`preserveWhitespace`, and a target's overrides such
as the tree target's). `tagShape` must answer any string without throwing
(`"html"` for a name it does not know): the front end asks it about every
candidate name of the source, not only about tags (§3.3), and it must answer
`"html"` or `"preserve"` for a statement keyword, whose HTML-mode spelling is
parsed as html. Two more are optional (decision 182): `syntax`, the syntax
table (the `.mx` default row when omitted), and `tagTypes`, the template
parser's tag types keyed by the full written static name (§3.12). The
template parser takes every tag's type from that table and from nothing
else; when the caller does not pass it, the front end builds it before the
parse from `tagShape` and the keyword set (interim until core builds it).
A caller's `tagTypes` is checked against the statement rule before the
parse, and a contradiction is a `TypeError`: a keyword may only be
`statement` (it is filled in when absent) and no other name may be. Every
other decision Marko made from a tag definition moves to lowering or
disappears. The element-shape table is the target descriptor's, with a core
default (§3.12, ruling Q21).

**Events the MX patch adds or changes.** One added: `onAtom` (atoms,
decision 156; `packages/parser/src/template/PROVENANCE.md`, "Atoms"). The
patch
(`patches/htmljs-parser@5.18.0.patch`, hunks at `dist/index.js` 311, 1147,
1382, 1432, mirrored in `index.mjs`; the same rules live as source in
`packages/parser/src/template/states/ATTRIBUTE.ts` `ATTRIBUTE` and
`packages/parser/src/template/states/EXPRESSION.ts` `EXPRESSION`, `lookAheadForOperator`,
`isIdentStartCode`) changes **where `onAttrValue` ends**:
it marks named-attribute and spread values (`expr.attrValue`), skips `??`
and `?.` when counting ternary depth, and inside such a value lets a `:`
followed by an identifier (or a bare `:` at a tag end) and a `.` followed by an
identifier, after whitespace, terminate the value so `onAttrName` fires for the
next sugar (decision 146 §3). Atom lexing lives in `EXPRESSION` too
(`lexAtom`), turned on per expression by the states listed in §4.3, and
reported through `onAtom`; while it is on, `read()` returns the atom's numeric
stand-in, so a front end that slices `source` for an expression's text must
not use `read()` for it.

## 8. Design choices and alternatives

Names in *italics* (*MxIf*, *MxFor*, *MxConst*, *MxImport*, *MxExport*,
*MxStatic*, *MxInputInterface*) are rejected alternatives, not node types;
the node types are listed in the appendix.

**D1. One `MxAttribute` node with a nullable name, plus a separate
`MxShorthand`.** Alternative: one `MxAttribute` with `kind: "named" |
"default" | "sugar"`. Chosen because sugar has a sigil, a position and an
optional `default` that named attributes never have, and a default value is a
named attribute without a name, not a third shape.

**D2. Flat children list; attribute tags stay where they were written.**
Alternative: typed slots (`body`, `attributeTags`) filled by the front end, as
Marko does. Chosen because lowering already rebuilds the structure from source
order (three views, `lower.ts` `mergeBySourceOffset`), moving changes spans' parentage,
and Marko's move depends on `controlFlow` taglib flags the AST should not know.

**D3. Structural tags are `MxTag`, only `<return>` is its own node.**
Alternative: *MxIf*, *MxFor*, *MxConst* nodes. Chosen because a structural
name can be shadowed by a file-local binding (spec §7, decision 113), so the
front end cannot know; `<return>` cannot be shadowed (reserved word) and
decision 158 names it.

**D4. Attribute names keep their colons, and the last-colon split is data.**
Decision 170: `MxAttribute.name` is the authored name (`class:x`, colons
included) **and** the node carries `modifier` + `modifierSpan`, the split at
the last `:` as fields. Alternative: keep Marko's split as the name itself.
Chosen because MX's lowering re-joins the split for every
name except the `class:`/`style:`/`on:` prefixes (`lower.ts` `isOrdinaryColonName`,
`lowerAttrNamed`), so the authored name is what MX means, while the split as
data removes every consumer's string re-derivation. A trailing colon (`x:`)
is an empty modifier with a zero-width span.

**D5. Spans only, no stored `loc`.** Alternative: Babel-style `loc` on every
node. Chosen because offsets are what the IR, Volar and LSP consume, line and
column are cheap from one index, and shared position objects were a measured
bug source (`packages/core/AGENTS.md`, `parseFragment` bullet).

**D6. `MxText` carries both normalized `value` and `raw`.** Alternative: raw
only, normalize in lowering. Chosen because normalization needs neighbour
lookahead that the front end already has while building the list; `raw`
and the node span keep the whole authored run, and `valueSpan` the range
Marko's trim leaves, which the IR's `Text.span` needs (§3.8). In a preserving
body `value` equals `raw` (§3.8).

**D7. One `MxModuleStatement` with a `keyword`.** Alternative: *MxImport*,
*MxExport*, *MxStatic*. Chosen because the payload is a Babel statement list in
every case and the per-keyword meaning is lowering's; `client` and `class` must
still parse to give a positioned error.

**D8. Errors in one list, referenced from the failed container.** Alternative:
errors only inline (Marko) or only in a list. Chosen so a consumer can report
all errors without walking (one list, ordered by position, template error
last), and lowering can still find "this expression failed" locally.

**D9. Parse shape by callback (`tagShape(name) → "html" | "parsed-text" |
"parsed-text-preserve" | "preserve" | "void"`).** Alternative: a fixed
built-in list. Chosen because custom tags' `parseOptions` and a target's own
overrides change the parse (spec §9.3, `custom-tags.ts` `customTagTaglib`,
`targets/data/src/taglib.ts` `neutralizations`).

**D10. Expressions keep a Babel payload.** Alternative: store only `source`
and spans and let lowering parse on demand. Chosen because the IR spec
requires a positioned `Expr.node` and `For.paramNodes` today (IR spec §4,
E11), and parsing once in the front end gives every expression error a place
in `errors` at parse time.

**D11. The AST is read-only and hands its payloads to the IR.** Alternative:
lowering copies every parser node it puts in the IR. Chosen because the IR
spec's E21 makes emitters copy before they mutate (`cloneIr`) and allows a
lowering to share, so a copy at the seam protects nothing (§4.1a).

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
the error are exact and tools can read them; the limits are stated in §3.13.
Lowering never reads a partial tree (`complete === false` implies not
lowered).

## 9. Open questions for mx-lead

Decision 163 ruled on Q1 to Q23 (`scratch/reports/mx2/ast-catalogue-rulings.md`
in the project space). Numbers are stable across revisions. Closed by the
rulings, with where the text now lives:

| Q | Ruling, in short | Applied in |
|---|---|---|
| Q1 | follow decision 146 addendum 4 as merged; `MxShorthand.operator`, `default` only in attribute position | §3.6 |
| Q2 | no raw text mode | §3.12 (unchanged) |
| Q3, Q16 | describe atoms as shipped (`Expr.atoms`, `Attr.atom`, `DataAttr` kind `atom`, `extra.mxAtom = { span }`); keep `MxExpressionContainer.atoms` | §4.3, §6.2 |
| Q4 | `InputInterface` split in lowering, by payload type; `export type Input` stays an `Export` | §3.10, §6.1 |
| Q5 | AST represents `server`/`client`; they route like tags; html's `server` stays a `DelegatedTag` | §6.1, §6.2, §6.4 |
| Q6 | `MxText` span = whole `onText` range, `valueSpan` = trimmed range | §3.8 |
| Q7 | open-tag comments dropped at lowering | §6.2 (unchanged) |
| Q8 | default value read as `value` by one lowering adapter, zero-width `nameSpan`; `MX_DUPLICATE_DEFAULT` is lowering's | §3.5, §6.1a |
| Q9, Q11, Q18, Q23 | as drafted: concise `end`; read `MxComment.kind`; AST keeps `@name`, lowering trims; shape before shadowing | §3.2, §6.1, §5.1, §3.12 ("Shape before shadowing") |
| Q10 | field names follow the AST; container `span` = htmljs `value` range, `outer` = event range; the grammar document adopts both | §3.4 (unchanged) |
| Q12 | port `data/src/scan.ts` in the same change; delete the fallback statement list (`CORE_STATEMENT_TAGS`/`isStatementTag`, `core/src/name-sugar.ts`) and the stock-parser probe (`isShorthandWord`'s `markoParser()`, `name-sugar.ts`; `stock-parser.ts`) | §6.4 |
| Q13 | plain Babel types in payloads; pin `@babel/{types,traverse,generator}` 7.29.7 with today's generator options; sub-parser node shapes equal to today's | §7.1 |
| Q14 | `Expr.node: Node \| null` | §4.2 |
| Q15 | IR spec §6 and §3.3 rows corrected to `value:foo` | `ir-spec.md` |
| Q19 | hooks re-typed in the port to a narrow view, never `Mx*` nodes; addendum 1 widens the view field by field and adds an opaque handle for core's helpers | §6.4 |
| Q20 | no parser recovery; not lowered when incomplete; `compileSource` reports every error (decisions 161, 162) | §3.13 |
| Q21 | element-shape table owned by the target descriptor, core default, one table two readers; `<title>`; unnamed tag = `"html"` | §3.12, §7.1 |
| Q22 | drop `tagDiscoveryDirs` | §7.1 |

Deferred, still open (each after the port, as its own change):

- **Q17.** Drop `loc` from `Expr.node` and `For.paramNodes` payloads (keep only
  `start`/`end`). Deferred: a later, separate IR-contract change, after the
  TypeScript plugin maps through `Expr.span` instead of `node.loc`
  (`mx-language.ts` `locateSourceCode`); until then the payloads keep `loc` (§4.1).
- **Checks served through the hook handle, moved into lowering**, and
  **html's `input` collision reported at the identifier** (§6.4, "After the
  port, possibly"). Not part of the port: each changes output, so each would
  be its own change with its own goldens.
- **Generator output to source slices** (TODO
  `ir-generated-text-to-source-slices`). Deferred: wanted, but as a separate
  recorded change after the port, because it changes emitted text (probe c,
  `{ a,b }` printed as `{ a, b }`); the port keeps the pinned generator (§7.1).
- **`MxShorthandValue.dynamic` without `quasis`/`expressions`** (§3.6).
  Deferred: the port keeps both beside `template`; dropping the duplicate is
  the same later clean-up as ruling C4 made for the dynamic tag name (§3.3),
  where one container holds the whole name and there is no separate list of
  quasis or inner expressions.

## Appendix A. Node types and where each is defined

Every `Mx` type in this document, with the section and line of its
definition. Each is used elsewhere in the catalogue; no type is used without a
definition. The italic names in §8 and §9 are rejected alternatives and are
not listed.

| Type | Kind | Defined in | Line |
|---|---|---|---|
| `MxDocument` | node | §3.1 | 316 |
| `MxTag` | node | §3.2 | 343 |
| `MxCloseTag` | field shape | §3.2 | 366 |
| `MxTagName` | field shape | §3.3 | 425 |
| `MxPattern`, `MxArguments`, `MxParameterList`, `MxTypeArguments`, `MxTypeParameters` | node (container) | §3.4 span rule; §4.1 types | 470 |
| `MxAttribute` | node | §3.5 | 489 |
| `MxMethod` | node | §3.5a | 533 |
| `MxSpreadAttribute` | node | §3.5b | 555 |
| `MxShorthand` | node | §3.6 | 570 |
| `MxShorthandValue` | field shape | §3.6 | 584 |
| `MxAttributeTag` | node | §3.7 | 658 |
| `MxText` | node | §3.8 | 686 |
| `MxPlaceholder` | node | §3.9 | 714 |
| `MxModuleStatement` | node | §3.10 | 731 |
| `MxScriptlet` | node | §3.10 | 821 |
| `MxStatements` | node (container) | §3.10; §4.1 | 833 |
| `MxComment`, `MxCDATA`, `MxDoctype`, `MxDeclaration` | node | §3.11 | 839 |
| `MxParseError` | node | §3.13 | 907 |
| `MxReturn` | node | §3.14 | 1040 |
| `MxExpressionContainer` | generic base | §4.1 | 1079 |
| `MxExpression` | node (container) | §4.1 | 1086 |
| `MxAtom` | node | §4.3 | 1197 |
| `MxTrigger` | node | §4.4 | 1265 |
| `MxBlockTag`, `MxFilter` | node | §4.5 | 1302 |
| `MxBodyMode` | union | §3.12 | 864 |
| `MxTagShape` | function type | §3.12 | 864 |
| `MxStatementKeyword` | union | §3.10 | 793 |
| `MxFragmentBase` | field shape | §5.3 | 1293 |
| `MxFrontEndOptions` | helper | §7.1 | 1730 |
| `MxErrorCode` | union | §3.13 | 912 |
| `Span`, `MxNodeBase` | helper | §3.0 | 296 |
| `MxChild`, `MxNode` | union | §3.0 | 299 |
| `MxNodeHandle` | opaque handle (not a node) | §6.4 | 1550 |
