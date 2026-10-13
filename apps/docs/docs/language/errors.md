---
title: "Errors"
description: "The compile-time errors you're likely to see and why they exist."
---

# Errors

MX prefers a compile error over silently dropping or misinterpreting a construct. This page catalogs the errors you're most likely to run into and why each one exists.

## `<effect>`

```html
<effect() { go() }/>
```

is rejected on every target (`lowerSource` and the html targets), in every form (with a body, self-closing, with attributes or a spread). The default html policy and `lowerSource` say:

> `<effect>` is not an MX tag. Use `<script>`: its body runs after render and again when a value it reads changes.

The code is `MX_RESERVED_EFFECT_TAG` and the position is the tag name. The diagnostic carries one quick fix, "Rename to `<script>`", that renames the open and close tag; an editor shows it as a code action. A host (embedded MX in a framework) says "`<effect>` is not supported in embedded MX on Preact." (its own name, no second sentence); this text is the default target's; the html `strict` policy says "`<effect>` is a reactive effect and requires a runtime; this strict policy has no reactive target". A dialect that states the `none` tag rules keeps `effect` as an ordinary tag name. See [Stateful tags](/language/stateful-tags/).

## A `<let>` written while the template renders

```html
<let/count=0/>
<p>${count++}</p>
```

is rejected on the html default policy:

> `count` is a `<let>` and cannot be written while the template renders. Write it in an event handler or a `<script>` body, or derive a value with `<const>`.

The code is `MX_LET_WRITE_IN_RENDER` and the position is the assignment or update, with its end. Render position is a placeholder, an attribute, tag-argument, spread or attribute-tag value, the attributes and arguments of `<log>`, `<debug>`, `<id>`, `<lifecycle>` and `<script>` (not a `<script>` body), the attributes of the `<let>` itself, a `<const>` value, the default of a tag param, and an `<if>` or `<for>` header. A write inside a function, arrow or object method (an event handler), in a `<script>` body or in a `<let>`'s own `valueChange` is fine, and so is a parameter or local that shadows the `<let>`. A write inside a function the template calls while it renders is not detected. Hosts and the html `strict` policy refuse `<let>` itself, and under the `none` tag rules `let` is an ordinary tag name. `lowerSource` refuses every `<let>` tag variable (a data file has no state) and reports a render write first. See [Stateful tags](/language/stateful-tags/).

## Module level code that names a render-only name

```html
<let/count=0/>
static const first = count
```

is rejected on the html default policy and in `lowerSource`:

> `count` exists only while the template renders, so module level code (`static`, `server` and `client` blocks and `export` statements), which runs once as the template loads, cannot reference it. Reference it in the template instead, passing it to a module level function as an argument.

The code is `MX_RENDER_ONLY_IN_MODULE` and the position is the name, with its end. The names are every tag variable in the file (a `<let>`, a `<const>`, a `<define>`, before or after the statement, nested in a tag body or not), `input`, `$global` and `$signal`. A read, a write and an update all count, in the statement itself or in a function it declares, and so do the statements inside a `static { … }` block. A module level declaration with the spelling of a tag variable in the template's top level (`static count = 1`) is refused at the declaration, with "cannot declare a name with its spelling. Rename the module level binding." What does not count: a parameter or local of a module function that shadows the name, a property name, a name inside a type, a tag param (module code that spells it reads a global), and a module binding that shares the spelling of a tag variable only a nested tag declares. A host that refuses `server` or `client` says so first, and the check is skipped under the `none` tag rules. See [Define, const, static, import](/language/define-const-static-import/).

## A derived `<const>` read after its `<let>` was written

```html
<let/items=[]/>
<const/total=items.reduce((sum, item) => sum + item.price, 0)/>
<button onClick() {
  items = [...items, input.candidate];
  if (total > 100) applyDiscount();
}>Add</button>
```

is rejected on the html default policy and in `lowerSource`:

> `total` is stale here: it derives from `items`, which this handler wrote on line 4. Compute from `items` directly, or move the check into a `<script>`, which runs after the write settles on every target.

