; Embedded-language injection for .solid.mx.
;
; The MX region is one opaque `mx_element` external token (see
; packages/editors/tree-sitter-solid/UPSTREAM.md "Deliberately NOT carried over") —
; the grammar gives it no interior structure, so there is nothing inside it
; for this grammar's own queries to capture. Injecting the `marko` language
; (MX and Marko share syntax; see notes/zed-plan.md decision 3)
; lets Zed re-parse that region with the `MX` grammar and highlight its
; actual contents — tag names, attributes, placeholders — instead of
; leaving it a single uncolored span.
((mx_element) @injection.content
 (#set! injection.language "marko"))
