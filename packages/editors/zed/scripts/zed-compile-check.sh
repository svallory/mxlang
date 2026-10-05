#!/usr/bin/env bash
# Reproduces Zed's own Rust extension build against a CLEAN CLONE of this
# repo at HEAD — i.e. only committed files, never the working tree. Mirrors
# packages/editors/tree-sitter-solidmx/scripts/zed-compile-check.sh's rationale (the
# grammar's own gate), extended to this package's Rust extension code
# (Cargo.toml, src/lib.rs): Zed's extension_builder.rs builds a
# Cargo.toml-backed extension with `cargo build --release --target
# wasm32-wasip1`, so this script does exactly that.
#
# Usage: scripts/zed-compile-check.sh
# Prerequisite: `rustup target add wasm32-wasip1` (a toolchain install, not a
# repo dependency — see the root AGENTS.md "Zed extension" / the task brief).
# Exit 0: compiled clean, a non-empty .wasm produced.
# Exit 1: cargo build failed, or the wasm is missing/empty afterward.
# Exit 2: could not run the check at all (no git, no cargo, target missing).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
PKG_REL="packages/editors/zed"
CRATE_NAME="mxlang_zed"

if ! command -v git >/dev/null 2>&1; then
  echo "zed-compile-check.sh: git not found" >&2
  exit 2
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "zed-compile-check.sh: cargo not found" >&2
  exit 2
fi
if ! rustup target list --installed 2>/dev/null | grep -q '^wasm32-wasip1$'; then
  echo "zed-compile-check.sh: wasm32-wasip1 target not installed; run 'rustup target add wasm32-wasip1'" >&2
  exit 2
fi

# The grammars Zed compiles come from extension.toml's pinned revs, not from
# HEAD; check that each file:// rev exists, holds its grammar, and matches
# HEAD's src/ before building the Rust half.
"$HERE/scripts/check-grammar-revs.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CLONE_DIR="$TMP_DIR/clone"

echo "Cloning committed HEAD only (file://$REPO_ROOT, at $PKG_REL)..."
git clone --quiet --depth 1 "file://$REPO_ROOT" "$CLONE_DIR"

PKG_DIR="$CLONE_DIR/$PKG_REL"
if [[ ! -f "$PKG_DIR/Cargo.toml" ]]; then
  echo "zed-compile-check.sh: $PKG_DIR/Cargo.toml missing from committed HEAD" >&2
  exit 2
fi

echo "cargo build --release --target wasm32-wasip1 (from clean clone)..."
set +e
(cd "$PKG_DIR" && cargo build --release --target wasm32-wasip1) 2> "$TMP_DIR/cargo-stderr.log"
rc=$?
set -e
if [[ "$rc" -ne 0 ]]; then
  echo "zed-compile-check.sh: cargo build failed (exit $rc)" >&2
  tail -n 20 "$TMP_DIR/cargo-stderr.log" >&2
  exit 1
fi

WASM_OUT="$PKG_DIR/target/wasm32-wasip1/release/$CRATE_NAME.wasm"
if [[ ! -s "$WASM_OUT" ]]; then
  echo "zed-compile-check.sh: $WASM_OUT missing or empty after a reported-successful build" >&2
  exit 1
fi

echo "zed-compile-check.sh: OK — $(basename "$WASM_OUT") compiled from a clean clone of HEAD ($(wc -c < "$WASM_OUT") bytes)"
