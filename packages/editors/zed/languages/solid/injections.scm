; Embedded-language injection for .solid.mx.
;
; The MX region is one opaque `mx_element` external token (see
; packages/editors/tree-sitter-solid/UPSTREAM.md "Deliberately NOT carried over") —
; the grammar gives it no interior structure, so there is nothing inside it
; for this grammar's own queries to capture. Injecting this extension's own
; `MX` language (languages/mx, the tree-sitter-mx grammar) lets Zed re-parse
; that region with the `MX` grammar and highlight its actual contents — tag
; names, attributes, name sugars, placeholders — instead of leaving it a
; single uncolored span. No other extension is needed.
((mx_element) @injection.content
 (#set! injection.language "MX"))

; --- Solid overlay (overlay/solid/injections.scm) ---
; Solid-specific injection overlay, concatenated onto
; base/solid/injections.scm by scripts/vendor.sh. Empty for now: the
; `MX` injection into `mx_element` already covers the only embedded
; region this grammar produces.
