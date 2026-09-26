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

`<for>` is itself the everyday example — its `|item, i|` are tag params on a native control tag. The same syntax is generic, not special-cased to `<for>`: it works on any tag, components included, which is what lets a JSX-shaped host, such as SolidMX, call a framework's own render-prop components (Solid's `<For>`, `<Show>`) using ordinary MX markup — `<Show|user| when=currentUser>...</Show>` lowers to `<Show when={currentUser}>{(user) => ...}</Show>`, which a JSX target supports directly. A string-emitting host like the HTML host does not currently support tag params on a component call — only on the native control tags (`<for>`, `<try>`) — since a plain string function has no natural place to put the resulting closure.

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

### Repeating the same name

Writing `<@name>` more than once on the same call is allowed (decision 104): a repeat is not last-wins — each host receives every occurrence.

Today's behavior, factually, per host: a single `<@name>` is its plain renderable value, and a repeated `<@name>` is an **array** of that value in source order, on HTML, Preact, React, Hono and Solid — so a callee can iterate them (`<for|it| of=input.item>`) the same way it would iterate any array. Angular rejects an attribute-tag-only dynamic-tag body outright (`ngComponentOutlet` has no content-projection mechanism). Astro rejects a *repeated* `<@name>` outright, since an Astro slot is keyed by name and its renderer would otherwise silently keep only one occurrence.

**This shape is being redesigned under decision 106** (upcoming): the consumer's `Input` type will declare the cardinality/shape it expects for a given attribute-tag name — a deliberate divergence from Marko's own runtime shape (an iterable record whose property read always hits the first occurrence), not an attempt to match it. This page will be updated once that decision lands.

A **custom tag** with its own declared `attributeTags` schema (a `.tag.ts` sidecar) can restrict repeats: unless its declaration marks the tag `repeatable`, a second `<@name>` is `` `<@name>` may not be repeated ``. This restriction is opt-in per custom tag, not a general rule — an ordinary component call (an `import`ed or `<define>`d one, with no declared schema) always allows a repeat.

## Collision rules

An attribute tag whose name is already taken — by an explicit attribute on the parent, or by the ordinary children (`children` itself) — is a parse error rather than a silent overwrite:

| Written | Error |
|---|---|
| `<@name attr=...>` | attribute tags take params or a body, not attributes |
| the same `<@name>` twice, on a **custom tag** whose declared schema doesn't mark it `repeatable` | attribute tag may not be repeated (see "Repeating the same name" above — an ordinary component call has no such restriction) |
| `<@name>` whose name is already an attribute on the parent | attribute tag collides with attribute of the same name |
| `<@children>` beside any ordinary child | attribute tag collides with the parent's ordinary children |
| `<@name>` at the top level, or inside another attribute tag's body | attribute tag outside a tag body / inside another attribute tag |
| `<@name>` inside `<if>` / `<else>` / `<for>` | attribute tag inside a control tag |

A spread attribute is not treated as a collision — `<Layout ...props><@id>x</@id></Layout>` is fine, since the collision check only knows the parent's explicitly written attribute names, not what a spread might contain at runtime. This matches how JSX treats `{...props} id="x"`.

`<try>` is the one control tag that *does* accept attribute tags — its two, `<@catch>` and `<@placeholder>` — because error and loading states are exactly a named prop each. See [Errors](/language/errors/) for what each one does and when they're rejected on a given host.
