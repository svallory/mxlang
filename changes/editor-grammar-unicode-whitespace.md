---
packages: [tree-sitter-mx]
kind: Changed
---
The grammar reads whitespace in the tag grammar as `@mxlang/parser` does: Unicode's `Pattern_White_Space`. U+0085, U+200E, U+200F, U+2028 and U+2029 separate tag names, shorthands, attribute names and whitespace-terminated values and tag variables exactly as VT does, count as concise indentation, and never end a concise line (`<div a\u2028b/>` has the attributes `a` and `b`). Any other Unicode space character (U+00A0, U+1680, U+2000 to U+200A, U+202F, U+205F, U+3000, U+FEFF) in a tag name, a shorthand or an attribute name is an `ERROR` node over that character, where it used to be read as a name character. Expressions, close tag names and body text read as before.
