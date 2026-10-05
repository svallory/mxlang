# @marko/tree-sitter

## 0.3.0

### Minor Changes

- Parse `#id`, `.class` and the new `:name` shorthand (`shorthand_name`) anywhere in a tag (MX decision 146): tag-adjacent in any order (`<a#d:b.c>`, `<:b>`, which now carry the `shorthand` field), and in attribute position, first or after any attribute, in html and concise mode (`<input type="email" :email #main .big>`). After whitespace, `.ident` and `:ident` (with no open conditional `?`) end the previous attribute value. A value on the sugar (`:x=1`) is an error; named modifiers (`class:x`, `style:x`, `value:fn:=x`) are unchanged. `<style .scss>` (attribute position) no longer selects a stylesheet dialect.

## 0.2.0

### Minor Changes

- [#6](https://github.com/marko-js/tree-sitter/pull/6) [`d60112d`](https://github.com/marko-js/tree-sitter/commit/d60112d1bad21fc24fb8a62fec34063164f3ec15) Thanks [@DylanPiercey](https://github.com/DylanPiercey)! - Support comments between concise mode line attributes. `//` line and `/* */` block comments may now appear between comma-prefixed line attributes; they are scanned over and no longer terminate the open tag.
