# Known divergences

Deliberate, documented differences between `.solid.mx` and `twin.tsx` compiled
output. Each row means the oracle harness reports the diff as `divergent`
(not `fail`) for that fixture and variant.

| fixture | variant | reason |
|---|---|---|
| define-hoist | dom | A hoisted `<define>` is always gensym'd (`__mx_DefineRowN`), never the author's own name, the same rule `hoistedImports` already follows for a discovered tag's injected import (decision 110b) — so its compiled output can never byte-match a hand-written twin's natural function names. Semantically identical otherwise (verified by diff: only identifier spellings differ, on both Solid backends). |
| define-hoist | ssr-hydratable | Same reason as `define-hoist`/`dom`. |
