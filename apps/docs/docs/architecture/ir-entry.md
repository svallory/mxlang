---
title: "Core IR entry point and dialects"
description: "lowerSource and lowerFile hand a program core's IR for a .mx file, with every diagnostic positioned, for a dialect that interprets the tree itself."
---

# Core IR entry point and dialects

`@mxlang/core` exports `lowerSource` and `lowerFile`: parse a `.mx` source, lower it, check it, and return **core's own IR** with every diagnostic positioned. Nothing is emitted and nothing is evaluated. A program that gives MX tags its own meaning (a **dialect**, such as Mesh's resource definitions, a config loader or a code generator) walks the IR and decides what each tag means.

This replaces the tree target (`@mxlang/data`, `parseData`, the `Data*` tree types), which was deleted. The IR is the tree: there is no second projection to keep in step with it. The normative description is [specification §13.7](/specification/#the-mx-language-13-host-semantics-table-137-the-core-ir-entry-point); the IR itself is in the [IR specification](/architecture/ir-spec/).

Both functions are `@unstable`, like the IR they return.

## Lower a file

```ts
import { lowerSource } from "@mxlang/core";

const { ir, diagnostics } = lowerSource(source, filename);
if (!ir) {
  // Every independent error, positioned (line 1-based, column 0-based).
  // Never a partial IR.
  for (const d of diagnostics) console.error(d.line, d.column, d.message);
}
```

Given a resource definition:

```mx
resource="post" table="posts"
  attributes
    attribute="title" type="string" required
  actions
    create accept=["title"]
```

`ir.body[0]` is a `DelegatedTag` whose `tag.name` is `resource`. Its `tag.attrs` hold a static `value` attribute (the default `="post"`) and a static `table`; its `tag.children` hold the `attributes` and `actions` tags. Every node, attribute and expression has a `span` that slices the authored text.

`lowerFile(path, options)` reads the file and calls `lowerSource`. A file that cannot be read throws, as `readFileSync` does; that is the caller's problem, not a source diagnostic.

## The result

| Field | Meaning |
|---|---|
| `ir` | a `SpannedIr`, or `undefined` on error unless `partial: true` recovered a tree |
| `partial` | present as `true` only when an opt-in call returned an IR beside errors; absent on a clean call |
| `diagnostics` | `IrDiagnostic[]`: `{ severity, message, line, column, offset, end?, file?, code?, fixes? }`. On success it holds this call's warnings only |

`lowerSource` never throws for anything in the source. A parse error, a rejected construct and a failed contract are each an error diagnostic, and every independent error of the file is reported once, in position order. A bug in core that surfaces with no position is reported at `1:0` with an `internal error: ` prefix, so a caller never has to wrap the call.

`offset` is the UTF-16 offset of `line`/`column`, so a consumer needs no line table (`-1` when `file` names another file, whose text `lowerSource` does not have). `code` is set on every error and every warning core raises, so a consumer matches the code, never the wording.

`end` is where the diagnostic stops: `{ line, column, offset }`, exclusive, with `line` 1-based and `column` 0-based as the start. It is absent when core does not know a range, and a consumer then underlines from `line`/`column` as it did before. A diagnostic that blames a whole tag ends at the end of `<name`, so a tag with a long body is not underlined from top to bottom. An attribute ends after its value, an expression at its last character, and a parse error at the end of the range the parser gave, which for a point error is its start. A file-level diagnostic (a bad `customTags` registration, a warning with no source position) has no `end`. `end.offset` follows the start: it is a valid offset in the lowered file for every diagnostic located there, and `-1` only when `file` names another file. The range is never backwards: `end` is the start or later.

### Partial recovery

The default remains all-or-nothing. Pass `partial: true` to `lowerSource` or `lowerFile` to keep a partial IR beside error diagnostics:

```ts
const result = lowerSource(source, filename, { partial: true });
if (result.ir) inspect(result.ir);
if (result.partial) console.error("Some constructs were omitted");
```

Recovery omits the smallest enclosing node that cannot be completed, with no placeholders:

- A failed child is omitted; its parent and valid siblings remain. A failure in an attribute, tag head or tag-local contract removes the whole owning tag, including its body. A failed `<if>` head removes its whole branch chain.
- A dialect lowering hook's `ctx.fail` removes its owning tag, or its line trigger. Other hooks continue in source order, and surviving synthesized tags keep their trigger metadata.
- An IR-entry check reject (an unknown tag, a structural construct, a dynamic tag or a spanless attribute) removes that construct. An invalid attribute tag removes its enclosing ordinary tag, keeping its synchronized attribute-tag views consistent.
- A tag rejected by a script-shape, script-body syntax or stale-derived-read check is omitted even when the check collects diagnostics without throwing. Hoists, pending imports and finalization eligibility from an omitted subtree are rolled back. Derived declarations made by a failed `analyze` hook or by omitted scratch-walk calls are discarded. Declarations from a successful `analyze` stay even if that tag's transform later fails and its call is omitted. Hook-private stores are not rolled back: writes by an omitted transform remain visible to later calls and finalization of the same tag.
- `analyze` runs over the scratch walk's surviving calls before transforms run. A tag whose own `analyze` fails is omitted without running its transform or finalizer; other tags still lower. A tag with no surviving call is not finalized. Other whole-file hook failures (`afterLower`, `finalize`) retain the already-lowered tree, with the error and `partial: true`; failed finalization contributes no nodes.

Every returned node still meets `SpannedIr`'s span guarantee and retains its tag information. Diagnostics keep their codes, positions and messages; errors the default stops before are also reported. A parse or registration failure that leaves no usable tree still returns `ir: undefined`, without the flag; reserved-name refusals also return no tree, even after recovery. Recovery also refuses a tree whose span invariants cannot be repaired. A successful call with `partial: true` returns exactly the default result, without a `partial` field. This option changes no IR node shape and does not bump `IR_VERSION`.

### Diagnostic codes

Each rule has one code, and `MX_DIAGNOSTIC_CODES` (exported from `@mxlang/core`, `@unstable`) lists every one as `{ code, severity, summary }`. [The specification, §13.7.5](/specification/) has the full table. The codes come in families:

| Family | Examples |
|---|---|
| Lowering: the language's own rules | `MX_INVALID_IF`, `MX_INVALID_TAG_VAR`, `MX_UNBOUND_COMPONENT`, `MX_UNSUPPORTED_CONSTRUCT` |
| Contract: a call checked against its tag's contract | `MX_UNKNOWN_TAG`, `MX_MISSING_ATTRIBUTE`, `MX_TAG_NOT_ALLOWED`, `MX_TEXT_NOT_ALLOWED`, `MX_INVALID_DEFAULT_TAG` |
| Data file | `MX_STRUCTURAL_CONSTRUCT`, `MX_NOT_IN_DATA_FILE` |
| Registration | `MX_INVALID_CONTRACT`, `MX_INVALID_DIALECT_MODULE`, `MX_TAG_FILE_ERROR`, `MX_MODULE_LOAD_FAILED` |
| Hook defaults | `MX_DIALECT_ERROR`, `MX_DIALECT_WARNING`, `MX_TAG_ERROR`, `MX_DIALECT_HOOK_ERROR`, `MX_TAG_HOOK_ERROR` |
| Parse | `MX_PARSE_<CODE>` for the template parser (`MX_PARSE_MISMATCHED_CLOSING_TAG`), `MX_PARSE_EXPRESSION` for an expression, and the front end's own (`MX_EXPECTED_SINGLE_EXPRESSION`, `MX_ATTRIBUTE_TAG_AT_ROOT`) |
| Warnings | `MX_DUPLICATE_ATTRIBUTE`, `MX_NOT_A_DOM_EVENT`, `MX_BODY_DROPPED` |
| Internal | `MX_INTERNAL_ERROR`: a bug in MX, at `1:0` |

A parse error's `end` covers what it points at: an `MX_PARSE_EXPRESSION` error spans the offending token (`|>` is one two-character token), and `MX_PARSE_INVALID_CHARACTER` on a trigger line that ends after its text spans the stray text, trailing whitespace left out. An expression that stops at its delimiter (the `}` of `${1+}`) spans that character; only an error at the very end of the file has nothing to cover, so its `end` stays at its start. When an expression error (`MX_PARSE_EXPRESSION`, or `MX_EXPECTED_SINGLE_EXPRESSION` for `<div x=1 :b>`) in an open tag is what made the tag-level error (`<for of=[1]|x|>` reads `|>` as the pipeline operator, which swallows the tag's `>`, so the tag is reported as never closed), the diagnostics list the expression error first, as Marko does; every other order is by position.

