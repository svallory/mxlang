# tree-sitter-solidmx — agent instructions

`packages/editors/tree-sitter-solidmx/vendor/` is gitignored, so a fresh worktree has
none — `scripts/test.sh` now runs `scripts/vendor.sh` itself when
`vendor/tree-sitter-typescript` is missing (printing one line saying so), so
`bun run verify` and `bun run test:grammar` pass from a clone with no manual
setup step.
