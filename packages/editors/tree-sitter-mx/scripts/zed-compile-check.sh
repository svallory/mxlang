#!/usr/bin/env bash
# Reproduces Zed's own grammar compile step against a CLEAN CLONE of this
# repo at HEAD — i.e. only committed files, never the working tree. Copied
# from packages/editors/tree-sitter-solid/scripts/zed-compile-check.sh (see
# that package's UPSTREAM.md "A real defect this caused" for the defect class
# this gate exists for); only PKG_REL and GRAMMAR_NAME differ. The export
# name `tree_sitter_mx` is what `[grammars.mx]` in packages/editors/zed's
# extension.toml makes Zed look up, so a grammar still named `marko` fails
# here at link time.
#
# Mirrors Zed's own build (crates/extension/src/extension_builder.rs,
# compile_grammar): clang -fPIC -shared -Os -Wl,--export=tree_sitter_<name>
# -I <src> <parser.c> [<scanner.c> if present] -o <name>.wasm, using Zed's
# own wasi-sdk clang when available.
#
# Usage: scripts/zed-compile-check.sh
# Env:
#   ZED_COMPILE_CHECK_FORCE_FALLBACK=1   skip the wasi-sdk clang lookup and
#     always use `tree-sitter build --wasm` — CI sets this (runners never
#     have Zed installed, so it would take this path anyway by omission;
#     forcing it means CI actually exercises the branch instead of only
#     agreeing with it by never having a choice).
#   ZED_COMPILE_CHECK_WASM_BUILD_ARGS   extra flags passed through to
#     `tree-sitter build --wasm`, e.g. "--docker" on a runner with no local
#     emsdk (CI ships Docker, not a preinstalled emscripten toolchain).
# Exit 0: compiled clean, grammar.wasm produced and non-empty.
# Exit 1: compile failed (prints clang's/emcc's own first error) or wasm missing/empty.
# Exit 2: could not run the check at all (no repo, no clang found anywhere).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
PKG_REL="packages/editors/tree-sitter-mx"
GRAMMAR_NAME="mx"

# Zed's own wasi-sdk clang, if this machine has installed the extension at
# least once (it ships wasi-sdk under Zed's own app-support directory, not
# on PATH). Falls back to `tree-sitter build --wasm`, which uses emscripten
# instead — a different toolchain, but the same "committed files only"
# property this gate needs, since it also compiles from the clean clone.
#
# ZED_COMPILE_CHECK_FORCE_FALLBACK=1 skips the wasi-sdk lookup unconditionally
# — CI runners never have Zed installed, so this is the path CI always takes;
# forcing it (rather than relying on the lookup finding nothing) means CI
# exercises the exact fallback branch every real contributor's machine may
# also be on, instead of only implicitly agreeing with it by omission.
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

# Clone the whole monorepo (this grammar has no repo of its own yet — it
# lives nested at $PKG_REL, same as extension.toml's file:// + path dev
# form), at HEAD, so only committed files are present. This mirrors exactly
# what Zed's checkout_repo does for [grammars.mx].
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
  # ZED_COMPILE_CHECK_WASM_BUILD_ARGS: extra flags for `tree-sitter build`.
  #
  # Unlike the solid/amx copies (tree-sitter-cli 0.24.7 with --docker), this
  # fallback uses package.json's own tree-sitter-cli 0.26.9: it downloads its
  # own wasi-sdk (no Docker or emsdk needed on CI) and compiles the clone's
  # committed src/ as-is. 0.24.7 regenerates src/parser.c from grammar.js
  # first, so it never compiles the committed parser (PR #301 review: a junk
  # line appended to parser.c built fine with 0.24.7, and fails with 0.26.9).
  # The export check below then proves the wasm carries tree_sitter_mx, the
  # symbol `[grammars.mx]` makes Zed look up.
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

# Zed loads the language through this export; a grammar still named `marko`
# (or a fallback that compiled something else) fails here on either branch.
if ! bun -e '
  const exports = WebAssembly.Module.exports(
    new WebAssembly.Module(await Bun.file(process.argv[1]).arrayBuffer()),
  ).map((e) => e.name);
  if (!exports.includes(`tree_sitter_${process.argv[2]}`)) {
    console.error(`exports: ${exports.join(", ")}`);
    process.exit(1);
  }
' "$WASM_OUT" "$GRAMMAR_NAME"; then
  echo "zed-compile-check.sh: $(basename "$WASM_OUT") does not export tree_sitter_${GRAMMAR_NAME}" >&2
  exit 1
fi

echo "zed-compile-check.sh: OK — $(basename "$WASM_OUT") compiled from a clean clone of HEAD, exports tree_sitter_${GRAMMAR_NAME} ($(wc -c < "$WASM_OUT") bytes)"
