---
title: "IR specification"
description: "The normative contract between a parser/lowering and the emitters: every IR node, field, position rule and invariant."
---

# IR specification

This page is the normative description of the IR that `@mxlang/core` produces and every emitter consumes. It is the written interface between the two halves of the compiler: a **lowering** (today `packages/core/src/lower.ts`, over Marko's parser) produces an `Ir`; an **emitter** (a host or target) consumes it and never sees a parser node. Someone writing a new lowering should be able to build one from this page alone, without reading an emitter.

[The IR](/architecture/ir/) is the prose introduction. This page is the contract. Where they disagree, this page wins, and the disagreement is a bug in the prose.

Everything here is derived from the code and the tests that pin it, at the commit this page was last changed in. Each invariant names the test that pins it; "no pinning test" says so where none exists (none does at present). The types live in `packages/core/src/ir.ts`; the walk in `packages/core/src/emit.ts`; spans in `packages/core/src/mapping.ts`.

The key words **must**, **must not**, **may** and **should** are used in the RFC 2119 sense. "Lowering" means whatever produces the `Ir`; "emitter" means anything that reads one (an `Emitter<Out>` driven by `drive()`, or a direct walker such as `@mxlang/data`'s tree builder).

## 1. The pipeline: what a parser produces and what lowering adds

The IR is not the parser's output. It is the result of a parse **plus** a sequence of resolution steps, several of which consult the host. A new lowering must perform every step below, in this order, or produce the same result by other means.

`compileSource` (`compile.ts`) parses the whole file with `@marko/compiler` and, in the translator's `Program.exit`, builds a `Ctx` and calls `lower(ctx, body)` once, then hands the result to the host's required `HostOptions.emitIr(ir, ctx)`. `parseFragment` (`fragment.ts`) is the same parse for a substring of a larger file, with positions shifted (section 3.4). `lower()` (`lower.ts`) then runs:

1. **Tree rewrites, before any tag name is read** (`resolveUnnamedTags`, `default-tag.ts`). Top-down over the parsed tree, per tag:
   1. **Name sugar** (decision 146, `name-sugar.ts` `rewriteNameSugar`): `<input:email>`, `#id`, `.class` and attribute-position `:x`/`#x`/`.x` become the `name`/`id`/`class` attributes the author would otherwise have written. The rewritten attribute remembers its token as `sugarLabel`, which becomes `Attr.sugar` (section 6). A host declaring `claimsAttributeHash` keeps attribute-position `#x` for itself.
   2. **Default tag** (`resolveDefaultTag` host hook, decision 145): an unnamed tag (`<#a>`, `<.b>`, `<:c>`) is renamed to what the host answers, given its ancestors. With no hook it is a positioned error ("no default tag is declared…").

   After this step the tree contains no sugar and no unnamed tag. A new parser may produce that tree directly; it must not hand an unnamed tag to the walk (step 5).
2. **Reserved-name check** (`checkReservedTemplate`) and the file's own `Input` (`readOwnInput`, `raiseInvalidOwnInput`).
3. **Custom-tag `analyze` pre-walk** (`runCustomTagAnalyze`), only at the file root and only when a registered tag defines `analyze`: the whole body is lowered once on a scratch `Ctx` whose output is discarded, so every `analyze` receives the same `TagCall` its `transform` will.
4. **Export name** (`Ir.exportName`), computed before the walk because a self-recursive call resolves to it during the walk (invariant §7.5-7).
5. **The walk** (`lowerChildren`). Each child becomes zero or more IR nodes. Tag routing, in precedence order (`lowerAuthoredTag`):
   1. a dynamic tag name (`<${expr}>`) → `DelegatedTag` if the host claims `DYNAMIC_TAG`, else `Component` with a `dynamic` target;
   2. a host **disposition** (`declarations.tags[name]`): `error` fails, `inert` validates the shape and yields an empty `Text`;
   3. core structural tags: `import`/`static`/`export` (statement nodes), `for`, `const`, `define`, `return`, a stray `else`/`else-if` (error); `if` is grouped with its `else` siblings before this switch;
   4. built-in custom tags (`try`, never shadowable);
   5. a PascalCase name the file binds (an import, a `<define>`, a `<const>`, a tag param — `fileLocalBinding`) skips steps 6 and 7;
   6. a registered or discovered **custom tag** (`lowerCustomTag`): its contract is validated (attributes, attribute tags, `children`, `parents`; decisions 130, 138, 142) and its `transform` or template replaces the call with ordinary IR (zero or more nodes);
   7. a host claim (`isDelegatedTag`) → `DelegatedTag`, with the host's `resolveDelegatedTag` answer in `data`;
   8. a component (`fileLocalBinding` or `isComponent`) → `Component`;
   9. an unbound PascalCase name, or a lowercase name `isElement` rejects → positioned error;
   10. otherwise an `Element`.

   During the walk, attributes are lowered, de-duplicated last-wins (decision 135) and offered to the host's `orderAttrs`; attribute tags are planned against the callee's `Input` (section 8); `ctx.hoist` calls collect `Hoisted` statements for the enclosing function.
6. **Assembly** (`lowerTemplate`), after the walk: module-level kinds are lifted out of the body into `Ir.imports`, `Ir.hoisted`, `Ir.inputInterface` and `Ir.prelude`; imports synthesized for discovered tags are appended to `Ir.imports`; `needsAttrTagImport` is computed; at the file root, every used tag's `finalize` output is **prepended** to `Ir.body` in tag-name order; `returnValue` is read off the walk; `tagMetadata` is derived from the finished IR (`metadataOfIr`).

There are no passes after `lower()` returns. Everything an emitter reads is set by the time `emitIr` is called.

**The IR is host-independent in shape, not in content.** Several fields record a host's answer at lower time: `DelegatedTag.data` (`resolveDelegatedTag`), an `Attr`'s `kind` and `name` (`resolveModifier`, the `isElement` gate for `event`), attribute order (`orderAttrs`), `ComponentTarget.binding` (`resolveDiscoveredTagModule`), whether a tag is an `Element`, a `Component` or a `DelegatedTag` at all, and whether a comment survives (`keepComments`). A lowering must take a `HostDeclarations` (`declarations.ts`) and ask it the same questions at the same points.

## 2. Conventions

### 2.1 Required and optional

A field typed without `?` is always present; `T | null` is always present and may be `null`. A field typed `?:` may be absent; this page says when. `JSON.stringify` drops absent fields, which is why the worked example (section 12) shows none.

### 2.2 Synthesized nodes

A node is **synthesized** when no authored source backs it: built by a custom tag's `transform`/`finalize` through `ctx.build` (`custom-tags.ts` `buildersFor`), a discovered tag's routed `Component` (`template-tag.ts`), an import minted for a discovered tag, or the empty `Text` that a `<return>` or an inert tag leaves behind. Synthesized nodes:

- carry a `loc` (the call site's) like every node;
- carry **no** `span`, `nameSpan` (where optional), `valueSpan` or `paramSpans`;
- carry `nameSpan: { sourceStart: 0, sourceEnd: 0 }` on an `Attr` built by `ctx.build.attr`/`dynamicAttr`/`booleanAttr`, because `Attr.nameSpan` is required. A zero-width span at offset 0 cannot be an authored name (a tag always precedes an attribute), so a consumer may treat it as "no source";
- carry an `Expr` whose `node` is `null` and whose `shape` is `"other"` (`syntheticExpr`), with no `span`.

An emitter must not assume that any optional span is present. `@mxlang/data` is the one consumer that requires spans; it refuses a missing one with "core IR invariant broken — … carries no span" (`packages/targets/data/src/build.ts` `requiredSpan`) rather than guessing.

## 3. Positions

### 3.1 `Position` (`loc`)

Every IR node carries `loc: Position`: `{ line, column, file? }`, the shape `TranslateError` reports.

- `line` is **1-based**; `column` is **0-based**, counted in UTF-16 code units from the start of the line.
- `file` is absent for a position in the file under compilation, which is every position core produces today. When set, the position is measured in that file (a tag template's own text, spec §2's third position rule). A consumer that can only report against one file drops a foreign-file position rather than misplacing it.
- `loc` is the **start** of the construct: the `<` of a tag, the first character of an attribute name, the `$` of an interpolation. Pinned by `lower.test.ts` › "positions" › "records a 1-based line and 0-based column on every node" and "records the position of a nested node, not its parent's".

The statement kinds `Static`, `Import`, `Export`, `InputInterface` and `Hoisted` also carry `end: Position`, the end of the authored statement, because their code is a plain string with no `Expr` to read a range from. For a synthesized import `end` equals `loc`. For a `Hoisted` node both come from the node the host passed to `ctx.hoist(code, node)`.

### 3.2 `SourceSpan`

`SourceSpan` (`mapping.ts`) is `{ sourceStart, sourceEnd }`: a half-open range `[sourceStart, sourceEnd)` of **UTF-16 code-unit offsets into the file's source string** — the unit of a JS string index, so `source.slice(sourceStart, sourceEnd)` yields the authored text. Not bytes: an emoji before a span shifts it by two. CRLF line endings are ordinary characters (the `\r` belongs to its line). Pinned by `spans.test.ts` › "spans under UTF-16 and CRLF" › "an emoji counts two code units before every span after it" and "CRLF line endings slice correctly (the \r belongs to its line)", and "non-ASCII source" › "every span is a UTF-16 code-unit offset into the source string".

Every span is **file-absolute**: offsets into the whole file, not into a fragment (section 3.4). Pinned by `lower.test.ts` › "Expr.span" › "a span computed under a distinct ctx.source is absolute in that source".

What each span covers is listed with its field. The rule throughout: slicing the source with a span yields exactly the authored text of that construct, which `spans.test.ts` asserts for every span kind.

### 3.3 Which nodes carry spans

| Field | Covers |
| --- | --- |
| `Expr.span` | The expression's own text. For a string literal, quotes included. |
| `Attr.nameSpan` (required) | The authored name. Zero-width at the `=` for a default attribute (`<x="post">`), as in Marko (`spans.test.ts` › "a default attribute's nameSpan"). For a colon name (`value:foo`, `x:`), the whole spelling, colons included (`lower.test.ts` › "`:modifier` is Marko's `value:modifier` attribute, not a modifier"). For a name-sugar attribute, the sugar token. |
| static `Attr.valueSpan` | The string literal, quotes included; zero-width at the end of the name for a valueless colon name (`value:foo`, `x:`; `lower.test.ts` › "gives the valueless modifier a zero-width valueSpan at the end of its name"). |
| `Element`/`DelegatedTag`/`AttributeTag` `nameSpan` | The tag name (`x` in `<x>`); for an attribute tag, the name after the `@` (`attributeTagNameSpan`). |
| `Element`/`Component`/`DelegatedTag`/`AttributeTag`/`For`/`Define`/`Const` `span` | The whole tag: opening tag, body and closing tag, or the self-closed tag. |
| `Component.nameSpan` | The opening tag name; `null` for a dynamic target and for a routed discovered-tag call (section 5.6). |
| `Text.span` | The authored text, which `value` has normalized. |
| `Interpolation.span` | The whole `${…}`/`$!{…}`, delimiters included. |
| `Comment.span` | The whole comment, delimiters included. |
| `IfChain.span` | From the `<if>`'s `<` through the last branch's closing tag, layout between branches included. |
| `Branch.span` | That branch's own tag. |
| `For.paramSpans`, `Define.paramSpans` | One per param, `undefined` for a param with no `loc`. |
| `Define.nameSpan` | The define's own name (`Row`). |
| `Import`/`Export`/`Static` `span` | The authored statement, `static` keyword included, trailing line terminator excluded; a trailing same-line comment included. |
| `InputInterface.span` (optional) | The authored `export interface Input` statement, trailing line terminator excluded. Pinned by `solid/src/expression-mappings.test.ts` › "the Input interface". |

`Hoisted`, `DocumentType` and a synthesized `Import` carry no span. Pinned by `spans.test.ts` (one `describe` per row group), except `InputInterface.span` (above).

### 3.4 Fragments and `baseOffset`

When MX is a region inside another file (a `.solid.mx` region, found by `packages/tsx-bridge/src/mx/bridge.ts`), `parseFragment(source, { filename, baseOffset, baseLine, baseColumn })` parses the substring and shifts every position so the IR is file-absolute. The bridge passes `baseOffset: inner.start`. The numbers (`fragment.ts`, `FragmentBase`):

- all three count UTF-16 code units;
- `baseOffset` is the number of units before the fragment; `baseLine` is zero-based (the number of `\n` before it); `baseColumn` is zero-based (units between the last `\n` and the fragment);
- `baseLine === 0` requires `baseOffset === baseColumn`; `baseLine >= 1` requires `baseOffset >= baseLine + baseColumn`. `assertBaseContract` rejects anything else.

Line/column positions shift by `baseLine` (and by `baseColumn` on the fragment's first line only); index positions shift by `baseOffset`. Shared position objects are shifted once (the walk dedupes them). A thrown parse error's position is on the exception and is shifted separately. A host that also reads positions through a padded copy of the file must pad it as the "padding contract" in `fragment.ts` describes, or line/column and index positions disagree. Pinned by `fragment.test.ts`.

A new lowering over its own parser has no reason to reproduce the shift mechanics, but it must produce the same result: every `loc` and every span in the IR is measured against the enclosing file.

### 3.5 What diagnostics require

- A lowering error is a `TranslateError` with a 1-based `line`, 0-based `column`, and `file` when it is about another file (`cross-file-error.test.ts`). Each `fail(…, node)` reports the node's `loc.start`. An error about several places also carries the optional `spans: SourceSpan[]` (file-absolute UTF-16 offsets, source order; `line`/`column` are the last span's): a duplicate atom-contract declaration holds the first and the second (decision 156).
- An attribute diagnostic is positioned at the attribute **name** (`Attr.loc`, which for an authored, spelled attribute is the position of `nameSpan.sourceStart`; a shorthand `#id`/`.class` with no position of its own reports at its tag, a merged sugar `class` at its first sugar token). Hosts rely on this for event-attribute errors (pinned per host by position tests on solid/preact/html/astro).
- Warnings (`MxWarning`) carry the same structured position; the message text prints columns 1-based.
- The TypeScript plugin and language server map only through authored positions — spans, and for an expression today `Expr.node.loc` (section 4). A missing position means "no mapping", never a guessed one ([Spans and mappings](/architecture/spans-and-mappings/)).

## 4. `Expr`

```ts
interface Expr {
  code: string;
  shape: "object" | "array" | "string" | "other";
  node: Node;
  span?: SourceSpan;
  file?: string;
  atoms?: Atom[];
}

interface Atom {
  kind: "atom";
  name: string;
  span: SourceSpan; // the whole atom, `:` included
}
```

| Field | Contract |
| --- | --- |
| `code` | The expression's source text, ready to emit. **Sliced from the authored source**, not printed back from the AST (`core.ts` `expr()`): type arguments and every authored detail survive (`lower.test.ts` › "binding scopes are per JS block" › "type arguments survive the non-empty binding registry path"). Two exceptions: when the host has registered bindings (`ctx.bindings.register`, decision 70), free references to those names are rewritten in the sliced text (`count` → `count()`); when the parser node has no offsets, the node is printed with Marko's own Babel generator (`printExpression`). |
| `shape` | The syntactic shape, computed once while the node is in hand (`expressionShape`): `ObjectExpression` → `"object"`, `ArrayExpression` → `"array"`, `StringLiteral`/`TemplateLiteral` → `"string"`, anything else → `"other"`. Pinned by `lower.test.ts` › "Expr records its parsed value shape during resolution". |
| `node` | The parser's (Babel) expression node, with `loc.start`/`loc.end` as `{ line, column, index? }`. `null` on a synthesized `Expr` (section 2.2). Decision 79 is that emitters read `code` and `shape`, but three consumers still read `node` today, so a new lowering **must** supply it, positioned, for every authored expression: `@mxlang/typescript-plugin` maps an expression only when `source.slice(node.loc) === code` (`mx-language.ts`; `index.test.ts` › "builds exact expression mappings from positioned HTML IR"); `@mxlang/angular`'s tag module rewrites `node` and reassigns `code`; the Preact and Solid emitters read a `by=` string key's `node.value`. Emitters also read `node` to inspect an expression but never to print it (E3): Solid reads `node.loc` to tell the synthetic array Marko builds for a `.class` shorthand merge from an authored one (`renderAttrs`), the literal value of a range bound (`numericValue`, which folds a `<Repeat>` count) and of a template-literal `class` (`staticTemplateValue`), the node type of an attribute method and of a `class`/`style` value, and a `step=` node to reject `step=0` (the first three pinned by `solid/src/ir-contract.test.ts` › "E3: Solid reads Expr.node to inspect"); Angular's tag module rewrites `input.x` reads on it (`tag-module.ts`, on a copy, E21). `Expr.span` carries the same range and is the field a new consumer should use. |
| `span` | Section 3.3. Absent exactly when the expression has no authored source. Distinct sibling expressions get distinct spans (`lower.test.ts` › "Expr.span" › "sibling-sharing case: four byte-identical exprs get four distinct spans"). |
| `unrewrittenCode?` | `code` as it was before a rewrite changed it (`rewrite-codes.ts` `rewriteCodes`, e.g. Solid's accessor reads `i` → `i()`): set by that rewrite only when it changed `code`, so it is absent when no read was rewritten. It is the authored text with each atom as its string literal (`:q` is `"q"`, one character longer), not a slice of the source: `mappedExpr` maps it to `span` through `atomMappings`, or one to one when the lengths match, then diffs it against `code` token by token and leaves inserted text unmapped. The diff trims the common prefix and suffix, and past `MAX_DIFF_CELLS` (about 2000 x 2000 tokens) maps the changed middle as one run. Read by every host that maps expressions through `mappedExpr` (today Solid). Pinned by `solid/src/expression-mappings.test.ts` (rewritten reads keep exact columns). |
| `bodySpan?` | The authored `{ … }` block of an attribute method shorthand (`onClick() { … }`, `async onClick<T>(…) { … }`), whose `code` is the `function` expression the compiler printed for it; absent for every other expression, an authored `function` expression included. Set in `lower.ts` (`methodBodySpan`) from the method node's own body position, which Marko gives as the text between the braces, so it is widened onto them. `bodySource` is its authored text. A host that emits the printed function maps its head as generated text and diffs the printed body against `bodySource` token by token (`mappedRewrite`), so a reformatted body (`{ go() }` printed as `{ go(); }`) or one with rewritten reads still maps. Read by Solid's `mappedValue`, which splits the printed function at its parsed body (`printedBodyStart`). Pinned by `tsc` `expression-values-solid-typecheck.test.ts` (an error in a method body, async, generic or nested, reports at its authored column). |
| `file` | Reserved. Nothing in `packages/core` sets it today; a tag unit compiles under its own `Ctx`, so its spans are already absolute in its own file. |
| `atoms` | Decision 156: the atoms (`:name`) written inside the expression, in source order; absent when there are none. `code` holds each one as its string literal (`[:a]` is `["a"]`): core splices `JSON.stringify(name)` at each atom's span on both `expr()` paths (`atoms.test.ts`). In `node`, each atom is a `StringLiteral` whose `value` is the name and whose `extra.mxAtom` is `{ span }` (`MxAtomMark`). That node shape is **public API** of `@mxlang/core` and `@mxlang/data` (addendum 1, item 1): a consumer translating an expression recognises an atom by `extra.mxAtom`. `mappedExpr` maps each atom to its literal and the text between one to one, so a type error on a nested atom lands on it. |

**The `node` contract (decision 166, addendum 3).** `Expr.node`, `For.paramNodes` and the tag-author API's `attr.value.node` are expression nodes in `@mxlang/babel`'s vocabulary (Babel 7.29 shapes), with file-absolute positions, and they are read-only: an emitter that edits one copies first with `cloneIr` (E21). A `node` is `null` in two cases only: a value core built itself (section 2.2), and, after the MX2 port, an expression that failed to parse. A host treats `null` as "no structure" and never dereferences it unchecked. No host parses source text to recover structure, and core offers no re-parse helper.

What an emitter may assume:

- `code` is a complete JavaScript/TypeScript expression and may be emitted verbatim inside parentheses.
- The only rewritings core performs on `code` are the binding-registry rewrite above, which is a host's own request, and the atom splice (`:a` is `"a"`, decision 156). Core does not rename, hygienize or reformat expressions. Name sugar (decision 146) rewrites the **tree** before lowering and never touches an expression's text.
- Hosts may rewrite `code` further when emitting; the lowering does not. Section 10.3 lists who does.
- Consumers recognize an `Expr` structurally — an object with a string `code` and a `shape` (`rewrite-codes.ts`) or a `node` (`mx-language.ts`, Angular's `tag-module.ts`). The statement kinds also carry `code`; they must never carry `shape` or `node`.

## 5. The root and the body kinds

### 5.1 `Ir`

| Field | Type | Contract |
| --- | --- | --- |
| `imports` | `Import[]` | Authored `import` statements in source order, then imports synthesized for discovered tags. Module scope. |
| `hoisted` | `Array<Static \| Export>` | `static` blocks and every top-level `export` other than `export interface Input`, in source order. Module scope. |
| `inputInterface` | `InputInterface \| null` | The author's `export interface Input`. `export type Input = …` is an ordinary `Export`. |
| `needsAttrTagImport` | `boolean` | True when `Input` or a `static` block references `AttrTag` and the file neither declares nor imports it; the host must synthesize its own `AttrTag` type import. Pinned by `lower.test.ts` › "marks an unimported AttrTag reference for a host type import". |
| `prelude` | `Hoisted[]` | Statements `ctx.hoist` lifted to the head of the render function, in hoist order. A hoist inside a `<define>` goes to that `Define`'s children instead (5.10). Pinned by `lower.test.ts` › "Hoisted lands ahead of the construct that produced it". |
| `body` | `IrNode[]` | The template body in document order, never containing a module-level kind; `finalize` output first when any. |
| `tagMetadata` | `TemplateMetadata` | Caller-facing facts derived from this IR (`readsContent`, `attributeTags`, `readsAllInput?`, `returnsValue?`, `returnValueCode?`, `inputCode?`, …; `template-tag.ts`). Consumed by the callers of this unit, not by its own emitter. |
| `exportName?` | `string` | The PascalCase name the default export is declared under: from the basename (`icon.mx` → `Icon`), re-minted if it collides with any binding or source identifier. Present iff the compilation emits a module (`ctx.emitsModule`); absent for a `.solid.mx` region. Every module-emitting host emits `export default function <exportName>(…)`, which is what lets a tag call itself with no import (invariant §7.5-7). Pinned by `lower.test.ts` › "names the export after the file", "re-mints the export name against a real binding in the file", "leaves the export name unset when the compilation is not a module". |
| `returnValue?` | `Expr \| null` | The `<return value=…/>` expression, or `null`. Present means the unit hands a value back to its caller (design §3.3): html's default export stays `(input) => string` and its value comes from the sink entry `render(input, out)`; the JSX hosts' default export returns `{ value, output }` instead of the output; Solid calls a generated `$mxReturn` callback prop; the export shape is the host's. Lifted out of the body; the `<return>` leaves an empty synthesized `Text` in place. Pinned by `lower.test.ts` › "<return>" › "lifts the value onto the IR rather than into the body". |

### 5.2 The node kinds

`IrNode` is a discriminated union on `kind`. Every member has `loc` (section 3.1). The table says where each kind may appear.

| Kind | In `body`/children | In `Ir` fields | Emitter method |
| --- | --- | --- | --- |
| `Text`, `Interpolation`, `Element`, `Component`, `IfChain`, `For`, `Define`, `Const`, `DelegatedTag`, `DocumentType`, `Comment` | yes | — | one each |
| `Hoisted` | only as the leading children of a `Define` | `prelude` | `hoisted` |
| `Import` | never | `imports` | none |
| `Static`, `Export` | never | `hoisted` | none |
| `InputInterface` | never | `inputInterface` | none |

A module-level kind in a body is a malformed IR: `drive()` throws ("unexpected module-level node kind"), pinned by `emit.test.ts` › "throws on a module-level kind reaching the body walk".

### 5.3 `Text`

`{ kind: "Text", value: string, span? }`. `value` is the text after Marko's whitespace normalization (decision 33: newline-bearing whitespace runs dropped, the rest collapsed); `span` covers the text as authored, so the two differ (`spans.test.ts` › "Text: span slices the authored text, which `value` has normalized"). Same-line spaces are content (decision 141). A lowering must apply the same normalization: emitters print `value` and never re-normalize. `value` may be `""` (the placeholder an inert tag or `<return>` leaves); an emitter must emit nothing for it.

### 5.4 `Interpolation`

`{ kind: "Interpolation", expr: Expr, escaped: boolean, span? }`. `escaped` is `true` for `${…}`, `false` for `$!{…}`.

### 5.5 `Element`

`{ kind: "Element", name, nameSpan?, span?, attrs: Attr[], children: IrNode[], void: boolean }`. A native HTML/SVG/MathML element, after the host's `isElement` accepted it. `void` is true for the HTML void elements (`VOID_TAGS`), whose `children` is always `[]`. Pinned by `lower.test.ts` › "Element marks a void tag and takes no children". An `Element` never has attribute tags (the host's `rejectElementAttributeTags` or the generic field guard refuses them). Only an `Element` lowers `on*` attributes to `kind: "event"` (section 6).

### 5.6 `Component`

| Field | Contract |
| --- | --- |
| `target` | `ComponentTarget` (5.7). |
| `nameSpan` | The opening tag name; `null` for a `dynamic` target and for a discovered template-tag call routed to a generated binding (`template-tag.ts`), which carries no span either. |
| `span?` | Whole call. |
| `attrs` | Props. `on*` stays `dynamic` here; never `event`. |
| `content` | The ordinary children as a `Block`, or `null` when the call has no content (comments and empty text do not count, `hasContent`). |
| `attributeTags`, `attributeTagTree`, `attrTagProps` | The three views of the call's attribute tags (section 8). |
| `args` | Tag arguments `<Row(a, b)/>`, in order; `[]` when none. |
| `var?` | The `/var` binding as source text. Only ever non-null on a call whose target declares `<return>`; core rejects `/var` on any other call ("does not return a value"). |
| `varBindings?` | Each identifier the `/var` pattern declares (`{ a, b: c }` gives `a` and `c`), as `{ name, span? }` with its authored span; empty or absent without `/var`. Populated by `lower.ts` `varBindingsOf` (on `lowerCustomTag` and `lowerComponent`) and by `template-tag.ts` for a routed template call; also on `TagCall`, so custom-tag transforms see it. It serves one invariant: an emitter that lifts bindings into one scope (a `.react.mx`/`.solid.mx` region arrow) can refuse a duplicate at the authored name. A `/var` pattern the parser cannot read fails in lowering at the parser's position instead of yielding `[]`. Optional: an emitter that ignores it needs no change. |
| `returnsValue?` | `true` when the target unit declares `<return>`, resolved from the callee's cached metadata; set even without a `/var`, because the JSX hosts must still unwrap the output from `{ value, output }`; html and astro call the default export unchanged and read the value from `render`. Absent otherwise. |
| `authoredName?` | The tag name as written, set only when it differs from the target's name (a discovered tag routed to `$mx_Name1`). Use it in diagnostics: Preact, Solid, Astro, Angular and data do, pinned by `preact/src/index.test.ts` › "rejects /var inside <for>, naming the tag as written", the same test in `solid/src/index.test.ts`, `astro-template.test.ts` › "rejects /var on it, naming the tag as written", `angular/test/component.test.ts` › "rejects content with tag params, naming the real tag rather than a literal {Tag} placeholder" and `data/src/parse.test.ts` › "calls a template tag". |

A named custom tag's argument form is exclusive (Marko's `assertAttributesOrSingleArg`): arguments with attributes, attribute tags or a body is an error. A `dynamic` or `define` target follows Marko's lenient rule: arguments with a body or attribute tags are allowed, arguments with a plain attribute are not (decision 109). Pinned by `lower.test.ts` › "allows a define call mixing tag-argument form with an attribute tag…", "…with a body…", "still rejects a define call mixing tag-argument form with a plain attribute".

### 5.7 `ComponentTarget`

| Kind | Fields | Meaning |
| --- | --- | --- |
| `name` | `name`, `resolvedPath?`, `binding?` | An import binding or a discovered/registered tag. `binding` is the identifier to call when it differs from `name` (set only when the host answered `resolveDiscoveredTagModule`); absent means call `name`; html calls through it (`html/src/ir-contract.test.ts` › "5.7: a name target with a binding is called through the binding"). `resolvedPath` is set for a template-backed custom tag. |
| `define` | `name`, `params` | A `<define>` in scope and the params it declared. |
| `dynamic` | `expr`, `valueImportBinding?` | `<${expr}/>`, resolved at run time. `valueImportBinding` is set only when core synthesized this target (decision 116: a PascalCase tag bound to a value import that is not a `.marko`/`.mx` default import, or to a local value core cannot prove is a function/class); its `expr` is synthesized (`node: null`, no span). |

Pinned by `lower.test.ts` › "Component resolves an import binding as its target", "Component records a define target with its declared params", and the "decision 116" and "local-value-as-tag" tests.

### 5.8 `IfChain` and `Branch`

`{ kind: "IfChain", branches: Branch[], span? }`; `Branch` is `{ condition: Expr | null, children, span?, loc }`. The chain is `<if>` plus every following `<else if>`/`<else-if>`/`<else>` sibling, already grouped; whitespace-only text and comments between branches are layout and are dropped. Only the last branch may have `condition: null` (an `<else>` ends the chain). Emitters must not re-scan siblings for `<else>`. Pinned by `lower.test.ts` › "IfChain groups every branch, with a null condition for else" and "leaves a second else after an unconditional else to the ordinary stray-else error".

Each branch is its own binding scope: a `<const>` inside one does not leak (`lower.test.ts` › "restores a name shadowed inside an <if> branch after the branch").

### 5.9 `For`, `ForSource`, `ForHead`

`For` is `ForHead` plus `{ kind: "For", children, span? }`. `ForHead` (also used by `AttributeTagFor`):

| Field | Contract |
| --- | --- |
| `source` | `{ kind: "of", list }`, `{ kind: "in", object }`, or `{ kind: "range", from: Expr \| null, bound, inclusive, step: Expr \| null }`. |
| `params` | Tag params as authored source text (annotations and destructuring kept). At least one; zero is an error. |
| `paramNodes` | The positioned parser nodes for `params`, one per entry. Like `Expr.node`, still read by a consumer (Angular aliases the index param from them), so a lowering must supply them; `[]` on a synthesized loop. |
| `bindings` | Every identifier the params bind, for scope tracking. |
| `paramSpans?` | Section 3.3. |
| `key` | The `by=` expression, or `null`. A one-shot string emitter ignores it (decision 65); a reactive host uses it. |

Range rules: `to=` gives `inclusive: true`, `until=` gives `false`; both together is an error. `from` is `null` when omitted — the host supplies the start (0), core does not invent a literal. `step` is `null` when omitted and only legal on a range. More than one of `of=`/`in=`/a range is an error, as is `key=` (Marko spells it `by=`) and a string `by=` on anything but `of=`. Pinned by `lower.test.ts` › "For normalizes `of=`, with params and their bindings", "For normalizes the inclusive and exclusive ranges apart", and the "<for> by=/key= (Marko parity)" block.

The params shadow host bindings inside `children` only; emitters must not re-shadow.

### 5.10 `Define`

`{ kind: "Define", name, nameSpan?, span?, params: string[], paramSpans?, children }`. `name` and `params` are source text. Any statement a host hoisted from inside the body is placed **first in `children`** as `Hoisted` nodes, so a define-scoped hoist lands at that function's head. The define is registered after its body is lowered. Pinned by `lower.test.ts` › "Define carries its name, params and body".

### 5.11 `Const`

`{ kind: "Const", name, init: Expr, span? }`. `name` is the binding pattern as source text, printed through `declName` (never rewritten). The binding shadows a host binding of the same name for the rest of its scope, which a `<const>` inside a branch confines to that branch.

### 5.12 Statement kinds

| Kind | Fields | Contract |
| --- | --- | --- |
| `Import` | `code`, `bindings`, `end`, `span?`, `synthesized?`, `specifier?`, `resolvedPath?` | `code` is the trimmed statement. `bindings` are its local names. A synthesized import (for a discovered tag) has `synthesized: true` plus `specifier` and `resolvedPath`, no span, and is deduped by resolved path. Only Solid treats the two differently (it hoists synthesized imports out of a region). |
| `Static` | `code`, `end`, `span?` | `code` has the leading `static ` removed. |
| `Export` | `code`, `end`, `span?` | Any top-level `export` except `export interface Input`, verbatim. |
| `InputInterface` | `code`, `end`, `span?` | `export interface Input …`, verbatim; `span` is the authored statement (section 3.3). |
| `Hoisted` | `code`, `end` | A statement from `ctx.hoist(code, node)`; positions from `node`. |

Pinned by `lower.test.ts` › "Import and Static are lifted out of the body to module scope" and "Export hoists verbatim and InputInterface is kept apart".

### 5.13 `DelegatedTag`

`{ kind: "DelegatedTag", tag: DelegatedTag<unknown> }`, where `DelegatedTag<Data>` is:

| Field | Contract |
| --- | --- |
| `name` | The tag name, or `DYNAMIC_TAG` for a claimed `<${expr}>`. |
| `nameSpan?` | Absent for a dynamic or synthesized tag. |
| `span?` | Whole tag. |
| `attrs` | Lowered as on an element (`on` = `"element"`, so the host's `orderAttrs`/modifier hooks see the same input), but `on*` stays `dynamic`: only an `Element` gets `event`. |
| `args?` | Tag arguments; set by the lowering for an authored tag (possibly `[]`), absent on a builder-made tag. An emitter reconstructing a call must forward them. |
| `children` | Lowered body (the content left after attribute tags are taken out). |
| `attributeTags`, `attributeTagTree`, `attrTagProps` | Section 8. |
| `params` | Tag params as source text. |
| `var` | The `/var` binding as source text, or `null`. |
| `data` | Whatever the host's `resolveDelegatedTag(name, node, ctx)` returned, or `undefined` with no hook. Opaque to core. |

This is decision 79's narrow escape hatch: every host-owned construct (`<try>`, `<html-comment>`, a future `<signal>`) arrives here fully resolved. The parser node is deliberately **not** carried; a host records what it needs in `data` while the node is in hand, and an emitter must consume only the IR and `data`. A claimed tag's children are lowered exactly once (`lower.test.ts` › "a claimed tag's children are lowered exactly once"). A contract-only custom tag (decision 130) also becomes a `DelegatedTag` on a name the host claims; `<try>` is a built-in custom tag that asks for one through `ctx.build.delegatedTag`.

### 5.14 `DocumentType` and `Comment`

`DocumentType` is `{ value }`, delimiters stripped. `Comment` is `{ value, html: boolean, span? }`: `value` has the delimiters stripped, and `html` is true for `<!-- -->`, false for a `//` line comment (only the source can tell). A `//` comment (`html: false`) is author-only: no host writes it out. An HTML comment is written out by Astro and Angular as `<!--value-->` and dropped by html, Preact (React, Hono) and Solid, as stock Marko drops it (`<html-comment>` is how an author emits one there). Pinned by `lower.test.ts` › "Comment records whether the source spelled an HTML comment"; `ir-contract.test.ts` › "5.14: …" in html, preact, solid, astro and angular. (`HostDeclarations.keepComments` is declared and set by Astro, but no code reads it: the emitter's own `comment()` decides.)

## 6. `Attr`

Every non-spread attribute has `name`, `nameSpan` (required), `loc` at the name, and an optional `sugar` (the decision-146 token, `:email`, when the attribute came from sugar).

| Kind | Fields | Produced for |
| --- | --- | --- |
| `static` | `value: string`, `valueSpan?`, `atom?: Atom` | A string-literal value. Also a valueless colon name, `<div value:foo/>`, with `value: ""` (bare `:foo` is the name sugar, decision 146). `atom` is set when the whole value is one atom (`mode=:strict`) and on the `name` the `:name` sugar sets (decision 156 addendum 1, item 2); `value` is then the atom's name, which every target emits, and `valueSpan` is the atom's span. |
| `boolean` | — | A bare attribute (`disabled`), HTML's `true`. |
| `dynamic` | `value: Expr` | Any other expression value; also a host-resolved modifier (`resolveModifier` returns the name) and every `on*` off a native element. |
| `bound` | `value: Expr`, `refinement?: Expr` | `name:=expr`. `name` is the base name. `refinement` is the `fn` of `name:fn:=expr`, Marko's change-handler function (`expr = fn(next)`): an identifier `Expr` over the modifier's text (`node: null`, `span` on the modifier), absent without a modifier; a modifier that is no valid identifier (`x::=q`, `v:no-update:=q`) is Marko's lowering error at the modifier. A host with no update path emits the initial value Angular emits `[name]="__mxGet(expr)"` plus `(nameChange)="__mxSet(object, 'key', fn($event))"` (signal-aware, like `[(name)]`); html ignores `refinement` at run time but type-checks it; a host that refuses `:=` refuses a refined form the same way. |
| `event` | `event: string`, `value: Expr` | `on<Name>`/`on-<exact>` with an expression value, on an `Element` only. `event` is the DOM name: lowercased after `on` for `on<Name>`, verbatim after `on-` for `on-<exact>`. `name` keeps the source spelling. |
| `spread` | `value: Expr` | `...expr`. No name, no `nameSpan`, no `sugar`. |

Rules a lowering must apply, in this order (`lowerAttrNamed`):

1. Spread first. Then an invalid attribute name is an error unless the host sets `acceptsForeignAttrNames`.
2. A colon name keeps its complete spelling (`x:foo`) except, on a native element, the reserved `class:`/`style:`/`on:` prefixes, which go to the host's `resolveModifier` (a returned name makes a `dynamic` attr) or are an error (`rejectModifier`, then core's wording).
3. An attribute method (`onClick() { … }`) is allowed only when the host's `resolveAttributeMethod` returns `true`; its value is an `Expr` over the function expression Marko builds for the method, whose body is synthetic (so its column mapping can drift, [Spans and mappings](/architecture/spans-and-mappings/)). Preact and Solid reprint it in their own function form. Pinned by `lower.test.ts` › "lowers an attribute method on an element to an event with an arrow value".
4. `bound`, then `static` (string literal), then `boolean` (literal `true`), **then** `event`, then `dynamic`. The event check comes last so `<div onClick>` stays `boolean` and `<button onClick="alert(1)">` stays `static`. Pinned by `lower.test.ts` › "event attributes" (all tests) and "`on*` outside a native element stays a prop".
5. Duplicates resolve **last-wins** by `name` (case-sensitive), with a warning for each dropped occurrence; spreads never count (decision 135). The IR never carries two attributes of the same name. Pinned by `lower.test.ts` › "duplicate attributes resolve last-wins (decision 135)".
6. The host's `orderAttrs(name, attrs, on, ctx)` may reorder the result.

Pinned overall by `lower.test.ts` › "Attr separates static, dynamic, bound and spread".

## 7. `Block`

`{ hasParams: boolean, params: string[], children, loc }`: a child list a host emits as a callable unit — a component's `content`, an attribute tag's `block`. `params` are the block's tag params as source text; `hasParams` distinguishes `<Tag||>` (true, `params: []`) from no pipes. Params shadow host bindings inside `children` only. A host with no render-prop form rejects non-empty `params` itself; core resolves the shape and does not decide whether the target can express it.

## 8. Attribute tags

A `Component` and a `DelegatedTag` (and, recursively, an `AttributeTag`) carry **three synchronized views** of their `<@name>` tags (decisions 106–108):

| View | Type | Contract |
| --- | --- | --- |
| `attributeTags` | `AttributeTag[]` | Every occurrence, flattened, in source order. Repeats are kept (`lower.test.ts` › "Component keeps every repeated attribute tag, not just the last"). |
| `attributeTagTree` | `AttributeTagNode[]` | The same occurrences with their `<if>`/`<for>` structure: `AttributeTag { tag }`, `AttributeTagIf { branches: [{ test?, span, nodes }] }` (no `test` on `<else>`), `AttributeTagFor { loop: ForHead, nodes }`. Static tags and control-flow tags merge in authored order. |
| `attrTagProps` | `AttrTagProp[]` | The emission plan, one entry per property name: `cardinality` (`"single"`/`"array"`), `as` (`"data"`/`"renderable"`), and `source` (the tree filtered to that name). |

`AttributeTag` is `{ name, nameSpan, span?, attrs, block: Block, hasBody, attributeTags, attributeTagTree, attrTagProps }`. `name` excludes the `@`. `hasBody` follows `hasContent`. `content` is reserved and rejected as an attribute name.

How `attrTagProps` is resolved:

- Against the callee's declared `Input`, read synchronously and cross-file (`callee-input.ts`). A declared `AttrTag` is `single` (at most once, never inside `<for>`), `AttrTag[]` is `array`, a required one must appear on every `<if>` path; each violation is a positioned error. A declared shape is authoritative and defaults to `as: "data"`.
- With no declaration (untyped, unresolved, dynamic callee), cardinality comes from the occurrences (`array` if more than one or inside a `<for>`), and `as` is `renderable` only if every occurrence of that name is body-only; one occurrence with attributes or nested tags makes it `data`.
- A required declared tag absent from the call is a positioned error ("missing required attribute tag").
- `@children` collides with ordinary children when the call also has body content.

**The v2 gate.** A host that declares `attrTags: 2` in its `HostDeclarations` must emit from `attrTagProps` and must not regroup `attributeTags` or resolve declarations itself. For a host that has not declared it, core positions an error on every construct whose shape could otherwise be dropped (attributes on attribute tags, nested attribute tags, a declared shape that differs from the flat view) — "… isn't supported by `<host>` yet". Pinned by `lower.test.ts` › "attribute-tag v2 IR and validation" and `attribute-tag-contracts.test.ts`.

Builder-made tags (`ctx.build.delegatedTag`, a routed template call without a precomputed plan) get a plan with `as: "data"` and occurrence-count cardinality (`custom-tags.ts`, `template-tag.ts`).

## 9. Custom tags, contracts and sugar: what reaches the IR

None of these is an IR kind. Each is resolved during lowering into ordinary nodes:

- **Name sugar and default tag**: tree rewrites before the walk (section 1, step 1). Visible in the IR only as `Attr.sugar`.
- **Custom tags** (programmatic, discovered sidecars and templates): validated against their contract, then replaced by whatever `transform` returns (`IrNode[]`, possibly empty or several nodes), or routed to their template as a `Component` with a generated `name` target, `authoredName`, `returnsValue` and a synthesized `Import`. A `finalize` hook's nodes are prepended to `Ir.body`.
- **Contracts** (`mx.contracts`, decision 142): validation only; a contract-only tag on a claimed name becomes a `DelegatedTag` (decision 130).
- **`<try>`**: a built-in custom tag that validates and emits a `DelegatedTag` named `try`.
- **Not yet in the IR**: decision 147 (wildcard `children["*"]`, its alias capture) and decision 156 (atoms) have no IR representation in the code today. This page gains their nodes when they land.

## 10. The emitter contract

### 10.1 `Emitter<Out>` and `drive`

```ts
interface Emitter<Out> {
  text(node): void;
  interpolation(node): void;
  element(node): void;
  component(node): void;
  ifChain(node): void;
  forLoop(node): void;
  define(node): void;
  constant(node): void;
  hoisted(node): void;
  delegatedTag(node): void;
  documentType(node): void;
  comment(node): void;
  done(): Out;
}
```

`drive(emitter, nodes)` calls one method per node in order; `emit(emitter, ir)` drives `ir.body` and returns `done()`. Every method is required. A host that cannot express a kind **throws** from its method, naming the construct and its position; it must never silently skip one (the S8 class). `drive` throws on a module-level kind and on an unknown kind. Pinned by `emit.test.ts` › "dispatches each kind to its own emitter method", "throws on an unknown IR kind rather than ignoring it", "throws on a module-level kind reaching the body walk".

A host renders nested child lists (a `Block`, a branch, a loop body) by calling `drive` recursively. Module-level fields (`imports`, `hoisted`, `inputInterface`, `prelude`, `returnValue`, `exportName`, `needsAttrTagImport`) are placed by the host from `Ir`, not by the walk. A host need not use `drive`: `@mxlang/data` walks the IR directly and throws on any kind its declarations make impossible.

### 10.2 Invariants emitters rely on

Each of these is assumed by at least one shipped emitter or tool without re-checking. A lowering that breaks one produces wrong output or a crash downstream, not a diagnostic.

| # | Invariant | Relied on by | Pinned by |
| --- | --- | --- | --- |
| E1 | No module-level kind in any child list; statement kinds live only in `Ir` fields (and `Hoisted` only in `prelude` or at the head of a `Define`). | `drive`; Angular's `emitNode`. | `emit.test.ts` › "throws on a module-level kind reaching the body walk" |
| E2 | Every node has `loc`. Hosts position their own errors from it. | every host's `fail(msg, node)` | `lower.test.ts` › "records a 1-based line and 0-based column on every node" |
| E3 | `Expr.code` is final text: hosts print it verbatim (inside parentheses where needed) and never re-derive the printed code from `node`. Reading `node` to *inspect* an expression is allowed (section 4 lists who does). | html, astro, every JSX host, solid, angular | `lower.test.ts` › "type arguments survive the non-empty binding registry path"; `html/src/ir-contract.test.ts`, `preact/src/ir-contract.test.ts` › "E3: prints Expr.code and never re-derives it from Expr.node" (every `node` set to null, output identical); `solid/src/ir-contract.test.ts`, `astro/src/ir-contract.test.ts`, `angular/test/ir-contract.test.ts` › "E3: prints Expr.code, not text rebuilt from Expr.node" |
| E4 | `shape` is exact: `class=` with `object`/`array` takes the structured class path (Preact/React/Hono `__mxClass`, Astro `class:list`); `style=` must be `object` on JSX hosts; a `by=` key with `shape: "string"` is a field name. | preact, solid, astro | `lower.test.ts` › "Expr records its parsed value shape during resolution"; `preact/src/index.test.ts` › "rejects a non-object `style=` value" |
| E5 | One attribute per name, already last-wins, in authored order including spreads. Hosts no longer reorder (html builds a merged object in authored order when a spread is present). | html, astro | `lower.test.ts` › "drops an earlier attribute across a spread, and keeps a lone one before it"; `lower.test.ts` › "lets the host order attributes before they enter the IR" |
| E6 | `event` appears only on an `Element`, with `event` already the DOM name; a component's `onX` is a `dynamic` prop. | every host's event emission | `lower.test.ts` › "event attributes", "`on*` outside a native element stays a prop" |
| E7 | A default attribute's `nameSpan` is zero-width; consumers detect "default" by the empty range. | preact, the language tools | `spans.test.ts` › "is zero-width at the `=`, as in Marko, not `=\"pos`" |
| E8 | `Element.void` is authoritative; a void element has no children. A host omits the close tag and the children of an element whose `void` is set, whatever its name (html additionally treats a name in `VOID_TAGS` as void; lowering never produces the two out of step). | html, preact, solid, astro, angular | `lower.test.ts` › "Element marks a void tag and takes no children"; `ir-contract.test.ts` › "E8: Element.void alone omits the close tag and the children" in html, preact, solid, astro and angular |
| E9 | `Text.value` is already normalized; hosts never re-normalize. | every host | `spans.test.ts` › "Text: span slices the authored text, which `value` has normalized"; `ir-contract.test.ts` › "E9: Text.value is printed as it stands, never re-normalized" in html, preact, solid, astro and angular |
| E10 | An `IfChain` is pre-grouped and only its last branch may have `condition: null`. | html reads `branch.condition?.code` per branch | `lower.test.ts` › "IfChain groups every branch, with a null condition for else" |
| E11 | `For.params` is non-empty; `For.bindings` lists every name the params bind (hosts and core's `rewriteCodes` build scopes from `For.bindings` and `Define.params`); `paramNodes` are positioned parser nodes (Angular reads them to alias `$index`). | html, angular, solid, `rewrite-codes.ts` | `lower.test.ts` › "For normalizes `of=`, with params and their bindings"; `core/src/rewrite-codes.test.ts` › "rewriteCodes scopes (E11)" |
| E12 | A range's `from: null` means start at 0; `inclusive` selects `<=` versus `<`; `key` may be ignored by a one-shot host. | html, astro, preact, solid, angular | `lower.test.ts` › "For normalizes the inclusive and exclusive ranges apart"; `html/src/translate.test.ts` › "accepts by= on <for> with no effect on the output"; `ir-contract.test.ts` › "E12: a range's from: null starts at 0 and inclusive picks the bound" in html, preact, solid, astro and angular |
| E13 | `Component.returnsValue` is set from the callee whenever the callee declares `<return>`, `/var` or not; `/var` on a non-returning callee never reaches an emitter. The JSX hosts unwrap `{ value, output }` from it; html and astro do not (the default export is `(input) => string`, the value comes from `render`). | preact | `lower.test.ts` › "reports the value in the metadata a caller reads"; `html/src/translate.test.ts` › "binds /var to the call's render value, writing into the caller's sink" |
| E14 | `Ir.exportName` is present whenever the compile emits a module; hosts declare the default export under it, so a self-call needs no import (§7.5-7). | html, preact, solid, angular | `lower.test.ts` › "names the export after the file"; `html/src/translate.test.ts` › "compiles a self-recursive template" |
| E15 | `Ir.returnValue` is at most one, unconditional, top level (§7.5-5); validated in the unit's own compile. | html, preact, solid | `lower.test.ts` › "<return>" block |
| E16 | `attrTagProps` is the plan: a `single` prop's `source` contains no `AttributeTagFor` (html fails with "internal attribute-tag plan error" otherwise); `declared` marks a plan from a declared `Input`. | html, preact, solid | `lower.test.ts` › "attribute-tag v2 IR and validation"; `attribute-tag-contracts.test.ts`; `html/src/ir-contract.test.ts` › "E16: a single attrTagProps value holding a <for> is an internal plan error" |
| E17 | Every claimed `DelegatedTag` has the `data` its host's `resolveDelegatedTag` returned; emitters cast it and switch on `data.kind` with no null check. A host that claims a tag must supply the hook. | html, preact, solid, angular, astro | `lower.test.ts` › "DelegatedTag hands a claimed tag over with its parts lowered" |
| E18 | A claimed dynamic `DelegatedTag` carries `args`, `children` and all three attribute-tag views, and an emitter rebuilding the call forwards them. | html (`renderDynamic`) | `lower.test.ts` › "retains arguments on a claimed dynamic DelegatedTag", "a claimed dynamic tag's DelegatedTag carries its attribute tags"; `html/src/translate.test.ts` › "forwards an attribute tag on a dynamic tag into the renderDynamic call, not `{}`" |
| E19 | A synthesized `Import` carries `bindings[0]`, `specifier` and `resolvedPath`; Solid throws an internal error otherwise. | solid, data (skips them) | `solid/src/index.test.ts` › "hands the synthesized import back instead of rejecting it" |
| E20 | Every source-backed node the data target admits carries its `span` (`Text`, `Interpolation`, `Comment`, `IfChain`, `Branch`, `For` and `paramSpans`, `Const`, `DelegatedTag` `nameSpan`/`span`, a static attribute's finite `valueSpan`). | data | `data/src/attr-tag-span-guard.test.ts` |
| E21 | Emitters must not mutate the IR. One lowered `Ir` may be emitted more than once, and a lowering may share an object (an `Expr`, a `loc`) between two places. An emitter that rewrites `Expr.code`, `For.bindings` or a parser node takes a private copy first (`cloneIr`, `@mxlang/core`): Solid copies each `For` it rewrites, and Angular's tag module copies the whole `Ir` before `projectSlots` and `rewriteInputReads`. `rewriteCodes` still visits each shared object once, so a rewrite applied to a copy is applied once. | every host | `ir-readonly.test.ts` in html, preact (also React and Hono), solid, astro, angular (page: `angular/test/ir-readonly.test.ts`; tag module: `angular/test/ir-readonly-tag-module.test.ts`) and data: the IR is frozen all the way down (parser nodes included) before the emitter sees it, so a write throws; `core/src/clone-ir.test.ts` |
| E22 | Emission follows IR walk order: the TypeScript plugin finds each `Expr.code` in the generated text after the previous match. | `@mxlang/typescript-plugin` | `typescript-plugin/src/index.test.ts` › "keeps duplicate expression mappings on their own forward occurrences" |

### 10.3 Who rewrites expressions

Core: only the binding-registry rewrite a host requests (section 4). In emitters:

- **`@mxlang/solid`** rewrites every read of a `<for>` param Solid hands as an accessor into a call (`p.name` → `p().name`, decision 94; `rewriteAccessorReads` in `accessor-reads.ts`, applied in the emitter's `rewriteForBody`, on a private copy of the `For`, E21). Pinned by `solid/src/client-render.test.ts` › "re-renders a same-key row replacement under <for by=\"id\">, …".
- **`@mxlang/angular`**'s tag module rewrites `input.x` to the class property `x` (`tag-module.ts` `rewriteExpr`, on a private copy of the IR, E21), and its `by=` lowering slices `key.code` by Babel offsets. Pinned by `angular/test/for-by-scope.test.ts` › "still lowers the forms Angular supports to `track`".
- **`@mxlang/preact`** (and React, Hono) and **`@mxlang/solid`** reprint an attribute-method value as a function expression.
- **`@mxlang/html`** and **`@mxlang/astro`** print `code` unchanged.

### 10.4 What each emitter rejects

An emitter rejects a construct by throwing a positioned error from its method. The IR does not pre-filter by host (except through `HostDeclarations`), so a new lowering must still produce these nodes; the emitter decides. Known rejections:

| Construct | Rejected by | Message (abridged) / test |
| --- | --- | --- |
| `For` range `step` | html, astro | "`<for step=...>`: step is not supported; use a computed array" — `html/src/translate.test.ts` › "rejects step= on <for>: …", `astro-template.test.ts` › "rejects `step=`, as the core does" |
| `step=0` | angular, solid | `angular/test/for.test.ts` › "rejects step=0" |
| `Const` not at top level | preact (and React, Hono) | `preact/src/index.test.ts` › "rejects a `<const>` nested inside markup" |
| `Const` | solid region, astro | "`<const>` cannot declare a binding inside a JSX expression" — `astro-template.test.ts` › "rejects <const>, which a template expression cannot declare" |
| `Define` nested in markup | solid | `solid/src/index.test.ts` › "rejects a <define> nested inside <for>/<if> with a positioned error" |
| `Hoisted` inside a JSX expression | preact, solid | "a hoisted statement cannot be emitted inside a JSX expression" — `preact/src/ir-contract.test.ts`, `solid/src/ir-contract.test.ts` › "10.4: a Hoisted node in the body is rejected, positioned" |
| `Interpolation` with `escaped: false` not the sole child | preact, solid | "raw placeholder (`$!{…}`) must be the only child" |
| `DocumentType` | preact, data | `preact/src/index.test.ts` › "rejects a document type, which belongs in the HTML shell" |
| `Component` with a `dynamic` target | astro, data | `astro-template.test.ts` › "rejects a dynamic tag name" |
| `Component.var` | astro (any), preact/solid (inside `<for>`/`<if>`) | `astro-template.test.ts` › "rejects /var on it, naming the tag as written"; `preact/src/index.test.ts` › "rejects /var inside <for>, naming the tag as written" |
| `Ir.returnValue` | astro, angular | `astro-template.test.ts` › "rejects the .astro.mx file's own <return>"; `angular/test/tag-module.test.ts` › "errors rather than emitting `<return>` as a literal template element" |
| Content `Block` with params | astro, angular | `angular/test/component.test.ts` › "rejects content with tag params, naming the real tag rather than a literal {Tag} placeholder" |
| Attributes or nested tags on an attribute tag | astro | `astro-template.test.ts` › "rejects attributes on an attribute tag with a positioned host error" |
| `event` with an expression value | html, astro | no runtime to bind it |
| `<html-comment>` claim | preact, react, hono, solid | `preact/src/index.test.ts` › "rejects <html-comment> instead of emitting a literal element" |
| `Component`, `Element`, `Define` | data | "calls a template tag; a data file cannot call a template tag" for a call; "unexpected IR node kind" for the others, which its declarations make unreachable |

A host whose output has a returning unit invoked as a plain function also refuses hook imports in it (`preact/src/index.test.ts` › "rejects a hook in a unit that declares <return>").

## 11. Stability and adding a node

**Public.** `@mxlang/core` exports the IR types `Attr`, `AttributeTag`, `AttributeTagNode`, `AttrTagProp`, `Block`, `Branch`, `ComponentTarget`, `DelegatedTag`, `Expr`, `ExprShape`, `ForHead`, `ForSource`, `Ir`, `IrNode`, `Position`; `SourceSpan`, `GeneratedMapping`, `MappedCode` and the mapping helpers; `Emitter`, `drive`, `emit`; `lower`, `lowerChildren`, `expressionShape`. `AttrSugar` and `IrBase` are not exported by name (they reach consumers only inside `Attr` and each node). None of the IR types is marked `@unstable`; the only `@unstable` surface in core is the target contract (`target-descriptor.ts`, `target-loader.ts`, `descriptorVersion: 0`). The package is `0.1.0-alpha.1`, so no semver guarantee applies yet.

**Rules for changing the IR** (decisions 79 and 80):

- The kind set is **closed** in MX 1: structural core plus "component call". A new construct with compile-time meaning becomes an IR kind (or a field on one) only when every host must emit it differently; host-owned constructs travel as `DelegatedTag` with their decision in `data`.
- Adding a kind means adding it to `IrNode`, to `Emitter` (a required method) and to `drive`'s switch. Because `drive`'s `default` narrows to `never`, the compiler then fails every emitter until each one **handles or rejects** the kind; no emitter may ignore it. A direct walker (`@mxlang/data`) must handle it or throw.
- User-defined compile-time tags (decision 80, MX 2) must produce IR, not host output: input IR in, IR out, positions preserved, run in core before emitters. That is what `transform` already is for custom tags. No opaque "user node" every host must handle is admitted.
- A new optional field must document its absence (synthesized or not applicable); a new span field follows section 3.

## 12. Worked example

One template, the IR the core lowers it to under `@mxlang/html`'s declarations, and the module `@mxlang/html` emits from that IR. All three are real files in `apps/docs/example/ir-spec/`, quoted here verbatim; `apps/docs/scripts/ir-example.test.ts` regenerates both outputs on every docs test run and fails when either drifts or a block below stops matching its file. Regenerate with `bun scripts/ir-example.ts --write` from `apps/docs`.

The template, `greeting.mx`:

```mx
export interface Input {
  name: string;
  items: string[];
}

<const/count=input.items.length/>
<h1 class="title">Hello, ${input.name}!</h1>
<if=count>
  <ul>
    <for|item| of=input.items>
      <li>${item}</li>
    </for>
  </ul>
</if>
<else>
  <p hidden>Nothing yet.</p>
</else>
```

Its IR, `greeting.ir.json`. `Expr.node` and `For.paramNodes` are elided (section 4); everything else is exactly what `lower()` returned. Note the lifted `inputInterface`, the empty `prelude`, `count` as a `Const` before the elements, the two `Text` runs around the interpolation, the chain with `condition: null` on its `<else>`, the `boolean` `hidden` attribute and the `exportName` derived from the filename:

```json
{
  "imports": [],
  "hoisted": [],
  "inputInterface": {
    "kind": "InputInterface",
    "code": "export interface Input {\n  name: string;\n  items: string[];\n}",
    "loc": {
      "line": 1,
      "column": 0
    },
    "end": {
      "line": 4,
      "column": 1
    },
    "span": {
      "sourceStart": 0,
      "sourceEnd": 61
    }
  },
  "needsAttrTagImport": false,
  "prelude": [],
  "body": [
    {
      "kind": "Const",
      "name": "count",
      "init": {
        "code": "input.items.length",
        "shape": "other",
        "span": {
          "sourceStart": 76,
          "sourceEnd": 94
        }
      },
      "span": {
        "sourceStart": 63,
        "sourceEnd": 96
      },
      "loc": {
        "line": 6,
        "column": 0
      }
    },
    {
      "kind": "Element",
      "name": "h1",
      "nameSpan": {
        "sourceStart": 98,
        "sourceEnd": 100
      },
      "span": {
        "sourceStart": 97,
        "sourceEnd": 141
      },
      "attrs": [
        {
          "kind": "static",
          "name": "class",
          "value": "title",
          "valueSpan": {
            "sourceStart": 107,
            "sourceEnd": 114
          },
          "nameSpan": {
            "sourceStart": 101,
            "sourceEnd": 106
          },
          "loc": {
            "line": 7,
            "column": 4
          }
        }
      ],
      "children": [
        {
          "kind": "Text",
          "value": "Hello, ",
          "span": {
            "sourceStart": 115,
            "sourceEnd": 122
          },
          "loc": {
            "line": 7,
            "column": 18
          }
        },
        {
          "kind": "Interpolation",
          "expr": {
            "code": "input.name",
            "shape": "other",
            "span": {
              "sourceStart": 124,
              "sourceEnd": 134
            }
          },
          "escaped": true,
          "span": {
            "sourceStart": 122,
            "sourceEnd": 135
          },
          "loc": {
            "line": 7,
            "column": 25
          }
        },
        {
          "kind": "Text",
          "value": "!",
          "span": {
            "sourceStart": 135,
            "sourceEnd": 136
          },
          "loc": {
            "line": 7,
            "column": 38
          }
        }
      ],
      "void": false,
      "loc": {
        "line": 7,
        "column": 0
      }
    },
    {
      "kind": "IfChain",
      "branches": [
        {
          "condition": {
            "code": "count",
            "shape": "other",
            "span": {
              "sourceStart": 146,
              "sourceEnd": 151
            }
          },
          "children": [
            {
              "kind": "Element",
              "name": "ul",
              "nameSpan": {
                "sourceStart": 156,
                "sourceEnd": 158
              },
              "span": {
                "sourceStart": 155,
                "sourceEnd": 232
              },
              "attrs": [],
              "children": [
                {
                  "kind": "For",
                  "source": {
                    "kind": "of",
                    "list": {
                      "code": "input.items",
                      "shape": "other",
                      "span": {
                        "sourceStart": 178,
                        "sourceEnd": 189
                      }
                    }
                  },
                  "params": [
                    "item"
                  ],
                  "bindings": [
                    "item"
                  ],
                  "paramSpans": [
                    {
                      "sourceStart": 169,
                      "sourceEnd": 173
                    }
                  ],
                  "key": null,
                  "children": [
                    {
                      "kind": "Element",
                      "name": "li",
                      "nameSpan": {
                        "sourceStart": 198,
                        "sourceEnd": 200
                      },
                      "span": {
                        "sourceStart": 197,
                        "sourceEnd": 213
                      },
                      "attrs": [],
                      "children": [
                        {
                          "kind": "Interpolation",
                          "expr": {
                            "code": "item",
                            "shape": "other",
                            "span": {
                              "sourceStart": 203,
                              "sourceEnd": 207
                            }
                          },
                          "escaped": true,
                          "span": {
                            "sourceStart": 201,
                            "sourceEnd": 208
                          },
                          "loc": {
                            "line": 11,
                            "column": 10
                          }
                        }
                      ],
                      "void": false,
                      "loc": {
                        "line": 11,
                        "column": 6
                      }
                    }
                  ],
                  "span": {
                    "sourceStart": 164,
                    "sourceEnd": 224
                  },
                  "loc": {
                    "line": 10,
                    "column": 4
                  }
                }
              ],
              "void": false,
              "loc": {
                "line": 9,
                "column": 2
              }
            }
          ],
          "span": {
            "sourceStart": 142,
            "sourceEnd": 238
          },
          "loc": {
            "line": 8,
            "column": 0
          }
        },
        {
          "condition": null,
          "children": [
            {
              "kind": "Element",
              "name": "p",
              "nameSpan": {
                "sourceStart": 249,
                "sourceEnd": 250
              },
              "span": {
                "sourceStart": 248,
                "sourceEnd": 274
              },
              "attrs": [
                {
                  "kind": "boolean",
                  "name": "hidden",
                  "nameSpan": {
                    "sourceStart": 251,
                    "sourceEnd": 257
                  },
                  "loc": {
                    "line": 16,
                    "column": 5
                  }
                }
              ],
              "children": [
                {
                  "kind": "Text",
                  "value": "Nothing yet.",
                  "span": {
                    "sourceStart": 258,
                    "sourceEnd": 270
                  },
                  "loc": {
                    "line": 16,
                    "column": 12
                  }
                }
              ],
              "void": false,
              "loc": {
                "line": 16,
                "column": 2
              }
            }
          ],
          "span": {
            "sourceStart": 239,
            "sourceEnd": 282
          },
          "loc": {
            "line": 15,
            "column": 0
          }
        }
      ],
      "span": {
        "sourceStart": 142,
        "sourceEnd": 282
      },
      "loc": {
        "line": 8,
        "column": 0
      }
    }
  ],
  "tagMetadata": {
    "readsContent": false,
    "attributeTags": [
      "items",
      "name"
    ],
    "inputCode": "export interface Input {\n  name: string;\n  items: string[];\n}"
  },
  "exportName": "Greeting",
  "returnValue": null
}
```

The module `@mxlang/html` emits from it, `greeting.html.ts`:

```ts
import { escape as __mxEscape, createOut as __mxCreateOut, type Out as __MxOut } from "@mxlang/html";

export interface Input {
  name: string;
  items: string[];
}

function Greeting(input: Input): string {
  const __mxOut = __mxCreateOut();
  __mxRender(input, __mxOut);
  return __mxOut.toString();
}
Greeting.render = __mxRender;

function __mxRender(input: Input, __mxOut: __MxOut): void {
  const count = input.items.length;
  __mxOut.write("<h1 class=\"title\">Hello, ");
  __mxOut.write(__mxEscape(input.name));
  __mxOut.write("!</h1>");
  if (count) {
    __mxOut.write("<ul>");
    const __mxFor6 = input.items;
    const __mxFor7 = __mxFor6 ? __mxFor6 : [];
    for (const item of __mxFor7) {
      __mxOut.write("<li>");
      __mxOut.write(__mxEscape(item));
      __mxOut.write("</li>");
    }
    __mxOut.write("</ul>");
  } else {
    __mxOut.write("<p hidden>Nothing yet.</p>");
  }
}
export { __mxRender as render };
Object.defineProperty(Greeting, Symbol.for("mx.component"), { value: true });

export default Greeting as ((input: Input) => string) & { render: typeof __mxRender };
```

The default export renders into a fresh sink through `render(input, out)`, the module's sink entry (decision 155). Called with `{ name: "<Ada>", items: ["a", "b"] }` it returns `<h1 class="title">Hello, &lt;Ada&gt;!</h1><ul><li>a</li><li>b</li></ul>`; with an empty `items` it takes the `<else>` branch. The test asserts both.

## 13. Errors

A lowering reports **every** error of a file it can find, not the first (decision 162). The recovery unit is the **tag**.

- **Skip, don't cascade.** When lowering a tag raises an error, the lowering records it, skips that tag *with its whole subtree*, and continues with the next sibling. A skipped tag's children are never lowered, so they raise nothing: one mistake yields one error, not the errors its children would have reported against a half-built parent. The same holds for text, interpolations and the statement kinds that fail (a scriptlet, a CDATA section, a declaration).
- **What is not recoverable.** An error raised before the body walk starts (a reserved binding, an atom conversion, a malformed own `Input`, an unparseable file) stops lowering at once, as it always did: there is no tree to continue over. An error raised by a check that needs the whole file (the atom contract check, `finalize` hooks) runs only when the walk recorded no error, because its facts would be partial.
- **What the file-level compile throws.** `compileSource` throws a `TranslateError` whose additive field `errors: readonly TranslateError[]` lists every recorded error, ordered by position (line, then column; a tie keeps lowering order). The thrown error is `errors[0]`, so **`errors[0]` is exactly the error a single-throw lowering would have thrown**: its message, `line`, `column`, `file`, `spans`, `dependencies` and `atomFacts` are unchanged, and a consumer that reads only the thrown error sees what it always saw. `errors` has one entry (the error itself) when only one was found, and is absent on an error that did not come from the body walk. Where the first error raised is not the earliest by position (a construct that reports at an earlier column than a sibling that failed before it), the first error raised is `errors[0]` and the rest follow by position.
- **A callee's error.** An error raised inside an inlined tag template is recorded against the *call site's* tag in the caller's walk, carrying the template's `file` as before (spec §2 of custom tags, third position rule). The callee is not walked a second time for more of its errors.
- **Error-free files are unchanged.** Recovery adds no node, no field and no byte to the `Ir` or to any target's output of a file that raised nothing.
- **Nothing host-specific.** Recovery lives in the lowering. An emitter never sees a skipped tag, because a file that recorded an error is never emitted.
- **Reporting.** Every tool that reports a compile error reports all of `errors`: `mx-tsc` and the TypeScript plugin (one diagnostic each), the language server (one diagnostic each), the Vite plugin (the first as the thrown error, the others in its message), the Bun loader and `@mxlang/data`'s `parseData` (which collects the same list instead of its own duplicate).
