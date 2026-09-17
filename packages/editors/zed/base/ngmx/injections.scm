; Embedded-language injection for .ng.mx.
;
; AngularMX reuses the solidmx grammar package unchanged: it is a patched
; tree-sitter-typescript tsx dialect whose only MX-specific addition is the
; opaque `mx_element` external token in expression position (see
; packages/editors/tree-sitter-solidmx/UPSTREAM.md "Deliberately NOT carried
; over") — nothing about that grammar is Solid- or Angular-specific, so this
; file is copied from base/solidmx/injections.scm rather than diverging.
; The MX region has no interior structure for this grammar's own queries to
; capture. Injecting the `marko` language (MX and Marko share syntax; see
; notes/zed-plan.md decision 3) lets Zed re-parse that region with the `MX`
; grammar and highlight its actual contents — tag names, attributes,
; placeholders — instead of leaving it a single uncolored span.
((mx_element) @injection.content
 (#set! injection.language "marko"))
