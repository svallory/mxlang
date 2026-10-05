---
title: "ADR 156: atoms"
description: "Why `:name` in an expression position is a value that represents itself, how it lexes, lowers and is checked by contracts, how the 146 name sugar is restated as an atom, and what was rejected."
---

# ADR 156: atoms

**Status:** draft (decision 156 in the decisions log; this ADR precedes the code, which waits for the lead to approve the parser approach). **Depends on:** ADR 145 (`defaultTag`), ADR 146 (`:name`). **Implementation:** not started.

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
| function argument, comparison, spread | `f(:a)`, `x === :a`, `...{ k: :a }` |
| attribute-tag value | `<@opt=:a/>` |
| inside an array or object in any of the above | `accept=[:title, :body]` |

An atom is never read inside `static`, `import` or script blocks, which stay plain TypeScript, and never inside strings, template literal text (the `${}` parts are scanned), regular expressions or comments. `"a :b"` is text, `/:b/` is a regex.

**Operations on an atom.** An atom is a name, not a value to operate on. Member access, calls and unary operators on it (`:a.length`, `:a(1)`, `-:a`) are positioned errors. Comparison (`x === :a`), array and object elements, spread arguments, template placeholders, function arguments and attribute-tag values are allowed (settled by the lead on 2026-10-05; see Open questions).

A name matches `[A-Za-z_$][\w$]*(-[\w$]+)*`: `:title`, `:rename-all`, `:primary-key`. This is the 146 sugar token without a trailing dash, so `:a-b` is the atom `a-b`, `:a - b` is subtraction, and a trailing `-` is not part of the name. (Proposed by the parser research; decision 156 says only "names may contain `-`".)

**Where a `:` starts an atom (proposed).** Only where an expression is expected: at the start of the value, or after an operator, punctuator or keyword. A `:` is never an atom after the end of an expression, after `.` or `?.`, or after `as`/`satisfies`. So `a ? b :c` is a ternary, `(x :number) => x` is a type annotation, and `a ? :b : :c` is a ternary of two atoms. Strings, template text (the `${}` parts are scanned), regular expressions (decided by the previous token) and comments are never scanned.

