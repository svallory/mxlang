---
packages: [parser]
kind: Fixed
---
An expression trigger row now arms right after a prefix `++` or `--`: `++&n`, `--&n` and `++%.now` used to reach Babel unreplaced and fail with "Unexpected token", while `&n++` and `!&n` armed. The parser decides prefix or postfix from what precedes the pair. A pair right after an operand end (a word, `)`, `]`, a closing quote or backtick, a regular expression, a postfix `!`) with no line break between is postfix, so `a ++&n` stays `a++ & n` and `n++ :a` and `c ? a++ :b` stay unarmed under a `:` row. Anywhere else (the start of an expression, after an operator, `(`, `,`, `=`, `?`, `:`, a keyword operator such as `typeof`, `void` or `return`, or after a line break, as in JavaScript) the pair is prefix and an operand follows. A run of three, as in `a+++&n`, reads as `a++ + &n`. The look-behind table in the parser grammar page describes the rule.
