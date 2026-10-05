# tree-sitter-solid — agent instructions

`packages/editors/tree-sitter-solid/vendor/` is gitignored, so a fresh worktree has
none — `scripts/test.sh` now runs `scripts/vendor.sh` itself when
`vendor/tree-sitter-typescript` is missing (printing one line saying so), so
`bun run verify` and `bun run test:grammar` pass from a clone with no manual
setup step.

The differential harness compares Tree-sitter's UTF-8 byte columns with
Babel/JavaScript UTF-16 offsets. Always decode the row prefix by code point;
adding Tree-sitter's column directly to a JavaScript string offset corrupts
positions after non-ASCII text.
