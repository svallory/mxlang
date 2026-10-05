#!/usr/bin/env bash
#
# Build the TypeScript grammar the docs inject into MX code.
#
# `packages/editors/tree-sitter-mx/queries/injections.scm` says which ranges of
# an MX file hold TypeScript (placeholders, attribute values, `static` bodies,
# `import`/`export`/`class` statements, ...). Highlighting them needs a
# TypeScript wasm and a highlights query; neither is in the repo, so this
# builds them from the same upstream pin `packages/editors/tree-sitter-solidmx`
# vendors (`UPSTREAM.md`): tree-sitter-typescript v0.23.2, the plain
# `typescript` dialect (not `tsx`: an injected expression is never JSX).
#
# Outputs, all under the gitignored `apps/docs/.cache/ts/`:
#   tree-sitter-typescript.wasm   built with `tree-sitter build --wasm`
#   highlights.scm                tree-sitter-javascript's query, then upstream
#                                 TypeScript's (later patterns win), because the
#                                 TypeScript query only adds to the JavaScript one
#
# Idempotent: a cache keyed on the pin is reused. Needs network on a cold cache
# (one blobless clone of the upstream repo).
set -euo pipefail

PIN_SHA="f975a621f4e7f532fe322e13c4f79495e0a7b2e7" # tree-sitter-typescript v0.23.2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="$HERE/.cache/ts"
SRC="$CACHE/src"

if [[ -f "$CACHE/.pin" && "$(cat "$CACHE/.pin")" == "$PIN_SHA" \
  && -f "$CACHE/tree-sitter-typescript.wasm" && -f "$CACHE/highlights.scm" ]]; then
  exit 0
fi

JS_DIR="$(cd "$HERE" && node -p "require('path').dirname(require.resolve('tree-sitter-javascript/package.json'))")"

rm -rf "$CACHE"
mkdir -p "$CACHE"
git clone -q --filter=blob:none --no-checkout \
  https://github.com/tree-sitter/tree-sitter-typescript.git "$SRC"
git -C "$SRC" checkout -q "$PIN_SHA"

# Same lock and CLI as the grammar package's own build:wasm, so two builds
# never race on the tree-sitter cache.
(cd "$ROOT/packages/editors/tree-sitter-mx" &&
  flock /tmp/mx-zed-generate.lock \
    bunx tree-sitter build --wasm -o "$CACHE/tree-sitter-typescript.wasm" "$SRC/typescript")

cat "$JS_DIR/queries/highlights.scm" "$SRC/queries/highlights.scm" >"$CACHE/highlights.scm"
echo "$PIN_SHA" >"$CACHE/.pin"
echo "typescript grammar: built tree-sitter-typescript.wasm at $PIN_SHA"
