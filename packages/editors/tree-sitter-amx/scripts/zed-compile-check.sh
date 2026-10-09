#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
PKG_REL="packages/editors/tree-sitter-amx"
GRAMMAR_NAME="amx"

if [[ "${ZED_COMPILE_CHECK_FORCE_FALLBACK:-0}" == "1" ]]; then
  ZED_WASI_CLANG=""
else
  ZED_WASI_CLANG="$HOME/Library/Application Support/Zed/extensions/build/wasi-sdk/bin/clang"
fi

if ! command -v git >/dev/null 2>&1; then
  echo "zed-compile-check.sh: git not found" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CLONE_DIR="$TMP_DIR/clone"

echo "Cloning committed HEAD only (file://$REPO_ROOT, at $PKG_REL)..."
git clone --quiet --depth 1 "file://$REPO_ROOT" "$CLONE_DIR"

SRC_DIR="$CLONE_DIR/$PKG_REL/src"
PARSER_C="$SRC_DIR/parser.c"
SCANNER_C="$SRC_DIR/scanner.c"
WASM_OUT="$TMP_DIR/$GRAMMAR_NAME.wasm"

if [[ ! -f "$PARSER_C" ]]; then
  echo "zed-compile-check.sh: $PARSER_C missing from committed HEAD" >&2
  exit 2
fi

if [[ -x "$ZED_WASI_CLANG" ]]; then
  echo "Compiling with Zed's own wasi-sdk clang: $ZED_WASI_CLANG"
  set +e
  "$ZED_WASI_CLANG" -fPIC -shared -Os \
    "-Wl,--export=tree_sitter_${GRAMMAR_NAME}" \
    -o "$WASM_OUT" \
    -I "$SRC_DIR" \
    "$PARSER_C" \
    $( [[ -f "$SCANNER_C" ]] && echo "$SCANNER_C" ) \
    2> "$TMP_DIR/clang-stderr.log"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    echo "zed-compile-check.sh: clang failed (exit $rc)" >&2
    head -n 5 "$TMP_DIR/clang-stderr.log" >&2
    exit 1
  fi
else
  echo "Zed's wasi-sdk clang not found at $ZED_WASI_CLANG; falling back to 'tree-sitter build --wasm'"
  if ! command -v bunx >/dev/null 2>&1; then
    echo "zed-compile-check.sh: no wasi-sdk clang and no bunx to fall back to tree-sitter build" >&2
    exit 2
  fi
  # ZED_COMPILE_CHECK_WASM_BUILD_ARGS: extra flags for `tree-sitter build`
  # (empty by default; a pass-through, nothing in CI sets it).
  #
  # tree-sitter-cli 0.26.9's `build --wasm` downloads its own wasi-sdk, so
  # this needs neither Docker nor a local emsdk, and it compiles the clone's
  # committed src/ as-is. The earlier 0.24.7 pin existed only for `--docker`
  # (dropped in 0.26), which pulled an emscripten image from Docker Hub
  # anonymously and hit its unauthenticated pull rate limit on CI. 0.24.7
  # also regenerated src/parser.c before compiling. package.json keeps
  # tree-sitter-cli 0.24.7 for generate/test; this pin is only the wasm
  # build. Same path as tree-sitter-mx's own zed-compile-check.sh.
  set +e
  # shellcheck disable=SC2086 # deliberately unquoted: a flag list, not one value
  (cd "$CLONE_DIR/$PKG_REL" && bunx --package "tree-sitter-cli@0.26.9" tree-sitter build --wasm ${ZED_COMPILE_CHECK_WASM_BUILD_ARGS:-} -o "$WASM_OUT") \
    2> "$TMP_DIR/tsbuild-stderr.log"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    echo "zed-compile-check.sh: tree-sitter build --wasm failed (exit $rc)" >&2
    head -n 5 "$TMP_DIR/tsbuild-stderr.log" >&2
    exit 1
  fi
fi

if [[ ! -s "$WASM_OUT" ]]; then
  echo "zed-compile-check.sh: $WASM_OUT missing or empty after a reported-successful compile" >&2
  exit 1
fi

echo "zed-compile-check.sh: OK — $(basename "$WASM_OUT") compiled from a clean clone of HEAD ($(wc -c < "$WASM_OUT") bytes)"
