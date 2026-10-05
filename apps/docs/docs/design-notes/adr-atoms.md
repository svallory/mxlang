---
title: "ADR 156: atoms"
description: "Why `:name` in an expression position is a value that represents itself, how it lexes, lowers and is checked by contracts, how the 146 name sugar is restated as an atom, and what was rejected."
---

# ADR 156: atoms

**Status:** draft (decision 156 in the decisions log; this ADR precedes the code, which waits for the lead to approve the parser approach). **Depends on:** ADR 145 (`defaultTag`), ADR 146 (`:name`). **Implementation:** not started.

## Context

ADR 146 gave `:name` a meaning in tag position: `<input:email>`, `<input :email>` and `<:email>` set `name="email"`. The same spelling reads naturally somewhere else too: as a value.

```mx
<action name="save" accept=["title", "body"]/>
```

reads as text that must happen to match some declared thing. Written `accept=[:title, :body]` it reads as a reference. Data vocabularies (Mesh's entity files are the first) are full of such references: field names, kinds, modes, flags. Strings carry them today, so a typo is just a different string and an editor cannot tell a name from a sentence.

Four ways to give the reference reading a spelling were weighed (see Alternatives). The shape adopted is the smallest: `:name` is an **atom**, a value that represents itself.

## Decision

### 1. Grammar

`:name` is an atom wherever MX reads an expression:

| position | example |
|---|---|
| attribute value | `mode=:strict` |
| placeholder | `${:strict}` |
| tag arguments | `<if(kind === :primary)>` |
| inside an array or object in any of the above | `accept=[:title, :body]` |

An atom is never read inside `static`, `import` or script blocks, which stay plain TypeScript, and never inside strings, template literals, regular expressions or comments. `"a :b"` is text, `/:b/` is a regex.

A name is identifier-like and may contain `-`: `:title`, `:rename-all`, `:primary-key`. The characters are the ones the 146 sugar token already accepts, so `:x` has one lexical rule wherever it appears.

`::name` is reserved. The lexer reads `::` as a single token, so a later `Symbol.for("name")` sugar needs no lookahead change and no existing program can be using it (see Open questions for what `::` does until then).

### 2. IR

A new node, `atom { name, span }`, distinct from `string`. It is not a string literal in the tree; it lowers to one (next section). `parseData` exposes it as an atom, so data consumers can tell `:title` from `"title"` and tools can offer completion and go-to on it.

### 3. Lowering

The runtime value of an atom is its name as a string literal, on every target: `mode=:strict` lowers to `"strict"`.

- TypeScript literal typing checks and completes it (`mode: "strict" | "loose"` accepts `:strict`, rejects `:stirct`).
- A native attribute accepts it (`<input type=:email>` renders `type="email"`).
- Nothing host-specific is emitted, so core stays host-agnostic and every host behaves identically.

**The wrinkle, stated openly:** at runtime `:a === "a"`. Atoms are names and strings are text, and they have the same representation. The distinction exists in the source, the IR and the contract checks, and it ends at lowering. Code that receives `"title"` cannot tell whether the author wrote `:title` or `"title"`, and cannot be made to.

### 4. Contracts

A contract attribute may be declared in two ways:

- `{ type: "atom" }`: a set of allowed names, like an enum.
- `{ type: "atom", ref: "<kind>" }`: the name must be a `<kind>` declared in the context the contract defines (for example, `accept=[:title]` must name an attribute declared in the same entity).

An unknown name is a positioned error on the atom with a did-you-mean suggestion, using the same distance rule as unknown tags. Editors complete the candidates. **Without a contract an atom is just its name: never an error**, so atoms cost nothing in a vocabulary that has not opted in.

#### What a reference needs from the contract system

Mesh (the first vocabulary to use references) listed what its contracts must express. Each item is weighed here; the status says whether decision 156 or the lead settled it, or whether it is an open question below.

The kinds Mesh refers to: an *attribute* (`accept`, `require`, `sort`, the left side of a `set` line), a *relationship* (`load`, which may also name a computed field), an *action* (`actions=[...]` on a policy and on `always`; `on:load`), and fixed sets (`auto` and `types`: `create`, `read`, `update`, `destroy`; `on` on a timestamp: `create`, `update`). The fixed sets are `{ type: "atom" }` with the allowed names listed; the rest are `ref` kinds.

| # | requirement | status |
|---|---|---|
| 1 | **Declare by tag set.** An attribute is declared by any of ten type tags (`uuid`, `string`, `integer`, ...) under `attributes`, and a `belongs-to` under `relationships` also declares an attribute (`listId`, derived, not written). `declares` must attach one kind to many tags | proposed here (not in 156): a kind is declared by a *set* of tags; each tag's contract says `declares: "<kind>"`, so any number of tags declare the same kind. The derived `listId` from `belongs-to` is open question 4 |
| 2 | **Declare by `id` or by `name`.** `declares.from` accepts `"id"` as well as `"name"` | decided by the lead: `from` is `"id"` or `"name"` (the tag's `#id` sugar or its `name`, including `:name`) |
| 3 | **Scope.** References resolve within the enclosing `entity`, and declarations sit in a sibling section (`attributes` against `actions`), not in an ancestor of the reference | decided by the lead: the scope of a `ref` is the **enclosing tag's whole subtree**, so sibling sections are in scope |
| 4 | **Cross-entity references** (`belongs-to=Customer`) | out of scope for the single-file checker. A name that is not declared in the enclosing subtree is checked by the vocabulary's own build step (Mesh checks at model build). Core does not resolve across files |
| 5 | **Union of kinds.** `load` may name a relationship or a computed field, so one attribute must accept either | proposed here: `ref` takes one kind or a list: `{ type: "atom", ref: ["relationship", "computed"] }`. The name must be declared as one of them. Open question 3 |
| 6 | **Derived declarations from `analyze`.** Mesh needs a way to add names that no tag declares by itself, or the check stays with Mesh | open question 4 (until settled the check stays with Mesh) |
| 7 | **Extensions add kinds.** Mesh ADR-0037 has extensions add tags and sections in one generated contracts module; an extension must declare new kinds and reference existing ones | proposed here: kinds are plain names in the contracts module, so a generated module can declare a new kind with `declares` and reference an existing one with `ref` without a registry. Collisions between extensions are open question 4 |
| 8 | **`parseData` shape.** An atom list arrives as a list whose items are atom nodes with their own spans | follows from section 2: `accept=[:title, :body]` is a list node whose items are `atom { name, span }` nodes, each with its own span |
| 9 | **A read action for `on:load`.** Mesh checks it in `analyze` if the contract cannot express it | stays with Mesh. A contract names a kind, not a property of the declaration (read against write); a kind per property (`read-action`) is the contract-only answer if Mesh wants it |

### 5. The name sugar, restated

ADR 146's `:name` in attribute position is this rule: **an atom standing alone in attribute position sets `name`.**

```mx
<input :email/>        ->  <input name="email"/>
<input type=:email/>   ->  atom as a value, no name set
```

Decision 146 addendum 4 carries over: when `=value` or `(params) { body }` follows the atom directly, the rest is the tag's default attribute (`value`), and the space after the atom is optional.

```mx
boolean :isOverdue({ self }) { ... }   ->  name="isOverdue" value=function
<input :email=expr/>                   ->  name="email" value=expr
```

It is an error only if the tag already has a default value. This replaces 146's "sugar takes no value" errors. The tag-adjacent forms (`<:atom>`, `<kind:atom>`) are unchanged and still resolved after parsing.

### 6. Invariants

Everything ADR 146 ships keeps its meaning. This table is the test list for the implementation; the left column is the form, the right is what it means before and after atoms (identical).

| form | meaning, before and after |
|---|---|
| `<:atom>` | `defaultTag` (ADR 145) with `name="atom"` |
| `<kind:atom>` | tag `kind` with `name="atom"` |
| `<kind :atom>` | tag `kind` with `name="atom"` |
| `<kind#id:atom.class>` and every order of the three tag-adjacent sugars (`<a.c:b>`, `<a#d:b.c>`, `<:b.c>`) | id, class and name as written |
| `#id`, `.class`, `:name` in attribute position (first, or after any attribute) | `id`, `class`, `name` |
| sugar followed by `=value` (`#id=x`, `:name=x`, `.class=x`) | the sugar plus `value=x` (addendum 4) |
| sugar followed by `(params) { body }` | the sugar plus `value=function` (addendum 4) |
| a bare `:` (no name) | positioned error: `:` needs a name; write `value:` for Marko's attribute |
| the default-attribute exemption: `<if=a\n .b>`, `<const/x=items\n .filter()/>` | Marko's meaning; sugar right after a default value is not supported |
| `class:x`, `style:x`, `value:fn:=x` | Marko's named modifiers, untouched |
| `x=a :b` | `x=a` then `name="b"`; the after-value split needs the parser rule (see Parser approach) |
| `x=:b` | the attribute `x` with the atom `:b` as its value (new; was a parse error) |

Where a form lands on an atom (`:email` standing alone), the atom is consumed as sugar and no atom node reaches lowering.

### 7. `::name`

Reserved for a future `Symbol.for("name")` sugar. Decision 156 does not give it a meaning; see Open questions.

## Examples

Mesh declares fields and refers to them. Without atoms:

```mx
<entity name="invoice">
  <attributes>
    <uuid name="id" primary-key/>
    <string name="title"/>
    <string name="body"/>
  </attributes>
  <policy accept=["title", "body"]/>
</entity>
```

With atoms:

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

- `uuid :id primary-key` is the name sugar of section 5: `name="id"` and a boolean attribute.
- `accept=[:title, :body]` is a list of atoms, and the names are *attributes* of the entity. With `accept` declared `{ type: "atom", ref: "attribute" }` and the attribute tags (`uuid`, `string`, ...) declaring the kind `attribute` from their `name`, the declarations sit in the sibling `<attributes>` section and the reference in `<policy>`, both inside `<entity>`: the scope is the enclosing tag's whole subtree. `:titel` is a positioned error on the atom naming `title` as the likely intent, and the editor completes `title` and `body`. With no contract on `accept`, both lower to `["title", "body"]` and nothing is checked.

## Alternatives considered

| option | rejected because |
|---|---|
| `Symbol.for("name")` values | loses typing: no literal type, so TypeScript cannot check or complete the name; cannot be an attribute value on native tags or in serialized output; needs host-specific lowering. `::name` stays reserved for it as sugar |
| bare identifiers (`accept=[title]`) | read as variables, resolve against scope, and forbid dashes (`rename-all`); a typo is a ReferenceError at runtime instead of a positioned error |
| a distinct runtime type (an `Atom` class or tagged object) | every consumer, native attribute and serializer must learn it; breaks "atoms need nothing host-specific"; Marko has no such value |
| a reference node (`:title` is a pointer resolved to a declaration) | needs a resolver in core for every vocabulary, before any contract says what it points at; contracts already do the resolving where it is wanted (`ref`), and no contract means no machinery |

## Consequences

- `:a === "a"` at runtime (section 3). Authors who need to tell the two apart cannot, by design.
- `x=:b` becomes legal where it was a parse error, and bare `:b` in expression position gains a meaning; neither breaks a program that parsed before.
- A vocabulary opts in per attribute (`type: "atom"`); nothing existing changes.
- Core stays host-agnostic: atoms lower to string literals and carry no host logic.
- The operator informs Mesh of the decision himself; Mesh's own docs are out of scope here.

## Parser approach

TBD — pending scratch/reports/squad-atoms/parser-approach.md (lead approval).

Open item: `x= :b` (whitespace between `=` and the atom). Today Marko's parser reads it as a ternary continuation or a parse error (ADR 146, "What was measured"). Whether it is an atom value, name sugar, or an error belongs to the parser approach.

## Open questions

Decision 156 does not settle these; they are recorded, not decided. The ref scope (the enclosing tag's whole subtree) and `declares.from` accepting `"id"` and `"name"` are decided and are not listed here.

1. **`::name` until the sugar exists.** Reserved and lexed as one token; whether it is a positioned "reserved" error or a generic parse error is unspecified.
2. **Atoms where `:` already means something in an expression.** `cond ? :a : :b`, object keys `{ a: :b }`, TypeScript annotations in tag arguments (`(x: :a)`) and arrow parameters. The rule for telling an atom from a ternary or type colon is the lexer's job and is not stated in 156.
3. **Union `ref`.** Mesh needs `load` to accept a relationship or a computed field. 156 gives `ref: "<kind>"`; whether `ref` may be a list (`["relationship", "computed"]`) is a contract-format extension this ADR proposes and 156 does not state.
4. **Derived declarations, and extension kinds.** (a) Names that no single tag declares, such as the `listId` a `belongs-to` derives: whether a contract can express it (`declares` with a name transform) or the vocabulary adds them from its `analyze` hook, and what the hook's API is. (b) When two extensions in one generated contracts module declare the same kind, whether they merge or collide.
5. **Name characters beyond identifier-like plus `-`.** Leading digit, leading `-`, trailing `-`, non-ASCII, and case rules. 156 says "names may contain `-`"; the exact token is whatever the 146 sugar token accepts unless the parser approach says otherwise.
6. **How a context is declared.** The scope is settled (the enclosing tag's whole subtree). Not specified: which tag's contract opens a context (an `entity`-like tag marks itself as the boundary, or the nearest tag that declares anything), and what happens when two nested tags could both be the enclosing one.
7. **Atom against a string contract.** `type: "string"` with `:x`: accepted as its string, or a type error? 156 says an atom without a contract is never an error; it is silent on a contract of another type.
8. **`parseData` shape.** 156 says it exposes the atom as such, and Mesh needs a list of atoms with a span per item; the concrete result shape (a tagged object, a wrapper class, a side table) and its stability as public API are not specified. Public API changes go to the lead per the standing rule.
9. **Printing and round-trip.** A formatter and `parseData` consumers that re-emit source must keep `:x` as `:x`; the IR keeps the span, but no formatter exists to confirm it.