Marko, React and Solid 2 return the value from before the write there; Svelte, Vue, Angular and Lit return the new one, so one source cannot mean the same thing everywhere. The code is `MX_STALE_DERIVED_READ` and the position is the read, with its end. Compute the value from `items` directly (`const next = [...items, input.candidate]`), or check it in a `<script>` body, which runs after the write has settled.

What counts: the function given to an `on…` attribute of any tag (an attribute method, an arrow or a function expression, on a native element, a custom tag or an attribute tag), a `<const>` that reaches the written `<let>` through other `<const>`s, and any read that follows a write in source order in the handler's own body: a write in an earlier branch or block, a read after an `await`, and a read in a loop that also writes. Compound, logical and destructuring assignments and `++`/`--` all write. What does not: a read before the write, a read in a nested function or callback, a `<script>` body, a `<const>` that does not depend on the written `<let>`, and a parameter or local that shadows either name. A `for` initializer or a `for…of` / `for…in` subject runs once before the loop's writes, so a read there is fine; the test and update of a `for` repeat and are flagged. Not detected: a handler held in a variable or built by a call, a function declared with `<const>` and called from a handler, a write made inside a nested function, a `for (items of …)` head used as a write, a `<const>` declared below the handler's tag, and a write followed by a read inside one `<lifecycle>` hook (a hook is not an event handler). Hosts and the html `strict` policy refuse `<let>` itself, and under the `none` tag rules `let` is an ordinary tag name. See [Stateful tags](/language/stateful-tags/).

## A tag a host does not support

Embedded MX (a `.mx` file compiled for a host, a `.solid.mx` or `.astro.mx` file, a region in a `.react.mx`, `.preact.mx` or `.hono.mx` module, an Angular template) refuses every tag its host cannot express with one sentence, code `MX_UNSUPPORTED_CONSTRUCT`, positioned at the tag name:

> `<let>` is not supported in embedded MX on Preact. Use Preact's `useState` via `<const/x=useState(0)/>` or in the surrounding module.

The first sentence is the same on every host: the tag, then the host's name. The second sentence, when the host has one, says what to write instead. `<effect>` never has one. A region file gets the same first sentence as a whole file; its hint points at the surrounding component instead of `<const>`.

## A stateful tag under `strict`

If the project (or a `<let>`/`<lifecycle>`/etc. author) opted into the `strict` policy, using `<let>`, `<effect>`, `<lifecycle>`, `<script>`, a `client` block, or `<id>` on a host with no reactive target is a compile error naming the construct. The `input`-shadowing check below is not one of these six — it applies regardless of `strict`. See [Stateful tags](/language/stateful-tags/).

## `<await>` on the html target

The html target compiles to a plain `(input) => string` function with no notion of a pending value, so `<await>` is always an error there — this isn't a `strict`-only restriction, since there's no way to render a promise to a string synchronously.

## `<try>` with `<@placeholder>` on the html target

A `<try>` with only `<@catch>` compiles to an ordinary `try`/`catch`. Adding `<@placeholder>` needs a second render pass (show a placeholder, then swap in the real content once it resolves) that the html target's single-pass string output can't do.

## A binding named `input`

```html
<const/input=42/>
```

is rejected — it would shadow the parameter every compiled template function already has (`function (input) { ... }`), silently making the real input unreachable. This applies to `<let>`/`<const>` at the top level of a template.

A **tag param** named `input` is fine:

```html
<for|input| of=items>
  <p>${input.name}</p>
</for>
```

because a tag param opens a genuinely nested scope, the same way an ordinary JavaScript function parameter can legally shadow an outer variable.

## An attribute tag colliding with a prop

```html
<Card children="x">
  <@children>y</@children>
</Card>
```

is rejected: `<@children>` would silently overwrite the `children` prop (or an explicit attribute of the same name), and MX treats that as an error rather than "last writer wins." See [Attribute tags and tag params](/language/attribute-tags-and-params/) for the full table.

## Attribute-tag errors

