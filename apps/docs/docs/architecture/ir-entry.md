---
title: "Core IR entry point and dialects"
description: "lowerSource and lowerFile hand a program core's IR for a .mx file, with every diagnostic positioned, for a dialect that interprets the tree itself."
---

# Core IR entry point and dialects

`@mxlang/core` exports `lowerSource` and `lowerFile`: parse a `.mx` source, lower it, check it, and return **core's own IR** with every diagnostic positioned. Nothing is emitted and nothing is evaluated. A program that gives MX tags its own meaning (a **dialect**, such as Mesh's resource definitions, a config loader or a code generator) walks the IR and decides what each tag means.

This replaces the tree target (`@mxlang/data`, `parseData`, the `Data*` tree types), which decision 204 deleted. The IR is the tree: there is no second projection to keep in step with it. The normative description is [specification §13.7](/specification/#the-mx-language-13-host-semantics-table-137-the-core-ir-entry-point); the IR itself is in the [IR specification](/architecture/ir-spec/).

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
| `ir` | a `SpannedIr`, or `undefined` when `diagnostics` holds an error |
| `diagnostics` | `IrDiagnostic[]`: `{ severity, message, line, column, offset, file?, code? }`. On success it holds this call's warnings only |

`lowerSource` never throws for anything in the source. A parse error, a rejected construct and a failed contract are each an error diagnostic, and every independent error of the file is reported once, in position order. A bug in core that surfaces with no position is reported at `1:0` with an `internal error: ` prefix, so a caller never has to wrap the call.

`offset` is the UTF-16 offset of `line`/`column`, so a consumer needs no line table (`-1` when `file` names another file, whose text `lowerSource` does not have). `code` is set when the error carries a machine-readable code; today only a dialect's `ctx.fail(message, { code })` gives one.

### `SpannedIr`

The returned IR is core's `Ir` with the span guarantee in its type (`SpannedIr` is `Spanned<Ir>`; `Spanned<T>` is exported for a consumer that types one node, such as `Spanned<DelegatedTag>`): every `span` is required, at every depth. A `DelegatedTag` and an `AttributeTag` also carry their `nameSpan`, and a `DelegatedTag` always has `args` (`[]` when the tag has none). A static attribute always has its `valueSpan`, an atom's and a member's included (`e=""` spans its quotes; a bare colon name such as `x:foo`, whose value is `""`, has a zero-width one at the name's end), and an `Import` always has `from` and `names`. `bodySpan` and `paramSpans` stay optional. A node that should have a span or one of these fields and does not is an `internal error`, never a silent `undefined`.

Two more properties of the returned IR:

- **It is a fresh copy on every call.** Core's own IR is never handed out, so a consumer may mutate what it gets.
- **A tag's span ends at the tag.** In concise syntax core measures a tag through the end of its line; the entry point trims the trailing line terminator (`\n` or `\r\n`), so `source.slice(span.sourceStart, span.sourceEnd)` is `"b\n  c"` for a concise `b` with a child `c`, never `"b\n  c\n"`. A `<tag/>` span is unchanged.

`IR_VERSION` (from `@mxlang/core`) is the version of the IR's shape. A dialect asserts it to detect a core whose IR it was not written against; it goes up with every change a reader can observe. A test in core pins it with a hash of the IR's type declarations, so a change of shape cannot ship without a bump.

### What a dialect reads

| Construct | In the IR |
|---|---|
| A tag | `DelegatedTag`: `tag.name`, `tag.nameSpan`, `tag.span`, `tag.attrs`, `tag.args` (`<x(1, 2)>`), `tag.children`, `tag.attributeTags` (and `tag.attributeTagTree`, which keeps the `<if>`/`<for>` among them) |
| An attribute | `Attr`: `static` (a string literal, an atom, a shorthand `#id`/`.class`), `boolean` (`required`), `dynamic` (`n=1`, `values=[…]`, a method `change(x) { … }`), `bound` (`v:=x`), `spread` |
| An expression | `Expr`: `code` (the authored slice), `shape` (`"object"`, `"array"`, `"string"`, `"other"`), `span`, `node` (the Babel node), `atoms`; a method value also has `bodySpan` |
| Text, `${}`, comments | `Text`, `Interpolation`, `Comment` |
| `<if>`, `<for>`, `<const>` | `IfChain`, `For`, `Const` |
| `import` | `ir.imports`: each `Import` has `code`, `span`, `from` (the unquoted specifier) and `names` (`{ imported, local, kind, span, localSpan?, typeOnly? }`) |
| `export`, `static` | `ir.hoisted`: `Export` and `Static` nodes |
| A tag a dialect built | `DelegatedTag.tag.trigger`: `{ id, span, text }` |

Only a string literal is `static`; `n=1` and `required=true` are `dynamic`, because nothing is evaluated.

## The unnamed tag

`<#id>` and `<.class>` with no tag name resolve to the built-in `object` tag: the anonymous node, with an open contract, carrying `id` and `class` as ordinary attributes. It is always known, so it is never an unknown-tag error. A parent's contract can name another tag (`defaultTag: "attribute"` beside `children`), and the `defaultTag` option changes the answer everywhere no parent declares one. The ladder and the errors are in [The unnamed tag](/specification/#the-mx-language-4-elements-and-attributes-the-unnamed-tag).

## Wildcard children

