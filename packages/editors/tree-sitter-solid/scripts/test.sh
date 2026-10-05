#!/usr/bin/env bash
#
# `bun run test` for the grammar package.
#
# Runs, in order, stopping at the first failure:
#   1. tree-sitter test        — the corpus in test/corpus/*.txt
#   2. scripts/parse-all.sh    — zero ERROR/MISSING over every .solid.mx
#   3. scripts/highlight-smoke.sh — queries load and apply to every file
#   4. scripts/zed-compile-check.sh — compiles src/ from a clean clone of
#      HEAD, the same way Zed's file:// dev install does. Steps 1-3 all run
#      against the working tree, where vendor/ exists (populated by
#      vendor.sh) — none of them can catch src/ reaching outside itself for
#      a header that's committed nowhere. This step exists specifically for
#      that class of defect (it is how Zed's real dev-install failure with
#      "vendor/tree-sitter-typescript/common/scanner.h file not found" was
#      caught and fixed — see UPSTREAM.md "A real defect this caused").
#   5. scripts/differential.ts — ensures tree-sitter parse and @mxlang/parser
#      extract the exact same MX regions for all files.
#
# Each step exits non-zero on failure and this script propagates it, so a red
# step cannot be mistaken for a green run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# vendor/ is .gitignore'd, so a freshly created worktree has none and every
# step below fails with "Failed to load language" — the grammar cannot compile
# without the vendored tsx scanner. Vendoring here rather than documenting it as
# manual setup: `bun run verify` is supposed to pass from a clone (decision 59),
# and a gate that needs an undocumented prerequisite is a gate that fails for
# reasons unrelated to the change under test.
if [ ! -d "vendor/tree-sitter-typescript" ]; then
  echo "==> vendor/ is absent (fresh worktree); running scripts/vendor.sh"
  ./scripts/vendor.sh
  echo
fi

echo "==> tree-sitter test"
# `generate` is heavy and must be serialized across agents (Z4). `test` compiles
# the parser on demand, so it takes the same lock.
flock /tmp/mx-zed-generate.lock bunx tree-sitter test

echo
echo "==> parse every .solid.mx fixture and example"
./scripts/parse-all.sh

echo
echo "==> highlight smoke over every .solid.mx fixture and example"
./scripts/highlight-smoke.sh

echo
echo "==> compile src/ from a clean clone of HEAD, as Zed's dev install does"
./scripts/zed-compile-check.sh

echo
echo "==> check region extraction equivalence between C scanner and TS walker"
bun run scripts/differential.ts

echo
echo "all grammar checks passed"

# Evidence for scripts/verify-coverage.ts: this file only exists once every
# step above has exited 0, and its mtime proves *this* invocation ran it
# (deleted before each verify run, gitignored, never committed).
date -u +%s > .test-ran
