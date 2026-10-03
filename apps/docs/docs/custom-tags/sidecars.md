---
title: "Sidecars"
description: "Add validation, parse options, IR transforms, and file-wide collection with x.tag.ts."
---

# Sidecars

An L2 sidecar is `x.tag.ts`, usually in `tags/`, whose default export satisfies `CustomTag`. Use one when a template alone cannot validate or compute what the tag needs. Sidecars execute at compile time and return ordinary host-independent IR.

The examples here are copied from passing custom-tag fixtures and core tests.

## Declare the call contract

The core checks `attributes`, `attributeTags` and `children` before any hook runs. The fixture `<icon>` declares all five attribute controls:

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

- `type`: `"string"`, `"number"`, `"boolean"`, `"expression"`, `"array"` or `"function"`. `array` accepts a literal array and `function` accepts an arrow function, a function expression or the method shorthand (a function expression and the method shorthand reach the contract only on a host that resolves attribute methods, `resolveAttributeMethod`; any other host rejects them before the contract runs); a literal of another type is an error, while an identifier, call, member or conditional is accepted because its type is unknowable.
- `items`: with `type: "array"`, the literal element type (`"string"`, `"number"` or `"boolean"`). A non-literal element passes. `items` without `type: "array"`, and `enum` with `array` or `function`, are registration errors.
- `required`: reject a call that omits the attribute.
- `enum`: accept only one of the listed string literals.
- `default`: append a string, number, or boolean value when the call omits it.
- `literalOnly`: reject values that cannot be read at compile time. Literal arrays and objects are accepted as well as scalar literals.

Declaring `attributes` makes a closed contract: undeclared attributes and spreads are errors. Omitting `attributes` leaves attributes open.

`attributeTags` is a map from the name after `@` to `{ required?, repeatable? }`. Once present, it is also closed: undeclared names are errors, required names must occur, and a name repeats only when `repeatable: true`.

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

```marko
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