These are the diagnostics introduced by the `AttrTag` contract. Names such as
`head`, `row`, and `Card` are substituted from the source; the wording shown is
the compiler's wording, not a summary.

### Declaration and call shape

| Message | Cause |
| --- | --- |
| `` `<@head>` may appear at most once (`head` is declared `AttrTag`, not `AttrTag[]`) `` | A singular property occurs more than once on a possible path. |
| `` `<@head>` may not appear inside `<for>` (`head` is declared `AttrTag`, not `AttrTag[]`) `` | A loop could produce more than one value for a singular property. |
| `` missing required attribute tag `<@head>` `` | `head: AttrTag` has no occurrence. |
| `` `<@head>` is required but not provided on every `<if>` path `` | A required singular is missing from at least one mutually exclusive branch, including the implicit empty branch when there is no final `<else>`. |
| `` `<Card>` declares no attribute tag `row` `` | A closed exported `Input` has no `row` property. |
| `` `row` is declared as a plain prop; declare it `AttrTag` to pass it as `<@row>` `` | `Input.row` exists but is not an `AttrTag`. |
| `` `<@row>` declares params in `<Card>`; add `|…|` `` | The config has a `params` tuple but the occurrence omits tag params. |
| `` `<@row>` declares no params in `<Card>`; remove `|…|` `` | The occurrence has tag params but the config does not. |
| `` `content` is reserved on an attribute tag; it names the body `` | Authored `content=` would collide with the compiler-created body property. |
| `Cannot have attribute tags and body content under a control flow tag.` | The same `<if>` or `<for>` body contains both named blocks and ordinary content. |
| `` `<@name>` is renderable in `<Owner>`; it can't take attributes `` | An `as: "renderable"` occurrence authors attributes. |
| `` `<@name>` is renderable in `<Owner>`; it can't take attributes or nested attribute tags `` | An `as: "renderable"` occurrence contains nested tags. |

### Reading and rendering the value

| Message | Cause |
| --- | --- |
| `` `input.head` is a data attribute tag; render its body with `<${input.head.content}/>` `` | A data object was used as a dynamic renderable. |
| `` `input.row.content` is a parameterized attribute tag; pass its arguments with `<${input.row.content(/* arguments */)}/>` `` | Parameterized data content was rendered without a call. |
| `` `input.row` is a parameterized attribute tag; pass its arguments with `<${input.row(/* arguments */)}/>` `` | A parameterized renderable was rendered without a call. |
| `MX: this value is a data attribute tag ({ ...attrs, content }); render its body with <${x.content}/>` | A data object reaches a dynamic renderer at runtime when its declaration was unavailable statically. |

### Reading the callee's `Input`

| Message | Cause |
| --- | --- |
| `declare this attribute tag's config literally` | The config needs type evaluation (for example a conditional, mapped, intersection, or non-literal `as`) instead of syntax MX can follow. It appears after the callee/property location prefix. |
| `attribute tag params must be a tuple type` | `params` is an open array such as `string[]`, not a tuple. |
| `renderable attribute tags can't take attributes; declare as: "data"` | One declaration combines `as: "renderable"` with `attrs`. |
| `` can't read `<Card>`'s Input (FILE:LINE:COLUMN): MESSAGE `` | The imported callee's `Input` cannot be parsed. |
| `` can't read `<Card>`'s declaration of `head` (FILE:LINE); MESSAGE `` | The used attribute-tag declaration is syntactically present but invalid. |

An unresolved import is a warning because the call can still use the syntactic
fallback: `` couldn't read `<Card>`'s Input (`@app/Card` not resolvable);
attribute-tag shape inferred from this call ``. Supply the tool's synchronous
`resolveImport` hook for aliases.

### Astro and Angular projection limits

The projection hosts reject shapes they cannot carry instead of dropping data.

