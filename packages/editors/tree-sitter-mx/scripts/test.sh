#!/usr/bin/env bash
#
# `bun run test` for the MX grammar package.
#
# Runs, in order, stopping at the first failure:
#   1. tree-sitter generate, then `git diff --exit-code -- src/`: the
#      committed src/ is what Zed compiles (it never runs generate), so it
#      must be exactly what grammar.js generates. Catches a grammar.js edit
#      committed without regenerating, and a hand-edited src/grammar.json.
#   2. bun run build:wasm — the wasm the test harness loads.
#   3. __tests__/mx-shorthand.bun-test.mts — decision 146 trees (upstream
#      branch mx/shorthand-anywhere's suite).
#   4. __tests__/fixtures.bun-test.mts — every htmljs-parser fixture at the
#      pinned HTMLJS_REV, compared event by event (fetched once into .cache/).
#   4b. test/indentation.bun-test.mts — an indented line with no tag open is an
#      ERROR node, not a silent truncation.
#   4c. test/highlights.bun-test.mts — MX's own: the shorthand captures of
#      queries/highlights.scm and of the Zed extension's languages/mx copy, in
#      both positions and both modes.
#   5. tools/check-wasm.mts — the wasm parses a sample and both queries load.
#   6. scripts/zed-compile-check.sh — compiles src/ from a clean clone of
#      HEAD, the same way Zed's file:// dev install does.
#
# The test files are named *.bun-test.mts, not *.test.mts, so the root vitest
# run (which globs packages/editors/*) does not collect them: they use bun's
# test globals and need the wasm from step 2.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

echo "==> tree-sitter generate (src/ must match grammar.js)"
flock /tmp/mx-zed-generate.lock bunx tree-sitter generate
if ! git diff --quiet -- src/; then
  git diff --stat -- src/ >&2
  echo "src/ does not match what 'tree-sitter generate' produces from grammar.js." >&2
  echo "Run 'bun run generate' in packages/editors/tree-sitter-mx and commit the result." >&2
  exit 1
fi

echo
echo "==> build tree-sitter-mx.wasm"
bun run build:wasm

echo
echo "==> mx shorthand trees, htmljs-parser fixtures, shorthand highlights"
bun test ./__tests__/mx-shorthand.bun-test.mts ./__tests__/fixtures.bun-test.mts ./test/highlights.bun-test.mts ./test/indentation.bun-test.mts

echo
echo "==> wasm smoke and queries"
bun tools/check-wasm.mts

echo
echo "==> compile src/ from a clean clone of HEAD, as Zed's dev install does"
./scripts/zed-compile-check.sh

echo
echo "all grammar checks passed"

# Evidence for scripts/verify-coverage.ts: this file only exists once every
# step above has exited 0, and its mtime proves *this* invocation ran it
# (deleted before each verify run, gitignored, never committed).
date -u +%s > .test-ran
