; MX's additions to the injected TypeScript highlights. build-ts-grammar.sh
; appends this file after tree-sitter-javascript's and tree-sitter-typescript's
; queries, so these patterns win on equal ranges. Upstream leaves two gaps that
; show up in `.mx` attribute values and `static` bodies:
;
;   1. Names bound by an object pattern are `shorthand_property_identifier_pattern`
;      nodes, not `identifier`, so the catch-all `(identifier) @variable` never
;      sees them: `({ self }) => self.done` coloured the body's `self` and not
;      the parameter.
;   2. A ternary's `?` and `:` are anonymous tokens no operator pattern lists.

; `const { a } = x`, `for (const { a } of xs)`, nested patterns
(shorthand_property_identifier_pattern) @variable

; `{ a = 1 }`: the default's left side
(object_assignment_pattern
  left: (shorthand_property_identifier_pattern) @variable)

; `({ self }) => ...`, `function f({ self }) {}`, `#label({ self }) {}`,
; `(a, { self }: T) => ...` (every parameter is a required_parameter or
; optional_parameter): later than the pattern above, so it wins
(formal_parameters
  (required_parameter
    pattern: (object_pattern
      (shorthand_property_identifier_pattern) @variable.parameter)))
(formal_parameters
  (optional_parameter
    pattern: (object_pattern
      (shorthand_property_identifier_pattern) @variable.parameter)))

(ternary_expression
  [
    "?"
    ":"
  ] @operator)
