---
title: "ADR 156: atoms"
description: "Why `:name` in an expression position is a value that represents itself, how it lexes, lowers and is checked by contracts, how the 146 name sugar is restated as an atom, and what was rejected."
---

# ADR 156: atoms

**Status:** accepted (decision 156 in the decisions log); parser approach implemented in PR <n>. **Depends on:** ADR 145 (`defaultTag`), ADR 146 (`:name`). **Amended by:** decision 156 addendum 1 (the lead's rulings on Mesh's review). **Implementation:** Phase B PR 1 (parser, core conversion, IR, typecheck splice, `parseData`); contracts in PR 2.

## Context

ADR 146 gave `:name` a meaning in tag position: `<input:email>`, `<input :email>` and `<:email>` set `name="email"`. The same spelling reads naturally somewhere else too: as a value.

```mx
<policy accept=["title", "body"]/>
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
| function argument, comparison, object value | `f(:a)`, `x === :a`, `{ k: :a }` |
| attribute-tag value | `<@opt=:a/>` |
| inside an array or object in any of the above | `accept=[:title, :body]` |

An atom is never read inside `static`, `import` or script blocks, which stay plain TypeScript, and never inside strings, template literal text (the `${}` parts are scanned), regular expressions or comments. `"a :b"` is text, `/:b/` is a regex.

**Operations on an atom.** An atom is a name, not a value to operate on. Member access, calls and unary operators on it (`:a.length`, `:a(1)`, `-:a`) and an atom in object-key position (`{:a: 1}`) are positioned errors **detected by core, not by Babel**: the numeric stand-in (Parser approach) makes each of them valid JavaScript, so core finds them from the stand-in's atom mark. A computed key, `{[:a]: 1}`, is allowed. Comparison (`x === :a`), array and object elements, template placeholders, function arguments and attribute-tag values are allowed (settled by the lead on 2026-10-05; see Open questions and settled points).

A name matches `[A-Za-z_$][\w$]*(-[\w$]+)*`: `:title`, `:rename-all`, `:primary-key`. This is the 146 sugar token without a trailing dash, so `:a-b` is the atom `a-b`, `:a - b` is subtraction, and a trailing `-` is not part of the name. (Proposed by the parser research; decision 156 says only "names may contain `-`".)

**Where a `:` starts an atom (proposed).** Only where an expression is expected: at the start of the value, or after an operator, punctuator or keyword. A `:` is never an atom after the end of an expression, after `.` or `?.`, or after `as`/`satisfies`. So `a ? b :c` is a ternary, `(x :number) => x` is a type annotation, and `a ? :b : :c` is a ternary of two atoms. Strings, template text (the `${}` parts are scanned), regular expressions (decided by the previous token) and comments are never scanned.

`::name` is reserved and is lexed as **one token together with its name** (`::a`), so a later `Symbol.for("name")` sugar needs no lookahead change, no existing program can be using it, and the error covers what the author wrote. Until then it is a positioned error: "`::a` is reserved (decision 156): `::` will be the `Symbol.for` sugar; write `:a` for an atom". Consequence: `{k::a}` and `a?b::c` are errors; write `{k: :a}`.

### 2. IR

An atom is its own IR node, `atom { name, span }`, distinct from `string`. It is not a string literal in the tree; it lowers to one (next section). `parseData` exposes it as an atom, so data consumers can tell `:title` from `"title"` and tools can offer completion and go-to on it.

**An atom inside an expression** (decision 156 addendum 1, item 1). Where an atom sits inside any expression, nested cases included (array element, object value, call argument, ternary branch, template placeholder, comparison, function body), the `DataExpr.node` Babel node is a `StringLiteral` whose `extra.mxAtom` is `{ span }`, the atom's own span. The node's value is the atom's name, so code that only reads strings still works, and code that cares checks `extra.mxAtom`. This node shape is **public API** of `@mxlang/core` and `@mxlang/data`, stable like the rest of the IR; the Parser approach section builds it, and Phase B PR 1 documents it in `apps/docs/docs/architecture/ir-spec.md`. A consumer that translates an expression (Mesh turns `filter=({ self }) => self.status === :sent` into SQL) recognises an atom by `extra.mxAtom` and reads its span from there.

**Atom-ness survives the name sugar** (addendum 1, item 2). The `name` attribute that the sugar sets (`<string :title/>`, `<:status="paid"/>` under `set`) is marked as written-as-atom in the IR. The `parseData` shape is one rule (addendum 1, item 10): **any attribute whose entire value is one atom is `DataAttr { kind: "atom", name, span }`**, which covers `mode=:strict` and the sugar-derived `name` alike; an atom nested anywhere in an expression (an array item, an object value, a call argument) stays a `StringLiteral` with `extra.mxAtom = { span }`. The sugar form is therefore a reference like any other: a contract `name: { type: "atom", ref: ... }` is satisfied, checked and completed by it, and `name="title"` is a type error where `name` is typed atom.

An atom list (`accept=[:title, :body]` is an expression, not a whole-value atom) arrives in `parseData` as a `DataExpr` whose array items are `StringLiteral` nodes with `extra.mxAtom`, each with its own span.

### 3. Lowering

The runtime value of an atom is its name as a string literal, on every target: `mode=:strict` lowers to `"strict"`.

- TypeScript literal typing checks and completes it (`mode: "strict" | "loose"` accepts `:strict`, rejects `:stirct`).
- A native attribute accepts it (`<input type=:email>` renders `type="email"`).
- Nothing host-specific is emitted, so core stays host-agnostic and every host behaves identically.

**The wrinkle, stated openly:** at runtime `:a === "a"`. Atoms are names and strings are text, and they have the same representation. The distinction exists in the source, the IR and the contract checks, and it ends at lowering. Code that receives `"title"` cannot tell whether the author wrote `:title` or `"title"`, and cannot be made to.

### 4. Contracts

A contract attribute may be declared in these ways (decision 156 addendum 1, items 3, 5 and 9):

- `{ type: "atom" }`: **open.** Any atom is accepted.
- `{ type: "atom", values: [...] }`: a set of allowed names, like an enum. An optional `pattern` (a regex source string) restricts the name further, with or without `values`.
- `{ type: "atom", ref: "<kind>" }`: the name must be a `<kind>` declared in scope (for example, `accept=[:title]` must name an attribute declared in the same entity).
- `{ type: "atom", ref: ["<kind>", ...] }`: a union; the name must be declared as one of the kinds (`load` is a relationship or a computed field).

**Atom against string.** An atom where the contract declares `string` is a type error, as a string where the contract declares `atom` already is. The distinction is checked both ways.

An unknown name is a positioned error on the atom with a did-you-mean suggestion, using the same distance rule as unknown tags. Editors complete the candidates. **Without a contract an atom is just its name: never an error**, so atoms cost nothing in a vocabulary that has not opted in.

#### Declaring and resolving references

Checking is **two phases** (addendum 1, item 4):

1. **Declare.** Core collects every declaration in the file: the ones contracts state with `declares`, and the ones an `analyze` hook adds with `ctx.declare`.
2. **Check.** Core then checks every reference against the declarations. Order in the source does not matter, so a reference may come before its declaration and a hook-added name is visible to every reference.

A tag's contract declares a name with:

```text
declares: Entry | Entry[]
Entry = { kind: "<kind>", from: "id" | "name", scope?: "<ancestor tag name>", under?: "<parent tag>" | ["<parent tag>", ...], uniqueWith?: ["<kind>", ...] }
```

`declares` is one entry or an array of entries (decision 156 addendum 1, item 10). Entries may differ in kind and scope.

- `under` (optional) limits the entry to a tag whose **parent** is one of the named tags. An entry without `under` applies under any parent. When several entries match, the **most specific wins**: an entry whose `under` names the parent beats one without.
- `kind` is a plain name. Any number of tags may declare the same kind (the ten type tags all declare `attribute`).
- `from` is where the name comes from: the tag's `#id` sugar (`"id"`) or its `name`, including `:name` (`"name"`).
- `scope` is the **nearest ancestor tag with that name** that the declaration belongs to; when it is omitted, the scope is the file's **root tag**. A tag such as `string` declares an `argument` with `scope: "action"` when it sits under `arguments`, so the argument is visible only inside its action, and an `attribute` with the default scope when it sits under `attributes`, visible across the whole entity.
- A reference resolves against every enclosing scope, **innermost first**; the first scope that declares the name decides. **No tag "opens a context"**: a scope is an ancestor tag a declaration names, and a contract never says it is a boundary.
- `uniqueWith` (optional): a declaration also collides with a same-named declaration of the listed kinds in its scope, not just with its own kind.

