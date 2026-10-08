---
title: "Atoms"
description: "`:name` as a value that represents itself: where atoms are allowed, the operations they refuse, the name sugar, and atom contracts."
---

# Atoms

`:name` in an expression position is an **atom**: a value that represents
itself. `mode=:strict` is the mode "strict" written as a reference rather than
as text, and its runtime value is the string `"strict"` on every target:

```mx
<div mode=:strict x=:rename-all/>
<p>${:draft}</p>
```

```html
<div mode="strict" x="rename-all"></div>
<p>draft</p>
```

At runtime an atom and a string are the same value: `:a === "a"` is `true`. The
distinction lives in the source, in the IR and in the contract checks, and ends
at lowering. That is deliberate, and it is what makes an atom usable everywhere
a string is: TypeScript's literal types check and complete it, a native
attribute accepts it (`<input type=:email>` renders `type="email"`), and every
target behaves identically because nothing host-specific is emitted.

**Without a contract, an atom is never an error.** It is its name. A vocabulary
opts in per attribute (`accept: { type: "atom", ref: "attribute" }`), and only
then does a name get checked, completed and go-to-able in an editor. See
[Atoms in contracts](#atoms-atoms-in-contracts).

Decision 156; the full reasoning is in [ADR 156](/design-notes/adr-atoms/).

## Where an atom is allowed

An atom is read everywhere MX reads an expression:

| Position | Example |
|---|---|
| attribute value | `mode=:strict`, `x= :b`, `x = :b` (all the same atom) |
| `${}` placeholder, anywhere (including raw-text bodies, tag names and shorthands) | `${:strict}`, `<${:kind}>` |
| tag arguments and default values | `<if=kind === :primary>`, `<const/x=:a/>` |
| attribute-tag value | `<@opt=:a/>` |
| method-shorthand body (an attribute value) | `boolean :isOverdue({ self }) { return self.status === :sent }` |
| inside any expression | `[:a, :b]`, `{ k: :a }`, `f(:a)`, `x === :a`, `` `${:a}` ``, `() => :a`, `{[:a]: 1}`, `o[:a]` |

An atom is **never** read in a TypeScript statement block — `<static>`,
`<import>`, `<export>` and scriptlets stay plain TypeScript — nor in tag params,
inside a string, in template-literal text, in a regular expression or in a
comment. `"s :a"` is text, `` `t :a` `` is text, `/:a/` is a regular expression.

A `:` only starts an atom **where an expression is expected**: at the start of a
value, or after an operator, a punctuator or a keyword. So `a ? b :c` stays a
ternary and `(x :number) => x` a type annotation; an atom's own `:` is never the
ternary's, so `a ? :b :c` is one value, `a ? "b" : c`. TypeScript's markers win
where they exist: a `?` written right after a word or `]` (`a? :T`), a postfix
`!` (`c ? a! :b`) and a type argument list's closing `>` (`c ? y as Array<T> :z`)
end an operand, whether or not a space comes before the `:`.

```mx
<div x=true ? :b : :c/>
```

```html
<div x="b"></div>
```

## Names

A name matches `[A-Za-z_$][\w$]*(-[\w$]+)*`: `:title`, `:rename-all`,
`:primary-key`. Dashes belong to the name, so `:a-b` is the atom `a-b` while
`:a - b` is subtraction, and a trailing `-` is not part of the name.

```mx
<div x=:rename-all y=:primary-key/>
```

```html
<div x="rename-all" y="primary-key"></div>
```

The name keeps its span in the IR, and `parseData` on the
[tree target](/targets/data/) reports an attribute whose whole value is one
atom as an `atom` attribute (the name sugar's `name` included), and an atom
nested in an expression as an atom node with its own span — so a tool can tell
`:title` from `"title"`. See [the IR spec](/architecture/ir-spec/).

## Atoms you cannot operate on

An atom is a name, not a value to work on, so member access, calls, unary
operators and spreading on it are errors, each positioned at the atom:

```text
<div x=:a.length/>
1:7 `:a` is an atom (decision 156), a name and not a value to operate on: member access is not allowed on it; write `"a"` for a string you mean to operate on
```

```text
<div x=:a(1)/>
1:7 `:a` is an atom (decision 156), a name and not a value to operate on: a call is not allowed on it; write `"a"` for a string you mean to operate on
```

```text
<div x=-:a/>
1:8 `:a` is an atom (decision 156), a name and not a value to operate on: the unary operator `-` is not allowed on it; write `"a"` for a string you mean to operate on
```

Spreading is refused too, in an attribute value and in a tag's own spread alike
(`f(...:a)`, `[...:a]`, `<div ...:a/>`), with the same wording and
`spreading` where the operation goes.

An atom in object-key position is refused as well; a computed key is the way to
use an atom there, so write `{[:a]: 1}` and not `{:a: 1}`:

```text
<div x={:a: 1}/>
1:8 `:a` cannot be an object key: an atom is a value (decision 156); write `a:` for the key, or `[:a]` to compute it from the atom
```

An atom where only a binding, an assignment target or a shorthand property can
stand (`:a = 1`, `(:a) => 1`, `{:a}`) is a positioned parse error naming it:

```text
<div x=(:a) => 1/>
1:8 `:a` is an atom (decision 156): a value, not a binding, an assignment target or a shorthand property
```

Comparison, array and object elements, template placeholders and function
arguments are all allowed: those are positions where an atom is a value.

## `::name` is reserved

`::a` is lexed as one token, and it is reserved for a future `Symbol.for("name")`
sugar:

```text
<div x=::a/>
1:7 `::a` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:a` for an atom
```

Because the check is on the token, `::` is reported in a tag or attribute name
and in a shorthand's static text too (`<b::a/>`, `<b ::a/>`, `<b.c::a/>`),
positioned at the `::`. It is never reported inside a `${}` of a tag name or
shorthand, where the text is an expression: `<${"a::b"}/>` is legal. Write
`:a` for an atom, `{k: :a}` for an object key.

## The name sugar is an atom standing alone in attribute position

`:email` in attribute position is not a value: it is the **name sugar**, the
same rule as `x=:a :b`. It sets `name`, and the `name` it sets keeps its
atom-ness in the IR and in `parseData`, so a contract that types `name` as an
atom checks it and `name="title"` is a type error there:

```mx
<input :email/>
<input type=:email/>
```

```html
<input name="email">
<input type="email">
```

The whole sugar, its positions and its duplicates are in
[Attributes](/language/attributes/#attributes-name-and-id-and-class-after-an-attribute). Two
things atoms add:

- **A sugar after a single-atom default value.** `belongs-to=:Customer :customer`
  is the tag's default value (the atom `:Customer`) plus `name` (the atom
  `:customer`), because an atom takes no member access or operator, so nothing
  else can follow it and the split is unambiguous (decision 146 addendum 5):

  ```mx
<belongs-to=:Customer :customer/>
  ```

  Every other default value keeps decision 151 ruling 2 — `belongs-to=a
  :customer` is still "` :customer` right after a default value is not
  supported".

- **The sugar against contracts.** A sugar-derived `name` satisfies a `string`
  or `enum` contract as its string *and* an `atom` contract as the atom (decision
  156 addendum 6), so `<field :email/>` is fine against `enum: ["email", "phone"]`
  and against `{ type: "atom" }`. An explicit `x=:a` against `string` stays an
  error.

## Known limits: a `:` TypeScript owns

Four spellings where TypeScript's `:` and an atom's `:` collide are pinned as
known limits, because settling them needs a type parser in the lexer. They are
listed, tested and diverged from on purpose.

1. `(a<b> :c)` with no open `?` takes TypeScript's reading — `a<b>` is type
   arguments — so `:c` is not an atom and the compile fails, as it did before
   atoms. The hint says why:

   ```text
   hint: `a<b> :c` reads `a<b>` as type arguments (TypeScript's reading), so `:c` is not an atom there; this spelling is ambiguous (ADR 156, known limits)
   ```

2. A spaced `c ? a < b > :z`, a conditional type inside inline-cast type
   arguments (`c ? y as Foo<A extends B ? C : D> :z`) and a `<` inside a string
   or comment within type arguments (`c ? y as Foo<"<"> :z`) lex `:z` as an atom
   where TypeScript owns the `:`. These three **break input that compiled before
   atoms**, and one space after the colon fixes all of them — which is also what
   Prettier prints:

   ```text
   hint: `:z` was read as an atom (decision 156), so the ternary has no `:`; if TypeScript owns that `:` (type arguments before it, ADR 156 known limits), write `: z` with a space
   ```

The four share one row in `divergences.md` and a case-table row, so a future
lexer change is a conscious one. See also the rows in
[the specification](/specification/#the-mx-language-4-elements-and-attributes).

## Atoms in contracts

A contract attribute can type an atom. The short form:

```ts
accept: { type: "atom", ref: "attribute" },             // must name a declared attribute
load:   { type: "atom", ref: ["relationship", "computed"] }, // one of several kinds
types:  { type: "atom", values: ["create", "read", "update", "destroy"] },
slug:   { type: "atom", pattern: "^[a-z]+$" },          // regex source
any:    { type: "atom" },                               // any atom
```

- An atom where the contract says `string`, and a string where it says `atom`,
  are type errors both ways (`` attribute `x` must be string, got atom ``),
  positioned at the value; the name sugar above is the one exception.
- A name outside `values` is a positioned error on the atom that lists the
  candidates and adds a did-you-mean when one is clearly nearest:
  `` `<box>`: attribute `mode`: `:strct` is not one of :strict, :loose; did you mean `:strict`? ``.
- A name that no declaration of the `ref` kind covers is an error with the kind in
  the wording, the names visible from that tag (sorted, ten at most, then
  `+N more`; `none declared` when there are none) and a did-you-mean:
  `` `<policy>`: attribute `load`: `:titel` is not a declared relationship or computed here (one of :author, :title); did you mean `:title`? ``.
  The list only holds names the attribute accepts: `pattern` filters it, and
  with `values` and `ref` together it is their intersection.
- A plain string where a `ref` atom is expected lists the same names and says what
  to write: `` attribute `load` must be atom, got string (one of :author, :title); write it as `:title` ``.

A tag states what it **declares** for references with `declares` (one entry or an
array), and a vocabulary's `analyze` hook adds derived names with
`ctx.declare`. Checking is two phases — every declaration is collected, then
every reference is checked — so order in the file does not matter. `from` is
`"id"` or `"name"`, `under` picks the entry by parent tag, `scope` names the
ancestor tag a declaration belongs to (default: the file) and `uniqueWith` names
the kinds it also clashes with. A reference resolves against the enclosing
scopes innermost first and last the file scope.

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

The full contract reference — every field, the resolution rules, duplicates,
`ctx.declare` and the kind namespace — is in
[Sidecars: Atoms in contracts](/custom-tags/sidecars/#sidecars-declare-the-call-contract-atoms-in-contracts).

### Mesh's `accept=[:title]`

Mesh is the first vocabulary built on atoms. It declares its fields and refers to
them by name:

```mx
<entity :invoice>
  <attributes>
    <uuid :id primary-key/>
    <string :title/>
    <string :body/>
  </attributes>
  <policy accept=[:title, :body]/>
</entity>
```

- `uuid :id primary-key` is the name sugar: `name="id"` plus a boolean
  attribute.
- `accept=[:title, :body]` is a list of atoms, each naming an **attribute** of the
  entity. With `accept` declared `{ type: "atom", ref: "attribute" }` and the type
  tags declaring the kind `attribute` from their `name`, the declarations sit in
  the sibling `<attributes>` section and the reference in `<policy>`; both are in
  the file scope, so the order in the file does not matter.
- `:titel` is a positioned error on the atom with `title` as the likely intent,
  and the editor completes `title` and `body`.
- With **no** contract on `accept`, `[:title, :body]` is `["title", "body"]` and
  nothing is checked.

`ref` checks the one file, so a reference across files is not typed with `ref`;
the vocabulary's own build step checks that.

## See also

- [Attributes](/language/attributes/) — the `#id`, `.class` and `:name` sugars.
- [Sidecars](/custom-tags/sidecars/#sidecars-declare-the-call-contract-atoms-in-contracts) — the atom contract reference.
- [Errors](/language/errors/#errors-atom-errors) — the diagnostics, listed by message.
- [ADR 156](/design-notes/adr-atoms/) — why this is the shape it is.
- [The specification](/specification/#the-mx-language-4-elements-and-attributes) — the normative text.
