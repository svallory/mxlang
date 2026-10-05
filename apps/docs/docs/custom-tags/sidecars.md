---
title: "Sidecars"
description: "Add validation, parse options, IR transforms, and file-wide collection with x.tag.ts."
---

# Sidecars

An L2 sidecar is `x.tag.ts`, usually in `tags/`, whose default export satisfies `CustomTag`. Use one when a template alone cannot validate or compute what the tag needs. Sidecars execute at compile time and return ordinary host-independent IR.

The examples here are copied from passing custom-tag fixtures and core tests.

## Declare the call contract

The core checks `attributes`, `attributeTags`, `children` and `parents` before any hook runs. The fixture `<icon>` declares all five attribute controls:

```ts
const icon: CustomTag = {
  attributes: {
    name: {
      type: "string",
      required: true,
      literalOnly: true,
      enum: Object.keys(PATHS),
    },
    size: { type: "number", literalOnly: true, default: 24 },
    class: { type: "string" },
  },
  transform,
};
```

An attribute declaration supports:

- `type`: `"string"`, `"number"`, `"boolean"`, `"expression"`, `"array"`, `"function"` or `"atom"`. `array` accepts a literal array and `function` accepts an arrow function, a function expression or the method shorthand (a function expression and the method shorthand reach the contract only on a host that resolves attribute methods, `resolveAttributeMethod`; any other host rejects them before the contract runs); a literal of another type is an error, while an identifier, call, member or conditional is accepted because its type is unknowable.
- `items`: with `type: "array"`, the literal element type (`"string"`, `"number"` or `"boolean"`). A non-literal element passes. `items` without `type: "array"`, and `enum` with `array` or `function`, are registration errors.
- `required`: reject a call that omits the attribute.
- `enum`: accept only one of the listed string literals.
- `default`: append a string, number, or boolean value when the call omits it.
- `literalOnly`: reject values that cannot be read at compile time. Literal arrays and objects are accepted as well as scalar literals.
- `values`, `pattern`, `ref`: with `type: "atom"` only (see [Atoms in contracts](#sidecars-declare-the-call-contract-atoms-in-contracts)); on any other type they are registration errors.

Declaring `attributes` makes a closed contract: undeclared attributes and spreads are errors. Omitting `attributes` leaves attributes open.

`attributeTags` is a map from the name after `@` to `{ required?, repeatable?, attributes?, attributeTags?, children? }`. Once present, it is closed: undeclared names are errors, required names must occur on every path, and a name repeats only when `repeatable: true`.

### Atoms in contracts

Decision 156 (ADR 156 section 4). `type: "atom"` accepts an atom (`mode=:strict`, the `:name` sugar) or a literal list of atoms (`accept=[:title, :body]`):

```ts
accept: { type: "atom", ref: "attribute" },            // must name a declared attribute
load:   { type: "atom", ref: ["relationship", "computed"] }, // one of several kinds
types:  { type: "atom", values: ["create", "read", "update", "destroy"] },
slug:   { type: "atom", pattern: "^[a-z]+$" },          // regex source; with or without values
any:    { type: "atom" },                               // any atom
```

An explicit atom where the contract says `string` (or any other non-atom type), and a string where it says `atom`, are type errors (``attribute `x` must be string, got atom``), positioned at the value (the atom, the string, the expression; a list item at the item). The same holds for attributes of an attribute tag at any depth, with the owner `` `<box>`: `<@row>`: `` in front, and `values`, `pattern` and `ref` are checked there too. The one exception is the name sugar (decision 156 addendum 6): `<field :email/>` sets `name`, which satisfies a `string` or `enum` contract as its string and an `atom` contract as the atom; `name="email"` against an atom-typed `name` is still an error. A name outside `values`, failing `pattern`, or not declared as a `ref` kind is a positioned error on the atom that lists the candidates (``is not one of :a, :b`` for `values`, ``is not a declared attribute here (one of :id, :title)`` for `ref`, ``(none declared)`` when there are none), sorted, at most ten and then `+N more`, with a did-you-mean when one candidate is clearly nearest. A type error against a contract with `values` lists them too (``must be atom, got string (one of :a, :b)``); against a `ref` it names the kinds (``(a declared attribute or action)``), because the declarations are collected after the call is checked. Editors do not complete atoms yet; `atomCandidates(facts, derived, offset)` in `@mxlang/core` answers "what can be written here" for a tool that wants to (`CompileResult.atomFacts`, or `TranslateError.atomFacts` when the atom check failed, holds its input). Without a contract an atom is never an error. `ref` checks the one file: a name it cannot find is an error, so an attribute that refers across files is simply not typed with `ref`.

A tag states what it declares with `declares`, one entry or an array:

```ts
string: {
  attributes: { name: { type: "atom" } },
  declares: [
    { kind: "attribute", from: "name", under: "attributes" },
    { kind: "argument", from: "name", under: "arguments",
      scope: ["create", "read", "update", "destroy", "action"] },
  ],
},
```

- `from`: `"name"` (the `name` attribute, including `:name`) or `"id"` (the `#id` sugar).
- `under`: the parent tag name, or a list; an entry without `under` applies under any parent, and the entry whose `under` names the parent wins.
- `scope`: a tag name or list; the declaration belongs to the nearest ancestor with one of those names (default: the file, decision 156 addendum 7: every reference in the file sees it, the outermost link of every resolution chain; a `ctx.declare` whose span is inside no call also lands there). No such ancestor is an error: ``` `x` declares an `argument` scoped to `update` or `action`, but has no such ancestor ```.
- `uniqueWith`: kinds that also clash with this name in the scope.

A reference resolves against every enclosing scope, innermost first; no tag "opens a context". Declarations are collected before references are checked, so source order does not matter, and a name `analyze` adds with `ctx.declare(kind, name, { span, scope })` is visible to every reference (`span` anchors the scope: the tag whose span holds it). Two declarations of one name and kind in one scope are an error positioned at the second and carrying both spans (`TranslateError.spans`). A kind is a plain name, so contract modules that use the same kind name share one namespace.

### Declare an attribute tag's own contract

Use the same vocabulary recursively (decision 138 E4):

```ts
const card: CustomTag = {
  attributeTags: {
    group: {
      children: {},
      attributeTags: {
        row: {
          repeatable: true,
          attributes: { n: { type: "number", required: true } },
          children: { item: { required: true, repeatable: true } },
        },
      },
    },
  },
};
```

This accepts `<card><@group><@row n=1><item/></@row></@group></card>` on a target that delegates `card`. Attributes use all the controls above, including `array`, `function` and `items`; **defaults on attribute-tag attributes are not applied**. Children use the same authored-body check, `#text` and transparent `<if>` / `<for>` paths described below. Attribute tags are not plain children. For a plain child's `parents` list, the attribute-tag parent is still spelled `"@row"`.

Each present map is closed; an omitted map on an extended declaration is open. Omitting `attributeTags` accepts nested tags with attributes and further nesting recursively, such as `<@row><@x a=1><@y b=2/></@x></@row>` when `row` declares `attributes: {}` or `children: {}`. An attribute-tag declaration with none of these three maps keeps the no-template rejection of attributes, nested attribute tags and controlled occurrences. Template `Input` checks and host capability gates still apply. Errors stop at the first in check order, not source order: authored children are checked before attributes, with attribute-tag bodies visited depth first. An error in a nested child can precede an invalid attribute written earlier on its enclosing tag. Errors name every owner, for example `` `<card>`: `<@group>`: `<@row>`: unknown attribute `bogus` ``; registration checks declaration keys and E1 contradictions at every depth, even if unused.

### Restrict authored children

`children` uses the same `{ required?, repeatable? }` cardinality shape. Once present, only listed plain child names are allowed; omitting it keeps children open.

```ts
const resource: CustomTag = {
  children: {
    item: { required: true, repeatable: true },
    "#text": { repeatable: true },
  },
  transform(call) {
    return call.content?.children ?? [];
  },
};
```

The reserved contract-vocabulary key `"#text"` permits non-whitespace text and `${…}` / `$!{…}`. Each text node or interpolation counts once; whitespace-only text never counts. Comments, `<const>` and `<define>` declarations are ignored, while a `<define>` call counts by its written name.

`<if>`, `<else-if>`, `<else if>` / `<else>` and `<for>` are transparent. A required child must appear on every branch, including the implicit empty branch when there is no final `<else>`. A child inside `<for>` needs `repeatable: true` and cannot alone satisfy `required`, because a loop may run zero times. Ordinary child tags count by their written names without inspecting their bodies, even if their transforms output different tags.

Dynamic children (`<${input.tag}/>`), unlisted names, disallowed text, repetitions and missing required children produce positioned errors; compilation stops at the first. The rule runs before children lower and applies equally to transform tags, template tags with declaration-only sidecars and contract-only tags on a target that delegates their names. `children` cannot be combined with `parseOptions.text: true` or `parseOptions.openTagOnly: true`.

### Name the unnamed tag: `defaultTag`

`defaultTag` sits beside `children` and says what `<#id>` and `<.class>`, written
with no tag name directly inside this tag, stand for ([the unnamed tag](/specification/#the-mx-language-4-elements-and-attributes-the-unnamed-tag), decision 145). It is the first rung of the ladder: it beats `package.json#mx.<target>.defaultTag`, the host and the target's built-in. A sidecar declares it like `children`, and `mx.contracts` modules take the same key:

```ts
// tags/my-list.tag.ts
export default {
  defaultTag: "li",
  transform: (call) => call.content?.children ?? [],
} satisfies CustomTag;
```

With that sidecar on the html target, `<my-list><.a>one</><#b>two</></my-list>` renders `<li class="a">one</li><li id="b">two</li>`. Nothing else changes: after the name is resolved the tag is ordinary, so a closed `children` of `my-list` must list `li` (otherwise the usual unlisted-child error is positioned at the shorthand), and a closed `attributes` on a tag that lacks `class` rejects `<.x>`.

The key works on attribute-tag declarations at any depth. An unnamed tag directly inside `<@head>` reads `head`'s own declaration:

```ts
// tags/panel.tag.ts
export default {
  attributeTags: { head: { defaultTag: "header" } },
  transform: (call) => call.attributeTags.flatMap((t) => t.block?.children ?? []),
} satisfies CustomTag;
```

`<panel><@head><.t>title</></@head></panel>` renders `<header class="t">title</header>`. Three rules decide which declaration answers:

- The parent is the nearest *authored tag*. Control flow between the two is skipped, so `<my-list><if=ok><.a/></if></my-list>` still reads `my-list`.
- A parent that declares no `defaultTag` answers "none"; the question does not climb to the grandparent, and the next rung of the ladder decides.
- Each declaration speaks only for its own direct children: `body` does not borrow the `defaultTag` of an attribute tag nested inside it.

The same contract on the data target (Mesh's `attributes` and `attribute`):

```ts
// contracts.ts, named by "mx": { "target": "data", "contracts": "./contracts.ts" }
export default {
  attributes: {
    defaultTag: "attribute",
    children: { attribute: { repeatable: true } },
  },
  attribute: { attributes: { id: {}, type: {} } },
};
```

`<attributes><#title type="string"/></attributes>` is then a tag named `attribute` with the attributes `type="string"` and `id="title"` in the tree, and `mx-tsc` reports nothing.

**The value is checked at registration.** It must be a non-empty string naming a tag the target knows or a custom tag of the package, and the tag must parse as a plain tag (not void, text, statement, control-flow or whitespace-preserving). One error per bad declaration, positioned at the file that writes it (the sidecar or the contracts module), at 1:0, naming the owner chain for an attribute-tag declaration:

```text
contracts.ts(1,1): error TS80003: invalid `defaultTag` value: `<nope>` is not a tag reachable from this package (contract of `<attributes>`)
```

A rejected value is skipped when the file compiles, so the next rung answers. If that answer is then not in the parent's closed `children`, the use-site error carries a hint: ``…allowed children: `<attribute>` (the parent's `defaultTag` `nope` is invalid; see the declaration)``. The full list of reasons is in the [specification](/specification/#the-mx-language-4-elements-and-attributes-the-unnamed-tag).

**The permit flag.** A target whose declarations set `allowContractDefaultTag: false` does not allow per-tag default tags at all (the built-in targets all allow them). On such a target every `defaultTag` in a contract is a registration error, not a silent no-op, and the compile ignores the contract rung:

```text
`defaultTag` in the contract of `<my-list>` is not allowed: host `fake-forbid-host` does not permit per-tag default tags
```

(`host` is `target` when the target has no host part; the name is the one from the descriptor.) The flag is documented for [target authors](/targets/third-party-targets/#third-party-targets-what-the-package-exports-the-unnamed-tag).

### Restrict direct parents

Use `parents` when a tag must appear only in particular containers. A parent's `children` list alone does not restrict where its children may appear elsewhere.

```ts
const attribute: CustomTag = {
  parents: ["attributes"],
  transform(call) {
    return call.content?.children ?? [];
  },
};
```

`<if>`, `<else-if>`, `<else if>` / `<else>` and `<for>` are transparent; any other authored tag breaks the chain. Thus `<attributes><div><attribute/></div></attributes>` is rejected: the direct parent is `div`. Inside `<@row>`, use `parents: ["@row"]`, not the name of the tag receiving that prop. `<define>` is not transparent: a tag in a `<define>` body has parent `define`. A dynamic parent reads `<${…}>` in diagnostics and never matches a `parents` list, even one spelling that diagnostic placeholder.

The reserved contract-vocabulary key `"#root"` permits the top level of a file or of a template's own unit. A recursive call at its template's top level also has parent `#root`. You can combine it with named parents. Omitting `parents` keeps placement open; `parents: []` permits none.

Registration checks both directions for registered tags: it rejects `P.children` listing `C` when `C.parents` omits `P`, and `C.parents` naming `P` when `P.children` is closed and omits `C`. The same check covers attribute-tag parents at every depth: `C.parents: ["@row"]` requires every declared `row` with closed `children` to list `C`; a `row.children` listing `C` requires `"@row"` in `C.parents` if declared. An open or compatible `row` elsewhere does not exempt a conflicting declaration. Attribute-tag diagnostics include the complete owner chain. An omitted contract stays open; `#root` is not a tag. Both messages end with the fix: add the missing entry to one list, or remove the conflicting entry from the other. Placement errors point at the offending tag and name the expected and actual parent, for example: `` `<attribute>` must be inside `<attributes>`; found inside `<div>` ``. The same checks apply to transform, template-sidecar and contract-only tags, including data targets; compilation stops at the first error.

## Change how the caller parses

`parseOptions` must be static because MX needs it before parsing the file that calls the tag:

- `text`: deliver the body as one unparsed text node.
- `preserveWhitespace`: retain body whitespace instead of applying normal MX whitespace rules.
- `openTagOnly`: allow only the open form; a closing tag/body is a parse error.

The passing `<markdown>` test uses text mode so `<` inside the body is data:

```ts
const markdown: CustomTag = {
  parseOptions: { text: true },
  transform(call) {
    content = call.content?.children ?? [];
    return content;
  },
};
```

```mx
<markdown># title
1 < 2 && 3 > 2</markdown>
```

Discovery reads `parseOptions` without executing the module. Keep the default export as an object literal, or as one module-scope identifier bound to an object literal, and keep all three option values literal booleans.

## Transform one call

`transform(call, ctx)` receives a `TagCall`:

| Field | Value |
| --- | --- |
| `name` | The called tag name. |
| `loc` | The call-site position and the default position for synthetic nodes. |
| `attrs` | Resolved attributes in source order, including declared defaults. |
| `content` | The ordinary body as a `Block`, or `null` for no body. |
| `childTree` | Optional authored-child metadata, also available to `analyze`: `ChildTag` (name), `ChildText`, `ChildDynamic`, `ChildFor` (nodes), and `ChildIf` (branches with `unconditional` and `nodes`); every node has `loc`. Not emitted IR. |
| `attributeTags` | Resolved `<@name>` blocks; repeats stay as separate entries. |
| `params` | Tag params as source text. |
| `var` | The `/var` binding as source text, or `null`. |

Build results through `ctx.build`; do not construct IR objects by hand. Its methods are `text`, `interpolation`, `element`, `attr`, `dynamicAttr`, `booleanAttr`, `expr`, `ifChain`, `forLoop`, `block`, `delegatedTag`, and `template`. Every synthetic node receives the appropriate position automatically.

The fixture's transform validates the one shape its declaration cannot express, obtains a hygienic row name, and builds a real IR loop:

```ts
const row = ctx.gensym("row");

const body = ctx.build.element(
  "tbody",
  [],
  [
    ctx.build.forLoop({
      source: { kind: "of", list: rows },
      params: [row],
      children: [
        ctx.build.element(
          "tr",
          [],
          columns.map((column) =>
            ctx.build.element(
              "td",
              [],
              [ctx.build.interpolation(ctx.build.expr(`${row}.${column}`))],
            ),
          ),
        ),
      ],
    }),
  ],
);
```

Use `ctx.gensym(hint?)` for any binding the expansion introduces. It returns a per-file unique name that no template can see.

Use this exact failure form:

```ts
if (name?.kind !== "static") throw ctx.fail("requires a static `name`");
```

The explicit `throw` matters: TypeScript does not reliably narrow after a bare call through the parameter property `ctx.fail`, even though it returns `never`. Pass an author position as the second argument when the error belongs to a particular attribute or block.

`ctx.hoist(code)` lifts a statement to the head of the enclosing function. It does not expose module-level IR builders.

## Request a host primitive

`ctx.build.delegatedTag(name, children, attributeTags)` is the only way a custom tag can request a primitive supplied by the active host. The core then asks that host to resolve it.

**A custom tag may request a primitive by name; only a host may define one.** The custom tag still cannot inspect which host is compiling. If the active host does not claim that primitive, compilation fails in that host's terms.

`<try>` dogfoods this boundary. It is a core-owned custom tag that validates its portable shape and requests the `try` primitive; each host only implements how that primitive renders. The name `try` cannot be shadowed by project configuration or a tag file.

## Analyze and finalize a whole file

Most tags need only `transform`. Add `analyze` and `finalize` when output depends on the set of calls in one file, such as a sprite sheet.

The passing sprite fixture collects distinct icon names in the tag's private store:

```ts
analyze(calls, ctx) {
  const used = ctx.store.get<Set<string>>(USED) ?? new Set<string>();
  for (const call of calls) {
    const name = staticName(call);
    if (name) used.add(name);
  }
  ctx.store.set(USED, used);
},
```

Each `transform` emits a small `<use>`, and `finalize` prepends one hidden sheet with sorted symbols:

```ts
finalize(ctx: FinalizeContext): IrNode[] {
  const used = ctx.store.get<Set<string>>(USED);
  if (!used || used.size === 0) return [];
  const symbols = [...used].sort().map((name) =>
    ctx.build.element(
      "symbol",
      [
        ctx.build.attr("id", `icon-${name}`),
        ctx.build.attr("viewBox", "0 0 24 24"),
        ctx.build.attr("fill", "none"),
        ctx.build.attr("stroke", "currentColor"),
        ctx.build.attr("stroke-width", "2"),
      ],
      (PATHS[name] ?? []).map((d) =>
        ctx.build.element("path", [ctx.build.attr("d", d)]),
      ),
    ),
  );
  return [
    ctx.build.element(
      "svg",
      [
        ctx.build.attr("xmlns", "http://www.w3.org/2000/svg"),
        ctx.build.attr("aria-hidden", "true"),
      ],
      symbols,
    ),
  ];
},
```

`ctx.store` is isolated per tag and per compiled file, but calls nested inside an L1 template participate in the caller's same store.

The deterministic phase order is:

1. All `analyze` hooks, sorted by tag name.
2. All expansions and `transform` hooks in source order, depth-first.
3. All `finalize` hooks, sorted by tag name; their returned nodes are prepended in that order.

Only tags actually called in the file are finalized. A definition with only `finalize` is rejected because it has no reachable call site or collection phase. A file that uses any `analyze` hook is lowered twice; files without one keep the single pass.

## Compose with a template

When `x.mx` and `x.tag.ts` coexist, a sidecar with no `transform` supplies declarations while the call routes to the template as usual. If the sidecar defines `transform`, it wins. Route the call to the template with the passing composition pattern:

```ts
transform(call, ctx) {
  return [ctx.build.element("aside", [], ctx.build.template(call))];
},
```

`ctx.build.template(call)` is available only when that tag has an `x.mx` template, and it is unavailable from `finalize`. It routes the call to that template's module rather than expanding it, so a `transform` may validate or rewrite the `TagCall` first — returning the `TagCall` itself does the same thing.
