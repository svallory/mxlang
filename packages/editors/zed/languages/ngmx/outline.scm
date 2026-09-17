; Outline entries for the TypeScript host language, in Zed's outline.scm
; @item/@name convention (other tools ignore this file). `mx_element` is a
; single opaque token with no interior structure to list (see injections.scm
; — its contents are highlighted via the `marko` injection instead).

(function_declaration
  name: (identifier) @name) @item

(generator_function_declaration
  name: (identifier) @name) @item

(class_declaration
  name: (type_identifier) @name) @item

(abstract_class_declaration
  name: (type_identifier) @name) @item

(interface_declaration
  name: (type_identifier) @name) @item

(enum_declaration
  name: (identifier) @name) @item

(type_alias_declaration
  name: (type_identifier) @name) @item

(method_definition
  name: (property_identifier) @name) @item

; --- AngularMX overlay (overlay/ngmx/outline.scm) ---
; AngularMX-specific outline overlay, concatenated onto base/ngmx/outline.scm
; by scripts/vendor.sh. Empty for now: base/ngmx/outline.scm already
; covers every declaration the TypeScript host language emits.
