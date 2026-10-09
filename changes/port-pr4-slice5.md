---
packages: [core]
kind: Changed
---
No behaviour change; lowering retyped to the MX AST for text, placeholders, comments and embedded payloads (parser port PR 4, slice 5): a placeholder's expression and a scriptlet's statements are read from their MX containers, and an MX comment's `kind` decides whether it is an HTML comment instead of re-reading its source. New, MX-path only: `payloadOf` unwraps a container and fails, positioned, on an expression trigger (decision 182, no lowering yet), on the container's parse error, or on a container with neither (an MX bug).