A parent's `children["*"]` entry claims child names that no explicit entry, registered tag or built-in resolves (decision 147). The IR names the matched tag by its **contract**, and keeps the authored spelling beside it:

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
  structural: "reject", // "pass" (default) | "reject"
  imports: "pass", // optional; default: whatever `structural` is
  unknownTags: "reject", // "allow" (default) | "reject"
});
```

- **`customTags`** declares the vocabulary: required attributes, attribute types, allowed children and parents (decisions 130 and 138). `lowerSource` does not scan `tags/` or `package.json`; this map is all it knows. Contracts are enforced at every depth, `analyze` included. See [Writing a dialect package](/custom-tags/dialect-package/).
- **`dialect`** is the file's dialect, or a bare syntax table, for a consumer that builds its own (Mesh passes its dialect, hooks included). Omitted, the dialect that claims the file's extension applies (decision 212).
- **`tagRules`** picks the parse rules the source is read under ([below](#core-ir-entry-point-and-dialects-tag-rules-presets)). It is an option of this function only, never a project or host setting (ruling 209).
- **`defaultTag`** is what `<#id>` and `<.class>` stand for in place of `object`.
- **`structural`**: `"pass"` keeps text, `${}`, `<if>`, `<for>`, `<const>` and `import`/`export`/`static` in the IR. `"reject"` makes each one a positioned error, so a dialect that reads only tags and attributes cannot silently ignore an `<if>`. Comments are never structural: a `//` line or `<!-- -->` stays in the IR under either value (decision 131 addendum 5).
- **`imports`**: `"pass"` or `"reject"`, defaulting to the effective `structural`. `"pass"` under `structural: "reject"` lets top-level `import` declarations through while `<if>`, `export` and the rest stay errors; they arrive in `ir.imports`. A tag-body `import` is body text, not an import, so `imports` does not apply to it.
- **`unknownTags`**: `"allow"` accepts a tag with no contract (the open set of decision 131). `"reject"` makes it an error naming the tag, with a nearest-name hint, for a dialect that declares every tag. [Closing the vocabulary](/custom-tags/dialect-package/#writing-a-dialect-package-closing-the-vocabulary) has an example.
- **`warnings`**: a sink for core's warnings, pushed as they are raised, so those raised before a later error stay in the caller's array.

## Tag rules presets

A preset decides which tag names have a parse rule of their own. With no `tagRules`, a file parses under `html`, the full HTML rules (decision 212 item 8): a dialect that states nothing gets strict rules and turns off what it does not want. `none` is what a dialect whose tags are not HTML passes; Mesh does.

| Preset | Native elements | Language tags |
|---|---|---|
| `none` | none | the module statements (`import`, `static`, `export`), plus `<const>` and `<return>` as open-tag-only |
| `markup` | the web elements, with their HTML parse rules | core's statement tags (`import`, `static`, `export`, `client`, `server`, `class`), plus `<const>` and `<return>` as open-tag-only; what the JSX, Solid, Astro and Angular hosts register |
| `html` | the web elements, with their HTML parse rules | every entry of core's taglib (`if`, `for`, `script`, `let`, the statement tags, …): the html target's table |

`tagRulesPreset(name, nativeTags?)` returns a preset's `TagRules` (the tag-table entries and the native elements it parses under), and `TAG_RULES_PRESETS` lists the three names, `["html", "markup", "none"]`.

Under `none`, Marko's 19 HTML parse rules are off: void (`area base br col embed hr img input link meta param source track wbr`), raw text bodies (`script style textarea title`) and preserved whitespace (`pre`). A tag named `source`, `input`, `title`, `script` or `pre` parses like any other tag and may have child tags, and host-owned names (`id`, `log`, `debug`, `class`) are ordinary tags. The cost: a tag-like `<name` inside a `script`, `style`, `textarea` or `title` body parses as a tag, not text. This is the one place a `none` file is not a Marko file: Marko rejects `<source><input/></source>`, `none` accepts it.

`<const>` and `<return>` take no body under any preset, so a `<const/y=1>` that is not self-closed never swallows what follows, and a child written inside one is an error rather than silently dropped.

## What is rejected

Always rejected, each with a positioned message: `<define>` and calls to it, `<return>`, tag variables (`/v`), dynamic tags (`<${x}>`), calls to a tag that has a template (an imported component, or a `customTags` entry with a template), `<!doctype>`, CDATA and XML declarations.

No dialect tag may be named `if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static` or `try`: core consumes those names first.

The messages still say "data tree" (``the data tree is static; this file's consumer does not evaluate `<if>` ``). They are kept byte for byte from `parseData`, so a dialect that matched them keeps working; a wording change waits for the dialect API.

## Dialects

A **dialect** is a package that declares itself in its `package.json#mx.dialect`: its id, its name, the file extensions it claims and the module that carries its syntax table and hooks. `lowerSource` routes a file to the dialect that claims its extension, or takes one through the `dialect` option; contracts and the tag rules preset are still options (specification §13.9.2).

The tools treat a dialect's files as check-only:

- **`mx-tsc`, the language server and the TypeScript plugin check them.** A file goes to the dialect that claims its extension (`mx.extensions` can route more), and the tools run `lowerSource` on it under the dialect's own syntax and tag rules (a dialect with `tagRules: "none"` has no void elements, for one). Its diagnostics are reported with `source` set to the dialect's `name` (`mxlang` for a file no dialect routes) and `code` set to the dialect's own code. `mx-tsc` prints the code where `tsc` prints `TS<number>`: `page.probe(1,4): error PROBE_BAD: bad probe`. No JavaScript is generated for these files, and no target is involved.
- **Vite refuses to import one.** Building a file calls its dialect's emit, and no dialect registers one, so the import fails with an error at the head of the dialect file: `<dialect name> files cannot be imported: the dialect registers no emit`. A dialect file that does not check clean reports its first error instead, at its own position. A dialect's emit is the dialect's own business: no tool picks a target for its files.
- **`mx.target: "tree"`** in a `package.json` is the ordinary unknown-target error (the valid targets are listed in it) in every tool.
- A dialect's own CLI or test suite calls `lowerSource` with its options and prints the diagnostics.
