# Known divergences

Deliberate, documented differences between `.solid.mx` and `twin.tsx` compiled
output. Each row means the oracle harness reports the diff as `divergent`
(not `fail`) for that fixture and variant.

| fixture | variant | reason |
|---|---|---|
| define-hoist | dom | A hoisted `<define>` is always gensym'd (`__mx_DefineRowN`), never the author's own name, the same rule `hoistedImports` already follows for a discovered tag's injected import (decision 110b) — so its compiled output can never byte-match a hand-written twin's natural function names. Semantically identical otherwise (verified by diff: only identifier spellings differ, on both Solid backends). |
| define-hoist | ssr-hydratable | Same reason as `define-hoist`/`dom`. |
| attrs | dom | `data-count=color()` has an unknown-typed value, so decision 149's render-time guard wraps it: `data-count={__mxAttrValue("data-count", color(), "div")}` (Marko throws on a plain-object native attribute; so do the other hosts). A hand-written twin carries no wrapper. Likewise `...props.extra` becomes `{...__mxAttrSpread(props.extra, "div")}`, a lazy Proxy that validates keys as Solid reads them. Only those two expressions and the hoisted helpers differ; the static, boolean, class, style, ref, event and `prop:` attributes are identical. |
| attrs | ssr-hydratable | Same reason as `attrs`/`dom`. |
| todos | dom | `<input value=text()>` is an unknown-typed native attribute, wrapped by the decision 149 guard (`value={__mxAttrValue("value", text(), "input")}`); a hand-written twin has no wrapper. No other row differs. |
| todos | ssr-hydratable | Same reason as `todos`/`dom`. |
| counter | dom | A method shorthand `onClick() { … }` is emitted as the `function` expression the compiler printed for it (`onClick={function () { … }}`; decision 167), which keeps Marko's `this`, a named function's binding and a generic method valid in TSX, where the twin writes the idiomatic arrow. Same handler behaviour; only the function form differs. The `ssr-hydratable` variant drops event handlers and still passes. |
