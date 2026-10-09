# Grammar corpus

Tree-sitter corpus files (`tree-sitter test` runs them): every case is source
the `@mxlang/tree-sitter-mx` grammar accepts, with the tree it produces.

- `tags.txt`, `attributes.txt`, `text.txt`, `placeholders.txt`,
  `scriptlets.txt`, `misc.txt`: derived from the
  [htmljs-parser](https://github.com/marko-js/htmljs-parser) v5.12.0 test
  fixtures (`src/__tests__/fixtures/*/input.marko`, commit
  `16f453a6d86502c24578c339d17bc5ba81257539`, MIT licence, Copyright (c)
  htmljs-parser contributors). A fixture is kept when the grammar parses it
  with no `ERROR`/`MISSING` node and htmljs-parser reports no error for it.
- `mx-*.txt`: MX's own cases (comments, tags, atoms, the Mesh invoice entity).

`bun test/corpus/generate.mts` rewrites the sources (it fetches the pinned
fixtures); run `bunx tree-sitter test --update` after it to fill the trees.
`test/corpus.bun-test.mts` asserts no `ERROR`/`MISSING` node per case, and
`packages/targets/data/src/tree-conformance.test.ts` runs every case through
`parseData`, so a new case is a new data case without further wiring.

## Grammar accepts, htmljs-parser rejects (kept out)

`cdata-eof`, `eof-doctype`, `eof-xml-declaration`, `html-comment-eof`,
`invalid-code-after-comment-block`, `invalid-line-start-hyphen`,
`invalid-line-start-slash`. These are grammar bugs.
