---
title: "Attribute tags and tag params"
description: "How any tag can take a function child and named props via markup."
---

# Attribute tags and tag params

Two generic rules apply to *every* tag in MX — components and plain HTML elements alike. They are what let MX call a framework's own render-prop components (Solid's `<For>`, `<Show>`, and similar) using ordinary markup, instead of a special case per control tag.

## Tag params: `<Tag|params|>`

Writing parameters between pipes on a tag's opening turns its children into a function:

```html
<for|item, i| of=items>
  <li>${i}: ${item.name}</li>
</for>
```

`<for>` is itself the everyday example — its `|item, i|` are tag params on a native control tag. The same syntax is generic, not special-cased to `<for>`: it works on any tag, components included, which is what lets a JSX-shaped host, such as SolidMX, call a framework's own render-prop components (Solid's `<For>`, `<Show>`) using ordinary MX markup — `<Show|user| when=currentUser>...</Show>` lowers to `<Show when={currentUser}>{(user) => ...}</Show>`, which a JSX target supports directly. The html target supports tag params on a component call too, not only on the native control tags: `<Card|x|>${x}</Card>` against an imported component compiles to a local closure the same way `<for|item|>` does.

Params are parsed exactly like `<for>`'s own `|item, i|` — destructuring and type annotations included — and empty pipes (`||`) lower to a no-argument function.

## Attribute tags: `<@name>`

Inside any tag's body, a child written as `<@name>...</@name>` becomes a named prop on the parent instead of part of its ordinary children:

```html
<define/Card|content, header|>
  <div class="card">
    <div class="card-header">$!{header()}</div>
    <div class="card-body">$!{content()}</div>
  </div>
</define>

<Card>
  <@header>Account settings</@header>
  <p>Manage your preferences below.</p>
</Card>
```

This passes `header` as a separate prop from `content` — the ordinary children (`<p>...</p>`) become the parent's `children`/`content`. Add params the same way tag params work: `<@footer|year|>© ${year}</@footer>` becomes a prop that is itself a function of `year`.

Props are emitted in a fixed order: the parent tag's own attributes first, in source order, then its attribute-tag children, in source order.

### Declaring cardinality and shape

A component's exported `Input` declares each attribute-tag prop with the host's `AttrTag` type:

```ts
export interface Input {
  header?: AttrTag<{ as: "renderable" }>;
  item: AttrTag<{ attrs: { id: string } }>[];
}
```

An optional or required `AttrTag` is singular; `AttrTag[]` is an array. The default `data` shape is `{ ...attrs, ...nestedTags, content }`. `content` is the host's renderable, or a render function when the tag declares `params`. `as: "renderable"` passes the body itself (or that render function) and therefore cannot carry attributes or nested tags. The dedicated [AttrTag guide](/language/attr-tag/) covers every config field, exact cardinality errors, Input resolution, host value types, nested tags, and worked examples.

For an untyped, unresolved, or dynamic callee, MX infers a fallback (decision 108). A property is renderable when none of its occurrences anywhere in `<if>`/`<for>` control flow has attributes or nested attribute tags. If any occurrence has either, all occurrences use the data shape. Cardinality is still singular when at most one occurrence can be selected on a path, and an array for repeats or loops. A declared `Input` remains authoritative and still defaults to data.

### Repeating the same name

Writing `<@name>` more than once on the same call is allowed when the callee accepts an array: a repeat is not last-wins — each host receives every occurrence. A declared singular prop rejects a repeat; a declared array receives every occurrence in source order and receives `[]` when none is taken. The untyped fallback uses an array when a name repeats or appears inside `<for>`.

MX's declared arrays and data values deliberately differ from Marko's iterable attribute-tag record (decision 106). Body-only fallback values align with Marko again under decision 108, while repeated fallback values remain real arrays.

A **custom tag** with its own declared `attributeTags` schema (a `.tag.ts` sidecar) can restrict repeats: unless its declaration marks the tag `repeatable`, a second `<@name>` is `` `<@name>` may not be repeated ``. This restriction is opt-in per custom tag, not a general rule — an ordinary component call (an `import`ed or `<define>`d one, with no declared schema) always allows a repeat.

## Collision rules

An attribute tag whose name is already taken — by an explicit attribute on the parent, or by the ordinary children (`children` itself) — is a parse error rather than a silent overwrite:

| Written | Error |
|---|---|
| a singular `<@name>` twice | `` `<@name>` may appear at most once (`name` is declared `AttrTag`, not `AttrTag[]`) `` |
| a custom tag's non-repeatable `<@name>` twice | `` attribute tag `<@name>` may not be repeated `` |
| `<@name>` whose name is already an attribute on the parent | `` attribute tag `@name` collides with attribute `name` `` |
| `<@children>` beside ordinary children | `` attribute tag `@children` collides with the parent's ordinary children `` |
| authored `content=` on `<@name>` | `` `content` is reserved on an attribute tag; it names the body `` |
| attributes or nested tags on a declared `as: "renderable"` tag | `` `<@name>` is renderable in `<Owner>`; it can't take attributes or nested attribute tags `` |
| attribute tags mixed with ordinary content inside one control-flow body | `Cannot have attribute tags and body content under a control flow tag.` |

A spread attribute is not treated as a collision — `<Layout ...props><@id>x</@id></Layout>` is fine, since the collision check only knows the parent's explicitly written attribute names, not what a spread might contain at runtime. This matches how JSX treats `{...props} id="x"`.

`<try>` is the one control tag that *does* accept attribute tags — its two, `<@catch>` and `<@placeholder>` — because error and loading states are exactly a named prop each. See [Errors](/language/errors/) for what each one does and when they're rejected on a given host.
