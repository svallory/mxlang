#!/usr/bin/env bash
# Provenance check for the vendored grammar (see UPSTREAM.md).
#
# Fetches marko-js/tree-sitter at PIN_SHA, applies patches/*.patch in order,
# and diffs every hand-written file the result holds against this package's
# committed copy. Exits non-zero on any difference, so an edit to a vendored
# file that was never captured as a patch fails here instead of being lost on
# the next re-vendor. The generated files (src/parser.c, src/grammar.json,
# src/node-types.json, src/tree_sitter/) are not compared here: scripts/test.sh
# regenerates them from grammar.js and fails when they differ.
#
# Usage: scripts/vendor-check.sh
# Env:   MX_TREE_SITTER_UPSTREAM  a local marko-js/tree-sitter clone to fetch
#        PIN_SHA from instead of GitHub (offline runs).
# Exit 0: the committed files are exactly upstream + patches/.
# Exit 1: a patch does not apply, or a file differs.
set -euo pipefail

PIN_SHA="7fb20382b9b0c97c8bdbceee0e0641bea11dd00f" # @marko/tree-sitter v0.2.0
UPSTREAM="${MX_TREE_SITTER_UPSTREAM:-https://github.com/marko-js/tree-sitter}"
# Paths taken from upstream; everything else in this package is MX's own.
FILES=(grammar.js src/scanner.c queries __tests__ tools/check-wasm.mts LICENSE README.md tree-sitter.json)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
FETCH="$TMP_DIR/upstream"
OUT="$TMP_DIR/out"

echo "Fetching $UPSTREAM at $PIN_SHA..."
git init --quiet "$FETCH"
git -C "$FETCH" fetch --quiet --depth 1 "$UPSTREAM" "$PIN_SHA"

# A real repository at $OUT: without one, `git -C "$OUT" apply` resolves
# upward to an enclosing repository and "Skipped patch" exits 0 (the defect
# recorded in ../tree-sitter-solidmx/UPSTREAM.md).
git init --quiet "$OUT"
git -C "$FETCH" archive FETCH_HEAD "${FILES[@]}" | tar -x -C "$OUT"

for patch in "$HERE"/patches/*.patch; do
  echo "Applying $(basename "$patch")"
  if ! git -C "$OUT" apply --verbose "$patch" > "$TMP_DIR/apply.log" 2>&1; then
    cat "$TMP_DIR/apply.log" >&2
    echo "vendor-check.sh: $(basename "$patch") does not apply to $PIN_SHA" >&2
    exit 1
  fi
  if grep -q '^Skipped patch' "$TMP_DIR/apply.log"; then
    cat "$TMP_DIR/apply.log" >&2
    echo "vendor-check.sh: git apply skipped part of $(basename "$patch")" >&2
    exit 1
  fi
done
rm -rf "$OUT/.git"

status=0
for path in "${FILES[@]}"; do
  if ! diff -r "$OUT/$path" "$HERE/$path" > "$TMP_DIR/diff.log" 2>&1; then
    cat "$TMP_DIR/diff.log" >&2
    status=1
  fi
done
if [[ "$status" -ne 0 ]]; then
  echo "vendor-check.sh: committed files differ from upstream $PIN_SHA + patches/" >&2
  exit 1
fi
echo "vendor-check.sh: OK — committed files are upstream $PIN_SHA + $(ls "$HERE"/patches/*.patch | wc -l | tr -d ' ') patches"
