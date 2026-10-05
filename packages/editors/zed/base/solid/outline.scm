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