This refines the earlier wording "the enclosing tag's whole subtree" (the lead's earlier ruling and the first draft of this ADR; decision 156 item 3 says only "declared in the context the contract defines"). A declaration in a sibling section is still in scope, because the default scope is the root tag and the root's whole subtree is searched. What changed: the scope is a named ancestor, not "the enclosing tag" in general, and resolution walks the scopes from the innermost outward.

**Derived declarations** (item 6). A name that no tag states, such as the `listId` a `belongs-to` derives, is added from the vocabulary's `analyze` hook with `ctx.declare(kind, name, { span, scope })`, in the declare phase. It is not a name transform in `declares`. `span` is where an error or go-to for that name should point (the tag that caused the derivation); `scope` has the same meaning and default as above.

**Duplicates** (item 7). Two declarations of the same name and kind in one scope are a **core error**, a positioned error carrying both spans. This holds for declarations from `declares` and from `ctx.declare` alike.

**Kinds merge across modules** (item 8). A kind is a plain name. Two contract modules (Mesh's core module and an extension's generated module) that declare the same kind name mean the same kind: their declarations and references share one namespace, and nothing collides between modules unless two declarations are the same name and kind in one scope (the duplicate rule).

#### What a reference needs from the contract system

Mesh (the first vocabulary to use references) listed what its contracts must express; each item was settled in decision 156 addendum 1 or accepted as Mesh-side in its review (rows 4 and 10).

The kinds Mesh refers to: an *attribute* (`accept`, `require`, `sort`, the left side of a `set` line), a *relationship* (`load`, which may also name a computed field), an *action* (`actions=[...]` on a policy and on `always`; `on:load`), an *argument* (`require`), and fixed sets (`auto` and `types`: `create`, `read`, `update`, `destroy`; `on` on a timestamp: `create`, `update`). The fixed sets are `{ type: "atom", values: [...] }`; the rest are `ref` kinds.

| # | requirement | resolution |
|---|---|---|
| 1 | **Declare by tag set.** An attribute is declared by any of ten type tags (`uuid`, `string`, `integer`, ...) under `attributes`, and a `belongs-to` under `relationships` also declares an attribute (`listId`, derived, not written) | each tag's contract says `declares: { kind: "attribute", from: "name" }` (`string` adds a second entry, `under: "arguments"`, see the arguments example). The derived `listId` comes from `ctx.declare` in `analyze` |
| 2 | **Declare by `id` or by `name`** | `declares.from` is `"id"` or `"name"` (the tag's `#id` sugar or its `name`, including `:name`) |
| 3 | **Scope.** Declarations sit in a sibling section (`attributes` against `actions`), and `arguments` are visible only inside their action | `scope` names an ancestor tag, default the root; `under` picks the entry by parent tag; resolution is innermost first (see above) |
| 4 | **Cross-entity references** (`belongs-to=Customer`) | out of scope for the single-file checker. A name that is not declared in scope is checked by the vocabulary's own build step (Mesh checks at model build). Core does not resolve across files |
| 5 | **Union of kinds.** `load` is a relationship or a computed field; `sort` an attribute or a computed field; `require` an attribute or an argument | `ref` takes a list of kinds |
| 6 | **Derived declarations from `analyze`** | `ctx.declare(kind, name, { span, scope })` |
| 7 | **Extensions add kinds** (Mesh ADR-0037: extensions add tags and sections in one generated contracts module) | kinds merge by name across contract modules |
| 8 | **Duplicate declarations** | a positioned core error with both spans; optional `uniqueWith` |
| 9 | **`parseData` shape.** An atom list arrives as a list of atom nodes with their own spans | section 2: items are `StringLiteral` nodes with `extra.mxAtom`; a whole-value atom (`mode=:strict`, the name sugar) is `DataAttr` kind `atom` |
| 10 | **A read action for `on:load`** | stays with Mesh's `analyze`. A contract names a kind, not a property of the declaration (read against write); a kind per property (`read-action`) is the contract-only answer if Mesh wants it |

### 5. The name sugar, restated

ADR 146's `:name` in attribute position is this rule: **an atom standing alone in attribute position sets `name`.**

```text
<input :email/>        ->  <input name="email"/>
<input type=:email/>   ->  atom as a value, no name set
```

Decision 146 addendum 4 carries over: when `=value` or `(params) { body }` follows the atom directly, the rest is the tag's default attribute (`value`), and the space after the atom is optional.

```text
boolean :isOverdue({ self }) { ... }   ->  name="isOverdue" value=function
<input :email=expr/>                   ->  name="email" value=expr
```

The `name` attribute the sugar sets keeps its atom-ness (section 2): the IR and `parseData` mark it as written-as-atom (`DataAttr` kind `atom`), so a contract that types `name` as an atom with a `ref` checks it, and `name="title"` is a type error there. It is an error only if the tag already has a default value. This replaces 146's "sugar takes no value" errors. The tag-adjacent forms (`<:atom>`, `<kind:atom>`) are unchanged and still resolved after parsing.

### 6. Invariants

Everything ADR 146 ships keeps its meaning. This table is the test list for the implementation and a regression check, not a Marko parity requirement (decision 157: Marko is the default where MX has no ruling, divergences need a decision and a row); the left column is the form, the right is what it means before and after atoms (identical, except `x=:b`, `x= :b` and `a ? :b :c`, which are changes). The baseline is main **after decision 146 addendum 4** (branch `name-sugar-default-value`; main itself still has the "sugar takes no value" error in `name-sugar.ts:622`). The 31 of 31 byte-identical run (parser simulation off and on) was measured on main *without* addendum 4, so the addendum-4 rows below (sugar plus `value=x`, sugar plus `value=function`) are **unmeasured**; they are re-measured in Phase B.

| form | meaning, before and after |
|---|---|
| `<:atom>` | `defaultTag` (ADR 145) with `name="atom"` |
| `<kind:atom>` | tag `kind` with `name="atom"` |
| `<kind :atom>` | tag `kind` with `name="atom"` |
| `<kind#id:atom.class>` and every order of the three tag-adjacent sugars (`<a.c:b>`, `<a#d:b.c>`, `<:b.c>`) | id, class and name as written |
| `#id`, `.class`, `:name` in attribute position (first, or after any attribute) | `id`, `class`, `name` |
| sugar followed by `=value` (`#id=x`, `:name=x`, `.class=x`) | the sugar plus `value=x` (addendum 4; unmeasured) |
| sugar followed by `(params) { body }` | the sugar plus `value=function` (addendum 4; unmeasured) |
| a bare `:` (no name) | positioned error: `:` needs a name; write `value:` for Marko's attribute |
| the default-attribute exemption: `<if=a\n .b>`, `<const/x=items\n .filter()/>` | Marko's meaning; sugar right after a default value is not supported |
| `class:x`, `style:x`, `value:fn:=x` | Marko's named modifiers, untouched |
| `x=a :b` | `x=a` then `name="b"`; the after-value split already ships in the 146 parser rule |
| `x=:b` | the attribute `x` with the atom `:b` as its value (new; was a parse error) |
| `x= :b`, `x = :b` | the same atom, `x="b"` (see Parser approach) |
| `a ? b :c` | a ternary; the `:` is not an atom |
| `(x :number) => x` | a type annotation; the `:` is not an atom |
| `a ? :b :c` | **a change.** Today the 146 patch counts the atom's `:` as the ternary's and splits `:c` off as sugar (`x=a ? :b` plus `name="c"`, a parse error). After atoms it is `a ? "b" : c`, one value. Listed under Consequences |

Where a form lands on an atom (`:email` standing alone), the atom is consumed as sugar and no atom node reaches lowering; the resulting `name` attribute carries the atom mark in the IR (section 2).

### 7. `::name`

Reserved for a future `Symbol.for("name")` sugar (decision 156.5); the error text is in Grammar.

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
- `accept=[:title, :body]` is a list of atoms, and the names are *attributes* of the entity. With `accept` declared `{ type: "atom", ref: "attribute" }` and the attribute tags (`uuid`, `string`, ...) declaring the kind `attribute` from their `name` (default scope: the root `<entity>`), the declarations sit in the sibling `<attributes>` section and the reference in `<policy>`, both inside the root. `:titel` is a positioned error on the atom naming `title` as the likely intent, and the editor completes `title` and `body`. With no contract on `accept`, both lower to `["title", "body"]` and nothing is checked.

### Mesh's worked examples

**A `set` line** (shown as text: the tree-sitter grammar does not yet parse the addendum-4 form `:name=value`). Inside `<set>`, each line is the default tag with the name sugar: `<:status="paid"/>` sets `name="status"` and `value="paid"` on the default tag (decision 146 addendum 4), not on `set` itself. That `name` is a reference to an attribute: the contract types it `{ type: "atom", ref: "attribute" }`, the sugar form satisfies it, `parseData` reports it as a `DataAttr` of kind `atom`, and `<:statuss="paid"/>` is an error with a suggestion.

```text
<entity :invoice>
  <attributes>
    <string :status/>
  </attributes>
  <actions>
    <update :pay>
      <set>
        <:status="paid"/>
      </set>
    </update>
  </actions>
</entity>
```

**Declaring by name.** On a declaring tag such as `string :title`, `name` is typed as an atom and the tag's contract says `declares: { kind: "attribute", from: "name" }`. `<string name="title"/>` is a type error there (a string where an atom is declared), and `<string :title/>` declares `title`.

**A union.** `load` names a relationship or a computed field:

```text
load: { type: "atom", ref: ["relationship", "computed"] }
```

so `load=[:items, :total]` is checked against both kinds, and a name declared as neither is an error. `sort` (attribute or computed) and `require` (attribute or argument) are the same shape.

**Arguments scoped to an action.** `string` declares two things by its parent (addendum 1, item 10):

```text
string: { declares: [
  { kind: "attribute", from: "name", under: "attributes" },
  { kind: "argument",  from: "name", under: "arguments", scope: "action" },
] }
```

so `string :title` under `attributes` is an attribute visible across the entity, and `string :newTitle` under `arguments` is an argument visible only in its action:

```mx
<entity :invoice>
  <attributes>
    <string :title/>
  </attributes>
  <actions>
    <update :rename>
      <arguments>
        <string :newTitle/>
      </arguments>
      <require=[:newTitle]/>
    </update>
  </actions>
</entity>
```

`:newTitle` resolves inside `rename` and nowhere else. A reference to it from another action is an error, and a reference to `:title` from inside `rename` resolves to the attribute: the action's scope is searched first, then the root.

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
- `a ? :b :c` changes meaning (see the invariants table): today the 146 patch mis-splits it into an error; after atoms it is the ternary `a ? "b" : c`. A `divergences.md` row for it and for atoms is added in Phase B.
- Marko's own VS Code extension and language server, and `prettier-plugin-marko`, run the stock parser and Babel and see atoms as syntax errors (or reformat atom files); `.mx` files use MX's tools, as in ADR 146 and decision 151.4.
- A vocabulary opts in per attribute (`type: "atom"`); nothing existing changes.
- Core stays host-agnostic: atoms lower to string literals and carry no host logic.
- The operator informs Mesh of the decision himself; Mesh's own docs are out of scope here.

## Parser approach

**Proposed, pending lead approval.** Source: `scratch/reports/squad-atoms/parser-approach.md` (option b′), measured by a simulation inside the real `@marko/compiler` 5.42.5 with htmljs-parser 5.15.0 patched. Main now pins 5.42.10 / 5.18.0; the simulation is **not** re-run on them here and is re-run on 5.18.0 at the start of Phase B.

Today htmljs-parser passes every atom through intact in every position (attribute value, default attribute, `${}`, tag arguments, concise mode, attribute tags), and Babel rejects every one with "Unexpected token". Babel has no parser plugin API: an unknown plugin name is silently ignored. So atoms are lexed where MX already owns the lexer, htmljs-parser as MX carries it (the root patch today, the in-repo copy for the future; decisions 157 addendum 2 and 158):

1. htmljs-parser's `EXPRESSION` state, as MX carries it (the root `patches/htmljs-parser` patch and the in-repo copy in `packages/parser/src/template/`, the same change in both; decision 158) lexes atoms in value, placeholder, tag-argument, attribute-argument (`<t x(:a)>`) and spread ranges only (never statement tags such as `static`, scriptlets or method bodies, which stay TypeScript errors), using the rule in Grammar. It records each atom's span.
2. Its `read()` hands Babel a **same-length numeric stand-in** for each atom (`:a` is `0.`, `:rename-all` is `0.000000000`).
3. Core turns each stand-in back into a `StringLiteral` with `extra.mxAtom = { span }` (the public node shape of section 2), after checking that the source character at the node's start is `:` (no authored numeric literal starts with `:`, so the check cannot be forged), and keeps the node's `loc` as the atom span.

**Why a number.** Babel cannot be given a string literal of the same length (`:a` is 2 characters, `"a"` is 3), and a longer literal shifts every later position in that expression by one per atom. A numeric literal of the same length keeps every offset exact, and it cannot be assigned to, bound, or used as a shorthand property, so that misuse (`:a = 1`, `(:a) => 1`, `{:a}`, `o.:a`) is a Babel error at the atom. Other misuse is valid JavaScript on a number (`:a.length`, `:a(1)`, `-:a`, and `{:a: 1}`, which is the numeric key `0.`), so Babel does not reject it and **core** does, from the atom mark. An identifier stand-in would be accepted as a binding and bind a phantom name.

| option | what | why not |
|---|---|---|
| (a) | a Babel rule in the `@babel/parser` bundled with `@marko/compiler` | a Babel patch to maintain through the compiler bundle on every Babel bump; also needs a tokenizer patch for `::`; `a ? :b :c` still mis-splits |
| **(b′)** | **MX's htmljs-parser copy lexes, same-length stand-in, core converts** | **recommended**: exact positions, fixes `a ? :b :c`, Babel and `@marko/compiler` carry no atom code |
| (b) | the htmljs-parser copy pre-scans and hands Babel a string literal | positions shift by one per preceding atom in the same expression |
| (c) | core rewrites the source text before Babel | decision 151 rejected core re-scanning attribute source; Marko's code frames would show the stand-in; every entry point must rewrite |

**Measured** (on 5.42.5 / 5.15.0, main without addendum 4). 31 of 31 decision-146 forms produce byte-identical output with the simulation on and off. A corpus check over 523 `.mx`/`.marko` files and 864 expression positions found 0 atoms, so no existing parse changes (the 22 intentional error fixtures stop scanning at their first error). Spans are exact (for the source `<div x=[:a, :b]/>`, the atoms are at 8-10 and 12-14), and Babel errors land on the offending column. The `.solid.mx` bridge inherits core and needs nothing.

**The typecheck module.** Core's `expr()` emits the *authored source slice*, not a printed AST, so TypeScript type arguments survive. The virtual code for `x=[:a, :rename-all]` therefore holds `[:a, :rename-all]` verbatim, and atoms leak into TypeScript. Phase B splices `JSON.stringify(name)` at each atom's span through `rewriteReferencesSource` (both the no-bindings fast path and the rewrite path), and adds per-atom sub-mappings (`:a` to `"a"`) in `mappedExpr`, so a TypeScript error on `type=:emial` lands on the atom and offsets do not drift by one per atom.

**`x= :b` is the atom, `x="b"`**, the same as `x=:b` and `x = :b`. Measured: htmljs-parser, stock and patched, runs `consumeWhitespace()` after `=` before it enters the value, so Marko already reads `x= y` as `x=y`; `<t x= :b/>`, `<t x = :b/>` and concise `t x= :b` all give the value `:b`, and under (b′) `<div x= :b/>` gives `x="b"`. The 146 sugar needs a *finished* value before it (`x=a :b` is value `a` plus `name="b"`); reading `x= :b` as sugar would leave `x=` without a value, which no Marko spelling means.

**Misuse errors.** `[:a :b]` ("Did not expect a type annotation here", as `[a :b]` today), `:a = 1`, `(:a) => 1`, `{:a}`, `o.:a` and `:1` are positioned Babel errors at the atom or its neighbour (core rewrites the wording where it can); `:a.length`, `:a(1)`, `-:a` and `{:a: 1}` are positioned core errors, since Babel accepts them. Delivery lands as the same change in two places (decision 158): the root htmljs-parser patch, so atoms work wherever the patched parser is installed (this repo and link checkouts), and `packages/parser/src/template/`, the copy-in kept for the MX 2 front end; no GitHub fork; published consumers get stock htmljs-parser through `@marko/compiler`, so they (and any stock parser) get a positioned "atoms need the MX parser" error, detected by a probe in the style of `installedParserSplits`, until the MX AST replaces `@marko/compiler` (decisions 151 §1, 158 §2).

## Open questions and settled points

Decision 156 and its addendum 1 settle everything the contract system needed; what is still open is at the end. The lexer rule and the name token are proposed in Grammar, so they are not open.

Settled by the lead on 2026-10-05 alongside the parser research; option (b′) itself stays proposed (recorded here, built in Phase B):

- **Stand-in leak.** Accepted: core is the only supported driver of MX's parser, and core asserts that no stand-in survives its conversion.
- **Operations on an atom.** Member access, calls and unary operators on an atom (`:a.length`, `:a(1)`, `-:a`) are positioned errors (see "Operations on an atom" in Grammar). Comparison, array and object elements, template placeholders and function arguments are allowed.
- **Sequencing.** Phase B PR 1 opens after squad-targets' copy-in of htmljs-parser merges and carries the parser change twice, identically (decision 158): in the root htmljs-parser patch, which `@marko/compiler` (still the npm dependency) uses in this repo and link checkouts (published consumers get the positioned "atoms need the MX parser" error until the MX AST lands, decision 158 §2), and in `packages/parser/src/template/` for the MX 2 front end, until the front end switches to MX's own AST in `@mxlang/babel`. Core's stand-in conversion is the same for both. No GitHub fork.

Settled by the lead on 2026-10-05 in decision 156 addendum 1, on Mesh's review (all nine items accepted):

- **Atoms in expressions are public API.** `StringLiteral` with `extra.mxAtom = { span }`, nested cases included (section 2).
- **The name sugar keeps its atom-ness**, in the IR and as `DataAttr` kind `atom` (sections 2 and 5).
- **Open atom type**, `values` optional, optional `pattern` (section 4).
- **Two phases and scope.** Declare then check; `declares.scope` names an ancestor tag, default the root; innermost-first resolution; no tag opens a context (section 4). This replaces the earlier open question "how a context is declared" and refines "the enclosing tag's whole subtree".
- **Union `ref`.** A list of kinds.
- **Derived declarations** through `ctx.declare` from `analyze`, not a name transform. This replaces the earlier open question 2(a).
- **Duplicates** are a positioned core error with both spans; `uniqueWith` is optional.
- **Kinds merge** across modules. This replaces the earlier open question 2(b).
- **Atom against `string`** is a type error, both ways. This replaces the earlier open question on string contracts.
- **`parseData` shape** (addendum 1, item 10). An attribute whose entire value is one atom, the sugar-derived `name` included, is a `DataAttr` of kind `atom`; an atom nested in an expression is a `StringLiteral` with `extra.mxAtom`; each carries its own span.

Still open:

1. **Printing and round-trip.** A formatter and `parseData` consumers that re-emit source must keep `:x` as `:x`; the IR keeps the span, but no formatter exists to confirm it.

## Phase B

1. **PR 1: parser, IR, lowering, public node shape.** The parser change in both places (decision 158), the `atom` IR node, lowering to string literals, `extra.mxAtom = { span }` on atoms inside expressions with the node shape documented in `apps/docs/docs/architecture/ir-spec.md` in that same PR, and `DataAttr` kind `atom` (including for the name sugar). Re-measures the invariants table and the parser simulation on 5.18.0, and adds the `divergences.md` rows.
2. **PR 2: contracts.** The open atom type with `values` and `pattern`; the two phases; `declares` with `from`, `scope` and `uniqueWith`; union `ref`; `ctx.declare` from `analyze`; the duplicate-declaration error; kind merging across modules; atom-against-string type errors.
3. **PR 3: docs and grammar.** User docs for atoms and contracts, and the tree-sitter grammar.