`::name` is reserved and is lexed as **one token together with its name** (`::a`), so a later `Symbol.for("name")` sugar needs no lookahead change, no existing program can be using it, and the error covers what the author wrote. Until then it is a positioned error: "`::a` is reserved (decision 156): `::` will be the `Symbol.for` sugar; write `:a` for an atom". Consequence: `{k::a}` and `a?b::c` are errors; write `{k: :a}`.

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
| 1 | **Declare by tag set.** An attribute is declared by any of ten type tags (`uuid`, `string`, `integer`, ...) under `attributes`, and a `belongs-to` under `relationships` also declares an attribute (`listId`, derived, not written). `declares` must attach one kind to many tags | proposed here (not in 156): a kind is declared by a *set* of tags; each tag's contract says `declares: { kind: "<kind>", from: "id" | "name" }` (defined here once; `from` is decided by the lead, the `declares` field itself is proposed), so any number of tags declare the same kind. The derived `listId` from `belongs-to` is open question 2 |
| 2 | **Declare by `id` or by `name`.** `declares.from` accepts `"id"` as well as `"name"` | decided by the lead: `declares.from` is `"id"` or `"name"` (the tag's `#id` sugar or its `name`, including `:name`) |
| 3 | **Scope.** References resolve within the enclosing `entity`, and declarations sit in a sibling section (`attributes` against `actions`), not in an ancestor of the reference | decided by the lead: the scope of a `ref` is the **enclosing tag's whole subtree**, so sibling sections are in scope |
| 4 | **Cross-entity references** (`belongs-to=Customer`) | out of scope for the single-file checker. A name that is not declared in the enclosing subtree is checked by the vocabulary's own build step (Mesh checks at model build). Core does not resolve across files |
| 5 | **Union of kinds.** `load` may name a relationship or a computed field, so one attribute must accept either | proposed here: `ref` takes one kind or a list: `{ type: "atom", ref: ["relationship", "computed"] }`. The name must be declared as one of them. Open question 1 |
| 6 | **Derived declarations from `analyze`.** Mesh needs a way to add names that no tag declares by itself, or the check stays with Mesh | open question 2 (until settled the check stays with Mesh) |
| 7 | **Extensions add kinds.** Mesh ADR-0037 has extensions add tags and sections in one generated contracts module; an extension must declare new kinds and reference existing ones | proposed here: kinds are plain names in the contracts module, so a generated module can declare a new kind with `declares` and reference an existing one with `ref` without a registry. Collisions between extensions are open question 2 |
| 8 | **`parseData` shape.** An atom list arrives as a list whose items are atom nodes with their own spans | follows from section 2: `accept=[:title, :body]` is a list node whose items are `atom { name, span }` nodes, each with its own span |
| 9 | **A read action for `on:load`.** Mesh checks it in `analyze` if the contract cannot express it | stays with Mesh. A contract names a kind, not a property of the declaration (read against write); a kind per property (`read-action`) is the contract-only answer if Mesh wants it |

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

It is an error only if the tag already has a default value. This replaces 146's "sugar takes no value" errors. The tag-adjacent forms (`<:atom>`, `<kind:atom>`) are unchanged and still resolved after parsing.

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

Where a form lands on an atom (`:email` standing alone), the atom is consumed as sugar and no atom node reaches lowering.

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
3. Core turns each stand-in back into a `StringLiteral` with `extra.mxAtom`, after checking that the source character at the node's start is `:` (no authored numeric literal starts with `:`, so the check cannot be forged), and keeps the node's `loc` as the atom span.

**Why a number.** Babel cannot be given a string literal of the same length (`:a` is 2 characters, `"a"` is 3), and a longer literal shifts every later position in that expression by one per atom. A numeric literal of the same length keeps every offset exact, and it cannot be assigned to, bound, or used as a shorthand key, so misuse (`:a = 1`, `(:a) => 1`, `{:a}`, `o.:a`) is a Babel error at the atom. An identifier stand-in would be accepted as a binding and bind a phantom name.

| option | what | why not |
|---|---|---|
| (a) | a Babel rule in the `@babel/parser` bundled with `@marko/compiler` | a Babel patch to maintain through the compiler bundle on every Babel bump; also needs a tokenizer patch for `::`; `a ? :b :c` still mis-splits |
| **(b′)** | **MX's htmljs-parser copy lexes, same-length stand-in, core converts** | **recommended**: exact positions, fixes `a ? :b :c`, Babel and `@marko/compiler` carry no atom code |
| (b) | the htmljs-parser copy pre-scans and hands Babel a string literal | positions shift by one per preceding atom in the same expression |
| (c) | core rewrites the source text before Babel | decision 151 rejected core re-scanning attribute source; Marko's code frames would show the stand-in; every entry point must rewrite |

**Measured** (on 5.42.5 / 5.15.0, main without addendum 4). 31 of 31 decision-146 forms produce byte-identical output with the simulation on and off. A corpus check over 523 `.mx`/`.marko` files and 864 expression positions found 0 atoms, so no existing parse changes (the 22 intentional error fixtures stop scanning at their first error). Spans are exact (for the source `<div x=[:a, :b]/>`, the atoms are at 8-10 and 12-14), and Babel errors land on the offending column. The `.solid.mx` bridge inherits core and needs nothing.

**The typecheck module.** Core's `expr()` emits the *authored source slice*, not a printed AST, so TypeScript type arguments survive. The virtual code for `x=[:a, :rename-all]` therefore holds `[:a, :rename-all]` verbatim, and atoms leak into TypeScript. Phase B splices `JSON.stringify(name)` at each atom's span through `rewriteReferencesSource` (both the no-bindings fast path and the rewrite path), and adds per-atom sub-mappings (`:a` to `"a"`) in `mappedExpr`, so a TypeScript error on `type=:emial` lands on the atom and offsets do not drift by one per atom.

**`x= :b` is the atom, `x="b"`**, the same as `x=:b` and `x = :b`. Measured: htmljs-parser, stock and patched, runs `consumeWhitespace()` after `=` before it enters the value, so Marko already reads `x= y` as `x=y`; `<t x= :b/>`, `<t x = :b/>` and concise `t x= :b` all give the value `:b`, and under (b′) `<div x= :b/>` gives `x="b"`. The 146 sugar needs a *finished* value before it (`x=a :b` is value `a` plus `name="b"`); reading `x= :b` as sugar would leave `x=` without a value, which no Marko spelling means.

**Misuse errors.** `[:a :b]` ("Did not expect a type annotation here", as `[a :b]` today), `:a = 1`, `(:a) => 1`, `{:a}`, `o.:a` and `:1` are positioned errors at the atom or its neighbour; core rewrites the wording where it can. Delivery lands as the same change in two places (decision 158): the root htmljs-parser patch, so MX 1 consumers get atoms through `@marko/compiler` now, and `packages/parser/src/template/`, the copy-in kept for the MX 2 front end; no GitHub fork; a stock parser gives a positioned "atoms need the MX parser" error, detected by a probe in the style of `installedParserSplits`.

## Open questions

Decision 156 does not settle these; they are recorded, not decided. The ref scope (the enclosing tag's whole subtree) and `declares.from` accepting `"id"` and `"name"` are decided and are not listed here. The lexer rule and the name token are proposed in Grammar, so they are no longer open.

Settled by the lead on 2026-10-05 alongside the parser research; option (b′) itself stays proposed (recorded here, built in Phase B):

- **Stand-in leak.** Accepted: core is the only supported driver of MX's parser, and core asserts that no stand-in survives its conversion.
- **Operations on an atom.** Member access, calls and unary operators on an atom (`:a.length`, `:a(1)`, `-:a`) are positioned errors (see "Operations on an atom" in Grammar). Comparison, array and object elements, template placeholders and function arguments are allowed.
- **Sequencing.** Phase B PR 1 opens after squad-targets' copy-in of htmljs-parser merges and carries the parser change twice, identically (decision 158): in the root htmljs-parser patch, which `@marko/compiler` (still the npm dependency) uses so MX 1 consumers get atoms now, and in `packages/parser/src/template/` for the MX 2 front end, until the front end switches to MX's own AST in `@mxlang/babel`. Core's stand-in conversion is the same for both. No GitHub fork.

Still open:

1. **Union `ref`.** Mesh needs `load` to accept a relationship or a computed field. 156 gives `ref: "<kind>"`; whether `ref` may be a list (`["relationship", "computed"]`) is a contract-format extension this ADR proposes and 156 does not state.
2. **Derived declarations, and extension kinds.** (a) Names that no single tag declares, such as the `listId` a `belongs-to` derives: whether a contract can express it (`declares` with a name transform) or the vocabulary adds them from its `analyze` hook, and what the hook's API is. (b) When two extensions in one generated contracts module declare the same kind, whether they merge or collide.
3. **How a context is declared.** The scope is settled (the enclosing tag's whole subtree). Not specified: which tag's contract opens a context (an `entity`-like tag marks itself as the boundary, or the nearest tag that declares anything), and what happens when two nested tags could both be the enclosing one.
4. **Atom against a string contract.** `type: "string"` with `:x`: accepted as its string, or a type error? 156 says an atom without a contract is never an error; it is silent on a contract of another type.
5. **`parseData` shape.** 156 says it exposes the atom as such, and Mesh needs a list of atoms with a span per item; the concrete result shape (a tagged object, a wrapper class, a side table) and its stability as public API are not specified. Public API changes go to the lead per the standing rule.
6. **Printing and round-trip.** A formatter and `parseData` consumers that re-emit source must keep `:x` as `:x`; the IR keeps the span, but no formatter exists to confirm it.
