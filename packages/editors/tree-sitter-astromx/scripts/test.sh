#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

echo "==> tree-sitter generate & test"
flock /tmp/mx-zed-generate.lock bunx tree-sitter generate
flock /tmp/mx-zed-generate.lock bunx tree-sitter test

echo
echo "==> parse every .astro.mx example"
EXAMPLES_DIR="../../../examples/astro-static/src"
if [ -d "$EXAMPLES_DIR" ]; then
  find "$EXAMPLES_DIR" -name "*.astro.mx" -print0 | while IFS= read -r -d '' file; do
    bunx tree-sitter parse "$file" | grep -q "ERROR" && echo "ERROR in $file" && exit 1 || echo "OK $file"
  done
fi

echo
echo "==> compile src/ from a clean clone of HEAD, as Zed's dev install does"
./scripts/zed-compile-check.sh

echo
echo "all grammar checks passed"

date -u +%s > .test-ran
