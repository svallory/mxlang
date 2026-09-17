; Bracket pairs for the TypeScript host language, in Zed's brackets.scm
; @open/@close convention (other tools ignore this file). `mx_element` is a
; single opaque token with no interior brackets to pair (see injections.scm).

(type_arguments
  "<" @open
  ">" @close)

(type_parameters
  "<" @open
  ">" @close)

(statement_block
  "{" @open
  "}" @close)

(object
  "{" @open
  "}" @close)

(object_type
  "{" @open
  "}" @close)

(interface_body
  "{" @open
  "}" @close)

(class_body
  "{" @open
  "}" @close)

(enum_body
  "{" @open
  "}" @close)

(array
  "[" @open
  "]" @close)

(array_type
  "[" @open
  "]" @close)

(array_pattern
  "[" @open
  "]" @close)

(formal_parameters
  "(" @open
  ")" @close)

(arguments
  "(" @open
  ")" @close)

(parenthesized_expression
  "(" @open
  ")" @close)

(template_string
  "`" @open
  "`" @close)

(template_substitution
  "${" @open
  "}" @close)
