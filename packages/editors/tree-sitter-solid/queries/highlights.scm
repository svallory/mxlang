; Highlights for .solid.mx.
;
; The MX region is one opaque `mx_element` token — the grammar deliberately
; gives it no interior structure (that belongs to @mxlang/parser), so there is
; nothing finer to capture inside it. Everything else in the file is ordinary
; TypeScript, so these patterns cover the TS host language.

(mx_element) @embedded

; Types

(type_identifier) @type
(predefined_type) @type.builtin

((identifier) @type
  (#match? @type "^[A-Z]"))

(type_arguments
  "<" @punctuation.bracket
  ">" @punctuation.bracket)

; Variables and parameters

(required_parameter (identifier) @variable.parameter)
(optional_parameter (identifier) @variable.parameter)

; Functions

(function_declaration
  name: (identifier) @function)

(method_definition
  name: (property_identifier) @function.method)

(call_expression
  function: (identifier) @function)

(call_expression
  function: (member_expression
    property: (property_identifier) @function.method))

; Properties

(property_signature
  name: (property_identifier) @property)

(member_expression
  property: (property_identifier) @property)

; Literals

(string) @string
(template_string) @string
(regex) @string.regex
(number) @number
(comment) @comment

[
  (true)
  (false)
  (null)
  (undefined)
] @constant.builtin

; Keywords

[
  "as"
  "async"
  "await"
  "break"
  "case"
  "catch"
  "class"
  "const"
  "continue"
  "declare"
  "default"
  "do"
  "else"
  "enum"
  "export"
  "extends"
  "finally"
  "for"
  "from"
  "function"
  "get"
  "if"
  "implements"
  "import"
  "in"
  "instanceof"
  "interface"
  "let"
  "namespace"
  "new"
  "of"
  "readonly"
  "return"
  "satisfies"
  "set"
  "static"
  "switch"
  "throw"
  "try"
  "type"
  "typeof"
  "var"
  "void"
  "while"
  "yield"
] @keyword

; Punctuation

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  ";"
  ","
  "."
  ":"
] @punctuation.delimiter
