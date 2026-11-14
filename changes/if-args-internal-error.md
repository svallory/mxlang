---
packages: [core]
kind: Fixed
---
`lowerSource`: under `structural: "reject"` an `<if>` chain whose condition attribute has no value (`<else if(x)>`, `<else if>`) is one `MX_STRUCTURAL_CONSTRUCT`, no longer also an internal error ("IR invariant broken: `<if>` condition carries no span"); under `"pass"` or unset it lowers, the condition `true` carrying a zero-width span at the end of the attribute's name (as a bare colon name's `valueSpan` does). The same holds for an `<if>` head written `<if value>` and for an attribute-tag `<if>` chain.