| Message | Cause |
| --- | --- |
| `` array attribute tag `<@item>` isn't supported by @mxlang/host-astro: a slot is keyed by name `` | An Astro repeat, array declaration, or loop needs several values under one slot name. |
| `` attributes on `<@header>` aren't supported by @mxlang/host-astro: a slot carries markup, not data `` | An Astro slot has no attribute-data channel. |
| `` params on `<@header>` aren't supported by @mxlang/host-astro: a slot carries rendered markup, not a function `` | An Astro slot cannot call back into projected markup. |
| `` nested attribute tags inside `<@header>` aren't supported by @mxlang/host-astro: a slot is keyed by one name and has no nested data shape `` | An Astro slot cannot carry nested properties. |
| ``<@header/> has no body; @mxlang/host-astro projects attribute-tag bodies by name`` | An Astro slot has nothing to project. |
| `` array attribute tag `<@item>` isn't supported by @mxlang/host-angular: a projection is keyed by name `` | An Angular repeat, array declaration, or loop needs several values under one projection selector. |
| `` attributes on `<@header>` aren't supported by @mxlang/host-angular: a projection carries nodes, not data `` | Angular projection has no attribute-data channel. |
| `` params on `<@header>` aren't supported by @mxlang/host-angular: content projection cannot pass values back into projected nodes `` | `<ng-content>` cannot call back into projected nodes. |
| `` nested attribute tags inside `<@header>` aren't supported by @mxlang/host-angular: a projection has no nested data shape `` | Angular projection cannot carry nested properties. |
| ``<@header/> has no body; @mxlang/host-angular projects attribute-tag bodies by name`` | An Angular projection has nothing to place. |

Angular additionally reports
`` @mxlang/host-angular can't read projected content `header` as a value; render it
with <${input.header.content}/> `` for conditions, property reads, and
pass-throughs. Calling projected content with arguments reports
`` `input.header(…)` passes arguments to content, which Angular's content
projection cannot express: `<ng-content>` places the caller's nodes and cannot
pass them values. Declare the block as a `<define>` and pass it as an input the
component renders with `ngTemplateOutlet`. ``

The complete value shapes and legal render idioms are in the
[AttrTag guide](/language/attr-tag/).

## A `:` in an expression

`:name` has no meaning of its own in a `.mx` file: it is plain JavaScript, as in
Marko, and a leading `:` where an expression is expected is Marko's syntax
error, at the `:`:

```text
<a b=:x/>
1:5 Unexpected token
```

```text
<a b=x::y/>
1:6 Expected a single expression, but found `:` after it.
```

`::` inside a tag or attribute name is part of the name, as in Marko: `<a::b/>`
is the tag `a::b`.

### Atoms and the contract

Atoms are a dialect feature (see the [specification](/specification/), "`:name` in an expression"). When
a dialect builds them, core still checks a call's atom-versus-string shape, at
the value (an attribute-tag attribute at any depth is prefixed
`` `<box>`: `<@row>`: ``):

| Message | Cause |
| --- | --- |
| `` attribute `label` must be string, got atom `` | `label` is declared `string` and the value is an atom |
| `` attribute `kind` must be atom, got string `` | `kind` is declared `atom` and written `kind="title"`; in a list, the string item itself is the position. A dialect that claims contract keys may add its own wording after the message |

## `class:foo` and `style:foo`

```html
<div class:active=isActive></div>
```

isn't MX-specific syntax to avoid — it isn't Marko syntax at all. Marko's own parser rejects it before any host ever sees the template, with a fix-it suggesting the object form instead:

```html
<div class={active: isActive}></div>
```

There's no MX behavior to document here because no `.mx` file using the colon-modifier form compiles in the first place.

## An ambiguous `>` in an attribute value

A `>` preceded by whitespace ends the tag, so a comparison written bare in an attribute value splits the tag in a way you did not intend:

```html
<if=count > 9><p>double digits</p></if>
```

fails with *Ambiguous ">" in attribute*. Wrap the expression in parentheses:

```html
<if=(count > 9)><p>double digits</p></if>
```

The same applies to any attribute value, not only `<if>`. `<`, and a `>` with no space before it, are unambiguous and need no parentheses.