A hook's error carries the code the hook gave, or the hook's default: `MX_DIALECT_ERROR` for a dialect's `ctx.fail`, `unit.fail` and `explainUnknownTag`, `MX_DIALECT_WARNING` for `unit.warn`, `MX_TAG_ERROR` for a contract hook's `ctx.fail`. A hook may pass `at` as a `{ sourceStart, sourceEnd }` span (a contract hook's `ctx.fail` also takes a position), and the error keeps the span. `MX_` is MX's own prefix: a hook that passes a code starting with `MX_` gets `MX_DIALECT_HOOK_ERROR` (`MX_TAG_HOOK_ERROR` from a contract hook) in its place. Use your own prefix.

### `SpannedIr`

The returned IR is core's `Ir` with the span guarantee in its type (`SpannedIr` is `Spanned<Ir>`; `Spanned<T>` is exported for a consumer that types one node, such as `Spanned<DelegatedTag>`): every `span` is required, at every depth. A `DelegatedTag` and an `AttributeTag` also carry their `nameSpan`, and a `DelegatedTag` always has `args` (`[]` when the tag has none). A static attribute always has its `valueSpan`, a member's included (`e=""` spans its quotes; a bare colon name such as `x:foo`, whose value is `""`, has a zero-width one at the name's end), and so does a dynamic, bound, event or spread attribute, where it is the value as written, wrapper included (`valueSpan` differs from `value.span` when the default lowering stripped a wrapper such as `as T`, `!` or parentheses; an attribute a contract `default` added has a zero-width one; on a static attribute a wrapper such as `("s" as const)` does not show in `valueSpan`, which stays on the literal, and shows only as the attribute's `span` ending after `valueSpan`), and an `Import` always has `from` and `names`. `bodySpan` and `paramSpans` stay optional. A node that should have a span or one of these fields and does not is an `internal error`, never a silent `undefined`.

Two more properties of the returned IR:

- **It is a fresh copy on every call.** Core's own IR is never handed out, so a consumer may mutate what it gets.
- **A tag's span ends at the tag.** In concise syntax core measures a tag through the end of its line; the entry point trims the trailing line terminator (`\n` or `\r\n`), so `source.slice(span.sourceStart, span.sourceEnd)` is `"b\n  c"` for a concise `b` with a child `c`, never `"b\n  c\n"`. A `<tag/>` span is unchanged.

`IR_VERSION` (from `@mxlang/core`) is the version of the IR's shape. A dialect asserts it to detect a core whose IR it was not written against; it goes up with every change a reader can observe. A test in core pins it with a hash of the IR's type declarations, so a change of shape cannot ship without a bump.

### What a dialect reads

| Construct | In the IR |
|---|---|
| A tag | `DelegatedTag`: `tag.name`, `tag.nameSpan`, `tag.span`, `tag.attrs`, `tag.args` (`<x(1, 2)>`), `tag.children`, `tag.attributeTags` (and `tag.attributeTagTree`, which keeps the `<if>`/`<for>` among them) |
| An attribute | `Attr`: `static` (a string literal, a shorthand `#id`/`.class`), `boolean` (`required`), `dynamic` (`n=1`, `values=[…]`, a method `change(x) { … }`), `bound` (`v:=x`), `spread` |
| An expression | `Expr`: `code` (the authored slice), `shape` (`"object"`, `"array"`, `"string"`, `"other"`), `span`, `node` (the Babel node); a method value also has `bodySpan` |
| Text, `${}`, comments | `Text`, `Interpolation`, `Comment` |
| `<if>`, `<for>`, `<const>` | `IfChain`, `For`, `Const` |
| `import` | `ir.imports`: each `Import` has `code`, `span`, `from` (the unquoted specifier) and `names` (`{ imported, local, kind, span, localSpan?, typeOnly? }`) |
| `export`, `static` | `ir.hoisted`: `Export` and `Static` nodes |
| A tag a dialect built | `DelegatedTag.tag.trigger`: `{ id, span, text }` |

Only a string literal is `static`; `n=1` and `required=true` are `dynamic`, because nothing is evaluated.

## The unnamed tag

`<#id>` and `<.class>` with no tag name resolve to the built-in `object` tag: the anonymous node, with an open contract, carrying `id` and `class` as ordinary attributes. It is always known, so it is never an unknown-tag error. A parent's contract can name another tag (`defaultTag: "attribute"` beside `children`), and the `defaultTag` option changes the answer everywhere no parent declares one. The ladder and the errors are in [The unnamed tag](/specification/#the-mx-language-4-elements-and-attributes-the-unnamed-tag).

## Wildcard children

A parent's `children["*"]` entry claims child names that no explicit entry, registered tag or built-in resolves. The IR names the matched tag by its **contract**, and keeps the authored spelling beside it:

| Field | Meaning |
|---|---|
| `tag.name` | the canonical tag whose contract applied; for an inline contract it equals the authored name |
| `tag.alias` | `{ authored, span, groups }`: the name as written, its span, and the entry pattern's named capture groups (empty without any) |

`tag.alias` is absent on every tag no wildcard claimed. A consumer that dispatches on the contract reads `tag.name`. A name no entry matches is the closed-`children` error listing the patterns, and one a typo away from an explicit child is the did-you-mean guard, both reported at the child's position; `unknownTags: "reject"` counts a claimed child as known. The patterns, the check order and the registration errors are in [Wildcard children](/custom-tags/sidecars/#sidecars-declare-the-call-contract-wildcard-children-children).

## Options

```ts
lowerSource(source, filename, {
  customTags, // contract-only tags by name
  tagRules: "none", // "html" (default) | "markup" | "none"
  structural: "reject", // "pass" | "reject"; default: the dialect's, else "pass"
  imports: "pass", // optional; default: the dialect's, else whatever `structural` is
  unknownTags: "reject", // "allow" | "reject"; default: the dialect's, else "allow"
  stripTypes: false, // default: true
  partial: true, // default: false; keep valid subtrees beside diagnostics
});
```

- **`customTags`** declares the vocabulary: required attributes, attribute types, allowed children and parents. `lowerSource` does not scan `tags/` or `package.json`; this map is all it knows. Contracts are enforced at every depth, `analyze` included. See [Contract packages](/custom-tags/contract-packages/).
- **`dialect`** is the file's dialect, or a bare syntax table, for a consumer that builds its own (Mesh passes its dialect, hooks included). Omitted, the dialect that claims the file's extension applies. A dialect you pass on every call should be deep-frozen (`Object.freeze` on it and on every nested object and array; RegExps and functions need not be frozen): core validates a deep-frozen one once and any other again on every call, because a mutable object can change between calls. One frozen only at the top is validated again on every call.
- **`tagRules`** picks the parse rules the source is read under ([below](#core-ir-entry-point-and-dialects-tag-rules-presets)). It is an option of this function only, never a project or host setting.
- **`defaultTag`** is what `<#id>` and `<.class>` stand for in place of `object`.
- **`structural`**, **`imports`** and **`unknownTags`** each default to the value the file's dialect states on its module (the `dialect` option's, else the one the file routes to), then to the value named below. A call that states one wins. A `.mx` file has no dialect, so it gets the defaults below. See [How strict your files are](/custom-tags/dialects/#writing-a-dialect-how-strict-your-files-are-structural-imports-unknowntags).
- **`structural`**: `"pass"` keeps text, `${}`, `<if>`, `<for>`, `<const>` and `import`/`export`/`static` in the IR. `"reject"` makes each one a positioned error, so a dialect that reads only tags and attributes cannot silently ignore an `<if>`. Comments are never structural: a `//` line or `<!-- -->` stays in the IR under either value.
- **`imports`**: `"pass"` or `"reject"`, defaulting to the effective `structural`. `"pass"` under `structural: "reject"` lets top-level `import` declarations through while `<if>`, `export` and the rest stay errors; they arrive in `ir.imports`. A tag-body `import` is body text, not an import, so `imports` does not apply to it.
- **`unknownTags`**: `"allow"` accepts a tag with no contract (the open set). `"reject"` makes it an error naming the tag, with a nearest-name hint, for a dialect that declares every tag. [Closing the vocabulary](/custom-tags/contract-packages/#contract-packages-closing-the-vocabulary) has an example.
- **`stripTypes`**: `true` (the default) erases TypeScript from the nodes before the source lowers: an arrow's parameter and return annotations are gone from its `node`, and a top-level `as`, `!`, `satisfies`, `<T>x` or `x<T>` is replaced by its operand (its `node`, `span` and `code` are the operand's, so `(y as string)` lowers as `y`). `Expr.code` is sliced from the source either way, so annotations inside an expression stay in it. `false` keeps the authored TypeScript in the nodes (`TSTypeAnnotation`, `TSAsExpression`, …), for a dialect whose `nodeType.lower`, contract hooks or `afterLower` read types. With `false`, an assertion stays around the value, so an attribute whose value is an assertion over a literal (`a=("s" as const)`) is `dynamic` with shape `other` rather than `static`, `boolean`, `object`, `array` or `string`, and a contract's `type: "expression"` check follows that kind (`a=("s" as const)` is refused by default and accepted with `false`). Every other check of core looks through TypeScript assertions (`as`, `satisfies`, `!`, `<T>x`, `x<T>`) and gives the default's diagnostics, positions included: the bound-attribute check (`v:=(y as any)`) and a contract's `string`, `number`, `boolean`, `enum`, `literalOnly`, `array`, `items`, `function` and `member` checks. An attribute's `span` ends where its written value ends either way (for `a=(1 as number)`, after the `)`), and a dynamic attribute's `valueSpan` is that written value, wrapper included, so by default a wrapped value is `valueSpan` differing from `value.span` (`1`), and with `false` the two differ only by the parentheses. `ctx.lower` in a tag-file hook takes the option but does not inherit the outer call's value.
- **`partial`**: opt into partial recovery as described above. The default returns no IR on error.
- **`warnings`**: a sink for core's warnings, pushed as they are raised, so those raised before a later error stay in the caller's array.

## Tag rules presets

A preset decides which tag names have a parse rule of their own. With no `tagRules`, a file parses under `html`, the full HTML rules: a dialect that states nothing gets strict rules and turns off what it does not want. `none` is what a dialect whose tags are not HTML passes; Mesh does.

| Preset | Native elements | Language tags |
|---|---|---|
| `none` | none | the module statements (`import`, `static`, `export`), plus `<const>` and `<return>` as open-tag-only |
| `markup` | the web elements, with their HTML parse rules | core's statement tags (`import`, `static`, `export`, `client`, `server`, `class`), plus `<const>` and `<return>` as open-tag-only; what the JSX, Solid, Astro and Angular hosts register |
| `html` | the web elements, with their HTML parse rules | every entry of core's taglib (`if`, `for`, `script`, `let`, the statement tags, …): the html target's table |

`tagRulesPreset(name, nativeTags?)` returns a preset's `TagRules` (the tag-table entries and the native elements it parses under), and `TAG_RULES_PRESETS` lists the three names, `["html", "markup", "none"]`.

Under `none`, Marko's 19 HTML parse rules are off: void (`area base br col embed hr img input link meta param source track wbr`), raw text bodies (`script style textarea title`) and preserved whitespace (`pre`). A tag named `source`, `input`, `title`, `script` or `pre` parses like any other tag and may have child tags, and host-owned names (`id`, `log`, `debug`, `class`) are ordinary tags. The cost: a tag-like `<name` inside a `script`, `style`, `textarea` or `title` body parses as a tag, not text. This is the one place a `none` file is not a Marko file: Marko rejects `<source><input/></source>`, `none` accepts it. All of this is intended, not a gap: under `none` a tag is not an HTML tag, so `<img>` has a body, `<script>` and `<style>` bodies parse as tags, and the html-comment tag and a regexp attribute parse as the grammar says, by design. The IR conformance test pins these cases as intended behaviour.

`<const>` and `<return>` take no body under any preset, so a `<const/y=1>` that is not self-closed never swallows what follows, and a child written inside one is an error rather than silently dropped.

## What is rejected

Always rejected, each with a positioned message: `<define>` and calls to it, `<return>`, tag variables (`/v`), dynamic tags (`<${x}>`), calls to a tag that has a template (an imported component, or a `customTags` entry with a template), `<!doctype>`, CDATA and XML declarations.

No dialect tag may be named `if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static` or `try`: core consumes those names first.

The messages say "data file" (``Data files are static, so they do not evaluate `<if>` ``). A dialect states its own noun, singular and plural, with `messageVocabulary.file`; see [Your own words in core's messages](/custom-tags/dialects/).

## Dialects

A **dialect** is a package that declares itself in its `package.json#mx.dialect`: its id, its name, the file extensions it claims and the module that carries its syntax table and hooks. `lowerSource` routes a file to the dialect that claims its extension, or takes one through the `dialect` option; contracts and the tag rules preset are still options (specification §13.9.2).

The tools treat a dialect's files as check-only:

- **`mx-tsc`, the language server and the TypeScript plugin check them.** (Not released yet: `mx-tsc` (`@mxlang/tsc`), the language server and the TypeScript plugin are not published.) A file goes to the dialect that claims its extension (`mx.extensions` can route more), and the tools run `lowerSource` on it under the dialect's own syntax and tag rules (a dialect with `tagRules: "none"` has no void elements, for one) and its own `structural`, `imports` and `unknownTags`: the tools pass none of those options, so a dialect that rejects an `<if>` or an unknown tag in its own compiler does so in the editor too. The dialect's own `contracts` apply, and so do the project's contracts (`mx.contracts`, unless the dialect's manifest sets `mxConfigTags: false`) and local tag files, as they do to an MX file (`tags/`, or the directories the dialect names in `tagDirs`: see [Tag files](/custom-tags/dialects/#writing-a-dialect-tag-files-a-directory-of-definitions)), and a dialect declared in a package below the project's root counts for the files in that package. Its diagnostics are reported with `source` set to the dialect's `name` (`mxlang` when two dialects claim its extension and routing cannot settle which) and `code` set to the dialect's own code. `mx-tsc` prints the code where `tsc` prints `TS<number>`: `page.probe(1,4): error PROBE_BAD: bad probe`. No JavaScript is generated for these files, and no target is involved.
- **Building a file calls its dialect's emit.** Core is dialect zero: its emit is the compile MX's own files get (`.mx`, `.<host>.mx`), run under the target the tool builds for. `emitFor(filename, { hostSegments })` answers `{ dialect, emit }` for a file, and the Vite plugin and the `@mxlang/target-html/bun` loader build through it, and neither picks a target for a dialect. A tool passes in what it needs the emit to say (its name in the "not wired" message of a target that cannot compile yet) and the `@mxlang/core` it runs under.
- **A dialect that registers no emit is refused.** Vite fails the import with an error at the import, the specifier in the importing file (at the head of the dialect file when it is an entry or a hand-built id): `<dialect name> files cannot be imported: the dialect registers no emit`. The text is the same whether or not the file checks clean. The Bun loader refuses the same file at its path, `<dialect name> files cannot be imported: the dialect registers no emit` at line 1, column 0. A dialect's emit is the dialect's own business: no tool picks a target for its files.
- **`mx.target: "tree"`** in a `package.json` is the ordinary unknown-target error (the valid targets are listed in it) in every tool.
- A dialect's own CLI or test suite calls `lowerSource` with its options and prints the diagnostics.
