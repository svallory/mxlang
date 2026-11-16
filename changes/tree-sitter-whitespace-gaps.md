---
packages: [tree-sitter-mx]
kind: Fixed
---
A character above U+00FF no longer reads as an unrelated ASCII character where the grammar looks back at the text before a token. The scanner used to keep only a code point's low byte there, so `丽` read as `=` (`<div a=x丽>t</div>` read `丽>` as `=>` and the attribute value did not end at `>`), `丠` read as a space (`<p>丠// x</p>` read `// x` as a comment), U+202F read as `/`, U+200A as a line break and U+2000 and U+3000 as no character. Unicode space characters (U+0085, U+00A0, U+1680, U+2000 to U+200A, U+200E, U+200F, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF) now read there as whitespace, except that `//` or `/*` after one in body text is text, as in `@mxlang/parser`; any other character above U+00FF reads as an identifier character, so `<div a=变/2/>` divides. Close tags still match interpolated tag names as before.
