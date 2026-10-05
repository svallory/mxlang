<!-- This is the 74-construct coverage baseline that packages/editors/tree-sitter-solid/test/corpus/*.txt is measured against. Copied verbatim from notes/zed/solidmx-corpus-checklist.md (see UPSTREAM.md "What the corpus is measured against"). -->

<!--
2026-09-13 re-audit (zed-solidmx-followups): this checklist predates decision
72's subset rule and is stale in two places the corpus itself must not follow:

- #33/#36: tag params on `<if>` (`<if=user()|u|>`) are REMOVED — decision 72
  removed tag params on `<if>` and attribute tags/tag params on native HTML
  elements as constructs real Marko itself rejects (see `divergences.md`
  "Deferred to MX 2"). `test/corpus/control-flow.txt` and the shared
  `.solid.mx` fixtures use `<if=cond()>` with no `|params|`.
- #50/#72/lowering-table `<fragment>`: REMOVED — decision 72 retired
  `<fragment>` entirely (it was the old `.mx` dialect's own construct, not
  real Marko). It does not come back for SolidMX or any other host.

The 4 stateful items (#56-59: `<let>`, `<const>`, `<effect>`, `:=`) are
confirmed still NON-GOAL for lowering (decision 69/72: stateful tags are
host errors), but the grammar itself parses them as ordinary tags/attributes
so the language server can still report the host error — verified against
`test/corpus/legacy-namespaces.txt` ("Legacy on: namespace scans as a
region" etc. cover the parse-as-ordinary-tag shape) and the whole-file
fixtures parsing cleanly with `<let>`/`<effect>`-shaped tag names present as
plain elements. No corpus regression: these constructs were never given
their own dedicated corpus case (there is no `<let>`/`<const>`/`<effect>`/
`:=` line in any `test/corpus/*.txt` file), so nothing to add — they already
fall out of the general "any unrecognized tag name scans as an ordinary MX
element" behavior every other tag exercises.

Everything else in this checklist (#1-32, #34-49, #51-71, #73) still matches
current SolidMX syntax and is exercised by `test/corpus/*.txt` and/or the
`.solid.mx` fixtures under `fixtures/`. Updated count: 74 valid constructs
in the original list minus the 2 removed above (`<fragment>` #50/#72, tag
params on `<if>` folded into #33/#36's still-valid non-`<if>` uses) = **72
constructs remain current**; the corpus does not have a dedicated case per
numbered entry (many entries share one corpus case), so "N/M covered" is not
tracked as a literal count — the differential test (Z25, `scripts/
differential.ts`) is the stronger guarantee: every fixture's tree-sitter
`mx_element` ranges are asserted byte-identical to `@mxlang/parser`'s own
region walk, not just "parses without ERROR/MISSING."
-->


# SolidMX Test Corpus Checklist
## Exhaustive Syntactic Constructs for Tree-sitter Coverage

This checklist covers every distinct syntactic construct in SolidMX (MX for Solid 2) from spec sections 3 and 4. Each entry specifies valid modes, exact syntax from spec, and minimal example.

---

## BASIC ELEMENTS & TEXT

### 1. HTML Element (intrinsic tag)
- **Name**: HTML element
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `<h1>Hello</h1>`
- **Example**: `<h1>Hello</h1>`
- **Notes**: Marko whitespace rules: whitespace-only text containing newline is dropped; without newline collapses to one space; leading/trailing at tag boundaries trimmed. `${" "}` is escape hatch.

### 2. Self-closing/void element
- **Name**: Self-closing element
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: Implied by depth counter in 3.3 ("non-self-closing `onOpenTagEnd`, decremented on `onCloseTagEnd`")
- **Example**: `<img src="x"/>`
- **Notes**: Depth counter detects via parser callbacks.

### 3. Text content (plain text)
- **Name**: Text content
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 2)**: "Everything else in the file is ordinary TypeScript."
- **Example**: `<div>Hello world</div>`
- **Notes**: Subject to whitespace rules (rule 1 above).

### 4. Text placeholder with `${}`
- **Name**: Text placeholder (expression interpolation)
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 2)**: "Text placeholders are `${expr}`. `{expr}` is not a placeholder (it is text), which is the one habit JSX users must drop"
- **Spec quote (section 4)**: `${title()}` → `{title()}`
- **Example**: `<div>${label()}</div>`
- **Notes**: Lowered to `{title()}` in JSX.

### 5. HTML-unsafe text placeholder with `$!{}`
- **Name**: HTML-unsafe placeholder (innerHTML)
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `$!{html}` → `innerHTML={html}` on parent when sole child, else `<span innerHTML={html}/>`
- **Example**: `<div>$!{rawHtml}</div>` or `$!{html}` as sole child
- **Notes**: Lowered to either `innerHTML` prop or wrapper span depending on position.

---

## ATTRIBUTES & PROPS

### 6. String attribute
- **Name**: String attribute
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `href="/x"` → `href="/x"`
- **Example**: `<a href="/home">Link</a>`
- **Notes**: Unchanged in lowering.

### 7. Expression attribute
- **Name**: Expression attribute (bare expression)
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 2)**: "Attribute values are Marko-style bare expressions: `href=url()`, `class={a: on()}`"
- **Spec quote (section 4)**: `href=url()` → `href={url()}`
- **Example**: `<a href=getUrl()>Link</a>`
- **Notes**: Parsed as TS expression; lowered to JSX `{...}` form. Values containing `>` or spaces must be parenthesized per Marko.

### 8. Boolean attribute (bare/valueless)
- **Name**: Boolean attribute
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `disabled` → `disabled={true}`
- **Example**: `<button disabled>Click</button>`
- **Notes**: Lowered to `{true}`.

### 9. Spread attribute
- **Name**: Spread attribute
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `...props` → `{...props}`
- **Example**: `<div ...attrs/>`
- **Notes**: Lowered to JSX spread form.

### 10. Class shorthand (dot notation, single)
- **Name**: Class shorthand
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `<div.card.big>` → `class="card big"`
- **Example**: `<div.card>Content</div>`
- **Notes**: Merges into `class`. If tag has both shorthand and explicit `class={}`, result is array form `class={["card big", {...}]}`.

### 11. Class shorthand with multiple classes
- **Name**: Multiple class shorthand
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `<div.card.big>` → `class="card big"`
- **Example**: `<div.card.big.active>Content</div>`
- **Notes**: Shorthand `.a.b.c` combines into space-separated string.

### 12. ID shorthand (hash notation)
- **Name**: ID shorthand
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: Implied by section 5.4 reference and general convention
- **Example**: `<div#main>Content</div>`
- **Notes**: Standard HTML shorthand; becomes `id` attribute.

### 13. Combined class and ID shorthand
- **Name**: Combined class and ID shorthand
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: Syntactic convention common in templating
- **Example**: `<div.card#main>Content</div>`
- **Notes**: Both shorthand syntaxes on same tag.

### 14. Class shorthand merged with explicit class object
- **Name**: Class shorthand + explicit class object
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: "With an explicit object `class={}` on the same tag, the result is the array form `class={["card big", {...}]}`"
- **Example**: `<div.card class={active: on()}>Content</div>`
- **Notes**: Lowered to array form for Solid 2.

### 15. Object-literal class attribute
- **Name**: Object-literal class
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `class={active: on()}` → `class={{active: on()}}`
- **Example**: `<div class={active: isActive()}>Content</div>`
- **Notes**: Object literal stays as `class` (no `classList` in Solid 2).

### 16. Style attribute
- **Name**: Style object
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `style={color: c()}` → `style={{color: c()}}`
- **Example**: `<div style={color: textColor()}>Content</div>`
- **Notes**: Unchanged from spec.

### 17. Event handler (bare reference)
- **Name**: Event handler reference
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `onClick=inc` → `onClick={inc}`
- **Example**: `<button onClick=handleClick>Click</button>`
- **Notes**: Lowered to JSX form.

### 18. Attribute method (block body)
- **Name**: Attribute method
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 2)**: "MX nests inside attr-method bodies (`onClick() { return <div/> }`) with no special casing."
- **Spec quote (section 4)**: `onClick(e) { inc(e) }` → `onClick={(e) => { inc(e) }}`
- **Example**: `<button onClick(e) { handleClick(e) }>Click</button>`
- **Notes**: Block body never unwrapped to expression. Can contain MX.

### 19. Property namespace (surviving namespace in Solid 2)
- **Name**: Property namespace `prop:`
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `prop:value=v` → `prop:value={v}`
- **Example**: `<Component prop:myprop=value/>`
- **Notes**: **Only surviving namespace** in Solid 2.

### 20. Legacy `on:` namespace (parse error)
- **Name**: `on:` namespace (INVALID)
- **Valid in**: **NOT VALID in `.solid.mx`** — **PARSE ERROR**
- **Spec quote (section 4)**: "`on:scroll=fn`, `oncapture:click=fn`, `attr:x=y`, `bool:open=o` | — | **Parse error** in MX for Solid 2."
- **Example**: ~~`<div on:scroll=handler/>`~~ → Parse error
- **Fix-it**: "→ fix-it to `onX` (delegated) or a `ref` callback with `addEventListener` (non-delegated/capture)"
- **Notes**: Marko/Svelte syntax not supported.

### 21. Legacy `oncapture:` namespace (parse error)
- **Name**: `oncapture:` namespace (INVALID)
- **Valid in**: **NOT VALID in `.solid.mx`** — **PARSE ERROR**
- **Spec quote (section 4)**: "(`oncapture:click=fn`, ...)"
- **Example**: ~~`<div oncapture:click=handler/>`~~ → Parse error
- **Fix-it**: "→ fix-it to `onX` (delegated) or a `ref` callback with `addEventListener` (non-delegated/capture)"
- **Notes**: Capture handling now via ref callbacks.

### 22. Legacy `attr:` namespace (parse error)
- **Name**: `attr:` namespace (INVALID)
- **Valid in**: **NOT VALID in `.solid.mx`** — **PARSE ERROR**
- **Spec quote (section 4)**: "`attr:x=y`, ..."
- **Example**: ~~`<div attr:data-x=value/>`~~ → Parse error
- **Fix-it**: "→ fix-it to a plain attribute (Solid 2's default attribute behavior already does what these namespaces did in 1.x)"
- **Notes**: Attributes are now default in Solid 2.

### 23. Legacy `bool:` namespace (parse error)
- **Name**: `bool:` namespace (INVALID)
- **Valid in**: **NOT VALID in `.solid.mx`** — **PARSE ERROR**
- **Spec quote (section 4)**: "`bool:open=o`"
- **Example**: ~~`<div bool:open=isOpen/>`~~ → Parse error
- **Fix-it**: "→ fix-it to a plain attribute (Solid 2's default attribute behavior already does what these namespaces did in 1.x)"
- **Notes**: Properties are now default in Solid 2.

### 24. Legacy `use:` directive (parse error)
- **Name**: `use:` directive (INVALID)
- **Valid in**: **NOT VALID in `.solid.mx`** — **PARSE ERROR**
- **Spec quote (section 4)**: "`use:tooltip=opts` | — | **Parse error** in MX for Solid 2."
- **Example**: ~~`<div use:tooltip={opts}/>`~~ → Parse error
- **Fix-it**: "Fix-it: `ref=tooltip(opts)` (directives are now plain functions returning a ref callback, composed via the existing `ref={[a, b(x)]}` array form)"
- **Notes**: Directives are now via ref callbacks.

### 25. Ref attribute
- **Name**: Ref attribute
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `ref=el` → `ref={el}`
- **Example**: `<div ref=containerEl>Content</div>`
- **Notes**: Unchanged. Tag var `<div/el>` is v2 feature.

---

## COMPONENTS & DYNAMIC

### 26. PascalCase component (identifier dispatch)
- **Name**: PascalCase component reference
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `<Card title="x"/>` → `<Card title="x"/>`
- **Example**: `<Card title="x"/>`
- **Notes**: PascalCase = identifier in scope; unbound builtins (`For Show Switch Match Loading Reveal Portal Repeat Dynamic Errored`) auto-imported.

### 27. Component children (text and elements)
- **Name**: Component children
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `<Card>${x}</Card>` → `<Card>{x}</Card>`
- **Example**: `<Card>Hello {name}</Card>`
- **Notes**: Children become props.

### 28. Dynamic component (runtime tag name)
- **Name**: Dynamic component
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `<${comp()} ...p/>` → `<Dynamic component={comp()} {...p}/>`
- **Example**: `<${getComponent()} ...attrs/>`
- **Notes**: Lowered to `Dynamic` component from Solid 2.

---

## ATTRIBUTE TAGS (Named Blocks / JSX-valued Props)

### 29. Attribute tag (simple, no params)
- **Name**: Attribute tag
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `<Layout><@header><Nav/></@header>…</Layout>` → `<Layout header={<Nav/>}>…</Layout>`
- **Example**: `<Layout><@header><Nav/></@header></Layout>`
- **Notes**: JSX-valued prop, not attribute expression. `fallback=<Spin/>` is syntax error with fix-it.

### 30. Attribute tag with params (render prop)
- **Name**: Attribute tag with params
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `<@row|x|><li>${x.name}</li></@row>` → `row={(x) => <li>{x.name}</li>}`
- **Example**: `<Layout><@row|item|><li>${item.name}</li></@row></Layout>`
- **Notes**: Tag params become function parameters.

### 31. Repeated attribute tag
- **Name**: Repeated attribute tag (multiple instances)
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: "repeated `<@tab>` | `tab={[…, …]}`"
- **Example**: `<Tabs><@tab>Tab 1</@tab><@tab>Tab 2</@tab></Tabs>`
- **Notes**: Multiple attribute tags with same name become array.

### 32. Attribute tag syntax error (JSX-valued prop via attribute expression)
- **Name**: JSX-valued prop as expression (INVALID syntax)
- **Valid in**: **NOT VALID** — **PARSE ERROR**
- **Spec quote (section 2)**: "JSX-valued props are attribute tags (`<@header>`), not attribute expressions. `fallback=<Spin/>` is a syntax error with a fix-it to `<@fallback>`."
- **Example**: ~~`<Show fallback=<Spin/>/>`~~ → Parse error, fix to `<@fallback><Spin/></@fallback>`
- **Notes**: Must use attribute tag syntax for JSX values.

---

## TAG PARAMS

### 33. Tag params (in control flow tags)
- **Name**: Tag params
- **Valid in**: `.solid.mx`, expression-position (in `<if>`, `<for>`, `<@slot>`)
- **Spec quote (section 2)**: "Tag params (`|item, i|`) take the shape the lowering table gives them (section 5.2). Types flow from Solid's own definitions through the virtual file..."
- **Example**: `<for|item, i| of=items>...` or `<if=user()|u|>...`
- **Notes**: Types depend on lowered Solid primitive; hover shows correct type (Accessor or direct value).

### 34. Tag params with destructuring (in `<for in>`)
- **Name**: Tag params with destructuring
- **Valid in**: `.solid.mx`, expression-position (in `<for in>`)
- **Spec quote (section 5.2)**: `<for|k, v| in=obj()>` → `<For each={Object.entries(obj())} keyed={e => e[0]}>{([k, v]) => …}</For>`
- **Example**: `<for|k, v| in=obj()>...`
- **Notes**: Params destructure tuple from `Object.entries`.

---

## CONTROL FLOW TAGS

### 35. `<if>` condition tag (basic)
- **Name**: `<if>` tag
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.1)**: ```
<if=user()|u|>              <Show when={user()} fallback={
  <p>${u().name}</p>          <Show when={loading()} fallback={<Login/>}><Spin/></Show>}>
</if>                         {(u) => <p>{u().name}</p>}
<else if=loading()>         </Show>
  <Spin/>
</else>
<else><Login/></else>
```
- **Example**: `<if=condition()><p>True</p></if>`
- **Notes**: Attr form only. Lowers to `<Show>`.

### 36. `<if>` with params (narrowing callback)
- **Name**: `<if>` with params
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.1)**: "`|u|` selects the narrowing callback form (`u` is `Accessor<NonNullable<T>>`, `Show`'s non-keyed/default shape, unchanged in Solid 2); without params children are inlined."
- **Example**: `<if=user()|u|><p>${u().name}</p></if>`
- **Notes**: Param type is `Accessor<NonNullable<T>>`.

### 37. `<else if>` tag
- **Name**: `<else if>` tag
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.1)**: "Chain lowers to nested `<Show>` via `fallback`; two or more `else if` lower to `<Switch>/<Match>`."
- **Example**: `<if=x()>A</if><else if=y()>B</else if>`
- **Notes**: Chain of if/else if becomes nested Show or Switch.

### 38. `<else>` tag
- **Name**: `<else>` tag
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.1)**: Shown in example above
- **Example**: `<if=x()>A</if><else>B</else>`
- **Notes**: Final fallback in if-chain.

### 39. `<for>` with `of=` and no `by=` (unkeyed)
- **Name**: `<for>` unkeyed iteration
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.2)**: `<for|it, i| of=xs()>` → `<For each={xs()}>{(it, i) => …}</For>`
- **Example**: `<for|item, i| of=items()><li>${item.name}</li></for>`
- **Notes**: No `keyed` prop (Solid's default keyed-by-reference form; see `packages/hosts/solid/README.md` "`<for>` binds the row as a value, not an accessor" — decision `solid-for-accessor`, 2026-09-15). Param types: `it: T`, `i: Accessor<number>`.

### 40. `<for>` with `of=` and `by=` (identity-keyed)
- **Name**: `<for>` identity-keyed iteration
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.2)**: `<for|it, i| of=xs() by=identity>` → `<For each={xs()}>{(it, i) => …}</For>`
- **Example**: `<for|item, i| of=items() by=identity><li>${item.id}</li></for>`
- **Notes**: Identical lowering to row 39 (no `keyed` prop); `by=identity` names the same default explicitly. Param types: `it: T`, `i: Accessor<number>`.

### 41. `<for>` with `of=` and `by="fieldname"` (property-keyed)
- **Name**: `<for>` property-keyed iteration
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.2)**: `<for|it, i| of=xs() by="id">` / `by=(x => x.id)` → `<For each={xs()} keyed={x => x.id}>{(it, i) => …}</For>`
- **Example**: `<for|item, i| of=items() by="id"><li>${item().name}</li></for>`
- **Notes**: String shorthand for property access (`x.id`). Solid's `keyed={fn}` overload hands both args as accessors (unlike the default/`by=identity` forms above), so the body must call `item()`. Param types: `it: Accessor<T>`, `i: Accessor<number>`.

### 42. `<for>` with `of=` and `by=function` (custom keying)
- **Name**: `<for>` custom-keyed iteration
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.2)**: "`by=(x => x.id)`" version of above
- **Example**: `<for|item, i| of=items() by=item => item.userId><li>${item().userId}</li></for>`
- **Notes**: Function expression for key selection; `item` is an accessor, same as row 41. Param types: `it: Accessor<T>`, `i: Accessor<number>`.

### 43. `<for>` with `from=` and `to=` (inclusive range)
- **Name**: `<for>` inclusive range
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.2)**: `<for|i| from=0 to=n()>` → `<Repeat count={n()} from={0}>{(i) => …}</Repeat>`
- **Example**: `<for|i| from=0 to=10><p>${i()}</p></for>`
- **Notes**: `to=` is inclusive. Lowers to `Repeat`. Param type: `i: number`.

### 44. `<for>` with `from=` and `until=` (exclusive range)
- **Name**: `<for>` exclusive range
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.2)**: "`until=` is exclusive; both map to `Repeat`'s `count` by computing the iteration count from `from`/`to` or `from`/`until` at lowering time (`count = to - from + 1` or `count = until - from`)."
- **Example**: `<for|i| from=0 until=n()><p>${i()}</p></for>`
- **Notes**: `until=` is exclusive. Param type: `i: number`.

### 45. `<for>` with `in=` (object key-value iteration)
- **Name**: `<for>` object iteration
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.2)**: `<for|k, v| in=obj()>` → `<For each={Object.entries(obj())} keyed={e => e[0]}>{([k, v]) => …}</For>`
- **Example**: `<for|key, val| in=obj()><p>${key}: ${val()}</p></for>`
- **Notes**: Destructured tuple from `Object.entries`. Param types: destructured `[k, v]`.

### 46. `<for>` with invalid `step=` attribute (parse error)
- **Name**: `<for>` with `step=` (INVALID)
- **Valid in**: **NOT VALID in `.solid.mx`** — **PARSE ERROR**
- **Spec quote (section 5.2)**: "`step=` has no `Repeat` equivalent (`Repeat`'s index is a plain incrementing number, `from` to `from + count - 1`, step fixed at 1). `step=` is **unsupported in v1**: a parse error, since `Repeat` has no way to express a stride."
- **Example**: ~~`<for|i| from=0 to=100 step=5>...`~~ → Parse error
- **Notes**: Not supported; revisit for v2 if user feedback requests it.

### 47. `<try>` error boundary tag
- **Name**: `<try>` tag
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 5.3)**: "`<try><@placeholder>…</@placeholder><@catch|e, reset|>…</@catch>…</try>` lowers to `<Errored fallback={(e, reset) => …}><Loading fallback={…}>…</Loading></Errored>`."
- **Example**: `<try><@placeholder>Loading...</@placeholder><@catch|e|>Error: ${e}</@catch></try>`
- **Notes**: Lowers to `Errored` + `Loading`. `@catch` params: `e` (error), optional `reset: () => void`.

### 48. `<try>` with `<@placeholder>` (loading fallback)
- **Name**: `<try>` placeholder block
- **Valid in**: `.solid.mx`, expression-position (inside `<try>`)
- **Spec quote (section 5.3)**: "Shown above"
- **Example**: `<try><@placeholder>Loading...</@placeholder>...</try>`
- **Notes**: Attribute tag inside `<try>`. Maps to `Loading`'s `fallback`.

### 49. `<try>` with `<@catch>` (error handler)
- **Name**: `<try>` catch block
- **Valid in**: `.solid.mx`, expression-position (inside `<try>`)
- **Spec quote (section 5.3)**: "`<@catch|e, reset|>` may take the second `reset: () => void` parameter now exposed by `Errored`'s fallback signature; a one-param `<@catch|e|>` remains valid"
- **Example**: `<try><@catch|e, reset|>Error: ${e}</@catch></try>`
- **Notes**: Second param `reset` is optional. Lowers to `Errored` fallback.

### 50. `<fragment>` tag (multiple roots)
- **Name**: `<fragment>` tag
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: `<fragment>…</fragment>` → `<>…</>`
- **Example**: `<fragment><div>A</div><div>B</div></fragment>`
- **Notes**: Lowers to JSX fragment `<>`.

---

## COMMENTS

### 51. Line comment inside MX
- **Name**: Line comment
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 2)**: "Comments: `// note` on its own line and `<!-- note -->` inside MX; both dropped from output."
- **Example**: `<div><!-- This is a comment --></div>`
- **Notes**: Dropped from output.

### 52. HTML comment inside MX
- **Name**: HTML comment
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 2)**: "Comments: `// note` on its own line and `<!-- note -->` inside MX; both dropped from output."
- **Example**: `<div><!-- This is a comment --></div>`
- **Notes**: Dropped from output.

---

## NESTING: MX in TS Expressions

### 53. MX nested inside attribute method body
- **Name**: MX in attribute method
- **Valid in**: `.solid.mx`, expression-position (inside attr method block)
- **Spec quote (section 2)**: "They are TypeScript, parsed by the same parser instance, so MX nests inside attr-method bodies (`onClick() { return <div/> }`) with no special casing."
- **Example**: `<button onClick() { return <div>Clicked</div> }>Click</button>`
- **Notes**: One level of nesting (MX in TS expression in MX). Parser uses same instance, handles sub-parsing at expression ranges.

### 54. TS expression inside MX placeholder
- **Name**: TS expression in placeholder
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 2, 3.3)**: "Each expression range from `htmljs-parser` ... is parsed with the same parser instance on a sub-tokenizer at that range, so nested MX inside expressions works."
- **Example**: `<div>${items().map(i => <li>${i.name}</li>)}</div>`
- **Notes**: TS expression (arrow function) inside placeholder can contain MX. One level described in spec.

### 55. Nesting depth specification
- **Name**: Nesting depth limit
- **Valid in**: Described in section 3.2, 3.3
- **Spec quote (section 3.3)**: "Each expression range from `htmljs-parser` (`onAttrValue`, `onAttrArgs`, `onAttrMethod`, `onTagParams`, `onPlaceholder`, dynamic tag name) is parsed with the same parser instance on a sub-tokenizer at that range, so nested MX inside expressions works."
- **Notes**: **Spec does not formally describe nesting depth limit.** Nesting is possible (MX → TS expression → MX), but no explicit depth constraint is stated. Parser uses recursive sub-tokenization for each expression range.

---

## SOLID 2 REACTIVE CONSTRUCTS

Note: The following are mentioned in spec section 1 as non-goals for v1 (possible v2 features). They are **NOT valid in v1 `.solid.mx`**:

### 56. `<let>` reactive tag (NON-GOAL for v1)
- **Name**: `<let>` tag (v2 feature, NOT v1)
- **Valid in**: **NOT VALID in v1 `.solid.mx`**
- **Spec quote (section 1)**: "Marko's reactive tags (`<let>`, `<const>`, `<effect>`, `:=`) and implicit accessors. ... Possible v2, evaluated after v1 ships."
- **Notes**: Deferred to v2. Expressions are plain TS in v1; state uses Solid primitives.

### 57. `<const>` reactive tag (NON-GOAL for v1)
- **Name**: `<const>` tag (v2 feature, NOT v1)
- **Valid in**: **NOT VALID in v1 `.solid.mx`**
- **Spec quote (section 1)**: Same as above
- **Notes**: Deferred to v2.

### 58. `<effect>` reactive tag (NON-GOAL for v1)
- **Name**: `<effect>` tag (v2 feature, NOT v1)
- **Valid in**: **NOT VALID in v1 `.solid.mx`**
- **Spec quote (section 1)**: Same as above
- **Notes**: Deferred to v2.

### 59. `:=` binding (reactive binding, NON-GOAL for v1)
- **Name**: `:=` binding (v2 feature, NOT v1)
- **Valid in**: **NOT VALID in v1 `.solid.mx`**
- **Spec quote (section 1)**: Same as above
- **Notes**: Deferred to v2.

---

## SOLID 2 AUTO-IMPORTS (Builtins)

### 60. Auto-imported builtins list
- **Name**: Solid 2 auto-imported components
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 3.1)**: "`builtIns` auto-import is confirmed identical in both `@solidjs/compiler` and `@solidjs/babel-plugin`: `For Show Switch Match Loading Reveal Portal Repeat Dynamic Errored`."
- **Notes**: These 9 components are auto-imported by Solid 2's compilers. MX lowering uses `For`, `Repeat`, `Show`, `Switch`, `Match`, `Errored`, `Loading`, `Reveal` in lowered output; no runtime helpers (`Key`, `mxRange`) needed.

### 61. Component not in builtins list (must be imported or bound)
- **Name**: Non-builtin component reference
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: "PascalCase = identifier in scope; unbound builtins (list) auto-imported identically"
- **Example**: `<MyComponent/>`
- **Notes**: Must be in scope (imported). If unbound and not in builtins list, it's a TS error (not a parse error).

---

## WHITESPACE & EDGE CASES

### 62. Whitespace-only text run with newline
- **Name**: Whitespace normalization (newline case)
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: "Marko whitespace rules: a whitespace-only text run containing a newline is dropped"
- **Example**: 
```
<div>
  
</div>
```
- **Notes**: The blank line inside `<div>...</div>` is dropped.

### 63. Whitespace-only text run without newline
- **Name**: Whitespace normalization (space case)
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: "a whitespace-only run without a newline collapses to one space"
- **Example**: `<div>   </div>` → `<div> </div>`
- **Notes**: Multiple spaces collapse to single space.

### 64. Leading/trailing whitespace at tag boundaries
- **Name**: Whitespace trimming at tag boundaries
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: "leading/trailing runs at tag boundaries are trimmed"
- **Example**: `<div>  text  </div>` → `<div>text</div>`
- **Notes**: Trimmed by Marko rules.

### 65. Escaped space in text (`${" "}`)
- **Name**: Preserved space escape
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4)**: "`${" "}` is the escape hatch"
- **Example**: `<div>${" "}</div>`
- **Notes**: Placeholder form preserves space that would otherwise be normalized.

---

## SYNTAX ERRORS & DIAGNOSTICS

### 66. Unbound PascalCase identifier (TS error, not parse error)
- **Name**: Unbound component reference
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 4, implied)**: "PascalCase = identifier in scope"
- **Example**: `<UnknownComponent/>` (if not imported)
- **Notes**: Triggers TS error "Cannot find name 'UnknownComponent'", not a parse error.

### 67. Brace placeholder error (`{expr}` as text, ESLint detection)
- **Name**: Brace placeholder (incorrect syntax)
- **Valid in**: `.solid.mx`, expression-position (but should be flagged)
- **Spec quote (section 2)**: "`{expr}` is not a placeholder (it is text), which is the one habit JSX users must drop; the ESLint rule `mx/no-brace-placeholder` flags a `{`...`}` text run that parses as an expression."
- **Example**: `<div>{label()}</div>` → Treated as literal text `{label()}`, caught by `mx/no-brace-placeholder` rule
- **Notes**: ESLint rule flags this as likely error.

### 68. JSX-valued prop as expression (syntax error with fix-it)
- **Name**: Fallback attribute as expression (PARSE ERROR)
- **Valid in**: **NOT VALID** — **PARSE ERROR**
- **Spec quote (section 2)**: "`fallback=<Spin/>` is a syntax error with a fix-it to `<@fallback>`."
- **Example**: ~~`<Show fallback=<Spin/>/>`~~ → Parse error, fix to `<@fallback><Spin/></@fallback>`
- **Notes**: JSX-valued props must use attribute tag syntax.

---

## FILE STRUCTURE & INTEGRATION

### 69. `.solid.mx` file extension
- **Name**: File extension
- **Valid in**: File level
- **Spec quote (section 2)**: "File extension: `.solid.mx` (target-keyed; host language TS is implied)"
- **Example**: `Card.solid.mx`
- **Notes**: Target suffix (`.solid`) + language suffix (`.mx`).

### 70. TS context in `.solid.mx` file
- **Name**: TypeScript host language
- **Valid in**: File level (everything outside MX)
- **Spec quote (section 3)**: "MX is Marko syntax in JSX's position: a grammar extension of TypeScript that starts at `<` in expression position and ends at the root tag's closing tag. Everything else in the file is ordinary TypeScript."
- **Example**: 
```ts
import { createSignal } from "solid-js";
export default function Card() {
  const [open, setOpen] = createSignal(false);
  return <div.card>...</div>;
}
```
- **Notes**: TS grammar applies everywhere; MX is local to `<` start position.

### 71. One root tag per MX expression
- **Name**: Single root tag rule
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 2)**: "One root tag per MX expression, like JSX. Adjacent roots need a wrapper or the `<fragment>` tag (lowers to `<>`)."
- **Example**: `<div>A</div><div>B</div>` → Parse error; must wrap or use `<fragment>`
- **Notes**: Same rule as JSX.

### 72. Multiple roots via `<fragment>`
- **Name**: Fragment for multiple roots
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 2, 4)**: "`<fragment>` tag (lowers to `<>`)"
- **Example**: `<fragment><div>A</div><div>B</div></fragment>`
- **Notes**: Workaround for single-root constraint.

### 73. Generic type disambiguation (`<T,>(x: T) => x` pattern)
- **Name**: `.tsx` generic disambiguation
- **Valid in**: `.solid.mx`, expression-position
- **Spec quote (section 2)**: "MX starts at `<` in expression position, exactly where JSX would. The `.tsx` disambiguation rules for generics apply unchanged (`<T,>(x: T) => x`)."
- **Example**: `const f = <T,>(x: T) => x; return <div>{f(1)}</div>;`
- **Notes**: TS's own rule prevents generic `<T>` from being misparsed as JSX `<T>`.

---

## LOWERING TABLE ENTRIES (Summary)

### Reference entries (section 4, table form)

The following are summarized from the lowering table. Each is a separate syntactic construct:

74-88: [Already covered above by individual entries]

- Plain HTML element: `<h1>Hello</h1>` → `<h1>Hello</h1>`
- Text placeholder: `${title()}` → `{title()}`
- Unsafe HTML: `$!{html}` → `innerHTML={html}` or `<span innerHTML={html}/>`
- String attr: `href="/x"` → `href="/x"`
- Expression attr: `href=url()` → `href={url()}`
- Boolean attr: `disabled` → `disabled={true}`
- Spread: `...props` → `{...props}`
- Class shorthand: `<div.card.big>` → `class="card big"`
- Class object: `class={active: on()}` → `class={{active: on()}}`
- Style: `style={color: c()}` → `style={{color: c()}}`
- Event bare: `onClick=inc` → `onClick={inc}`
- Event method: `onClick(e) { inc(e) }` → `onClick={(e) => { inc(e) }}`
- Prop namespace: `prop:value=v` → `prop:value={v}`
- Component: `<Card title="x"/>` → `<Card title="x"/>`
- Component children: `<Card>${x}</Card>` → `<Card>{x}</Card>`
- Dynamic: `<${comp()} ...p/>` → `<Dynamic component={comp()} {...p}/>`
- Attribute tag: `<Layout><@header><Nav/></@header></Layout>` → `<Layout header={<Nav/>}></Layout>`
- Attribute tag with params: `<@row|x|><li>${x.name}</li></@row>` → `row={(x) => <li>{x.name}</li>}`
- Repeated attr tag: multiple `<@tab>` → `tab={[…, …]}`
- Fragment: `<fragment>…</fragment>` → `<>…</>`

---

## SUMMARY TABLE: Valid Constructs by Mode

| Construct | .solid.mx | Expression Position | Notes |
|-----------|-----------|---------------------|-------|
| HTML element | ✓ | ✓ | Plain tags, self-closing |
| Text content | ✓ | ✓ | Subject to whitespace rules |
| `${}` placeholder | ✓ | ✓ | Lowers to JSX `{}` |
| `$!{}` unsafe HTML | ✓ | ✓ | innerHTML or wrapper span |
| String attribute | ✓ | ✓ | Unchanged |
| Expression attribute | ✓ | ✓ | Bare TS expression |
| Boolean attribute | ✓ | ✓ | Valueless; lowered to `true` |
| Spread attribute | ✓ | ✓ | `...obj` form |
| Class shorthand | ✓ | ✓ | `.a.b` form |
| ID shorthand | ✓ | ✓ | `#id` form |
| Object class | ✓ | ✓ | `class={...}` |
| Event handler | ✓ | ✓ | `onClick=fn` or `onClick() {}`  |
| Attribute method | ✓ | ✓ | Block body; can contain MX |
| Prop namespace | ✓ | ✓ | `prop:` only |
| `on:` namespace | ✗ | ✗ | Parse error |
| `oncapture:` namespace | ✗ | ✗ | Parse error |
| `attr:` namespace | ✗ | ✗ | Parse error |
| `bool:` namespace | ✗ | ✗ | Parse error |
| `use:` directive | ✗ | ✗ | Parse error |
| Ref attribute | ✓ | ✓ | Unchanged |
| PascalCase component | ✓ | ✓ | Identifier or builtin |
| Dynamic component | ✓ | ✓ | `<${}/>` lowers to `Dynamic` |
| Attribute tag | ✓ | ✓ | `<@name>` JSX-valued prop |
| Attribute tag params | ✓ | ✓ | `<@name\|x\|>` render prop |
| `<if>` tag | ✓ | ✓ | Conditional; lowers to `Show` |
| `<else if>` tag | ✓ | ✓ | Chain; nested `Show` or `Switch` |
| `<else>` tag | ✓ | ✓ | Fallback in if-chain |
| `<for of>` unkeyed | ✓ | ✓ | `keyed={false}` |
| `<for of by=identity>` | ✓ | ✓ | `keyed=true` (default) |
| `<for of by="field">` | ✓ | ✓ | `keyed={x => x.field}` |
| `<for of by=fn>` | ✓ | ✓ | Custom key function |
| `<for from= to=>` | ✓ | ✓ | Inclusive; lowers to `Repeat` |
| `<for from= until=>` | ✓ | ✓ | Exclusive; lowers to `Repeat` |
| `<for in=>` | ✓ | ✓ | Object iteration; `Object.entries` |
| `<for step=>` | ✗ | ✗ | Parse error (unsupported v1) |
| `<try>` tag | ✓ | ✓ | Error boundary; `Errored`+`Loading` |
| `<@catch>` | ✓ | ✓ | Inside `<try>`; error handler |
| `<@placeholder>` | ✓ | ✓ | Inside `<try>`; loading state |
| `<fragment>` | ✓ | ✓ | Multiple roots; lowers to `<>` |
| HTML comment | ✓ | ✓ | Dropped from output |
| Line comment | ✓ | ✓ | Dropped from output |
| MX in attr method | ✓ | ✓ | Nested in TS expression block |
| TS expr in placeholder | ✓ | ✓ | Nested in MX placeholder |
| `<let>` tag | ✓ | ✓ | Parses as ordinary tag (NON-GOAL for SolidMX) |
| `<const>` tag | ✓ | ✓ | Parses as ordinary tag (NON-GOAL for SolidMX) |
| `<effect>` tag | ✓ | ✓ | Parses as ordinary tag (NON-GOAL for SolidMX) |
| `:=` binding | ✓ | ✓ | Parses as ordinary attribute (NON-GOAL for SolidMX) |

---

## NESTING DEPTH: Formal Spec Statement

**From section 3.3:**

> "Each expression range from `htmljs-parser` (`onAttrValue`, `onAttrArgs`, `onAttrMethod`, `onTagParams`, `onPlaceholder`, dynamic tag name) is parsed with the same parser instance on a sub-tokenizer at that range, so nested MX inside expressions works."

**Conclusion:** The spec describes **one level of documented nesting** (MX → TS expression → MX), but **does not formally constrain nesting depth**. The parser recursively handles sub-expression parsing, implying arbitrary depth is theoretically possible, though not explicitly tested or specified.

---

## PARSE ERRORS vs. SEMANTIC ERRORS

**Parse Errors (syntax not recognized):**
- `on:`, `oncapture:`, `attr:`, `bool:`, `use:` namespaces
- `step=` attribute in `<for>`
- JSX-valued prop as expression (must use attribute tag syntax)
- Multiple root tags without wrapper or `<fragment>`

**Semantic/Type Errors (valid syntax, runtime/type problem):**
- Unbound PascalCase component (TS "Cannot find name" error)
- Misuse of `{expr}` instead of `${expr}` in text (flagged by ESLint, not parser)

---

## SPEC GAPS & OPEN QUESTIONS (Section 11 summary)

Not enumerated as checklist items, but relevant:

1. `Reveal` sugar: **decided no for v1**
2. `step=` on `<for>` ranges: **decided parse error for v1**
3. `use:` ergonomics: **decided parse error for v1** (with fix-it hint)
4. HMR preservation rules: **unverified**
5. `eslint-plugin-solid` Solid 2.0 status: **unknown**
6. Reactive tags (`<let>`, `<const>`, `<effect>`, `:=`): **deferred to v2**

---

## FINAL CHECKLIST COUNT

**Total distinct syntactic constructs catalogued: 89**

- **Valid constructs: ~74**
- **Parse errors (invalid in v1): ~10**
- **Non-goals/v2 features: ~1**
- **Integration/file-level: ~4**

