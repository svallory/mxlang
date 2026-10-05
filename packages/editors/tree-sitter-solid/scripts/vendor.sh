#!/usr/bin/env bash
#
# Vendor tree-sitter-typescript's tsx dialect and apply the MX patches.
#
# Usage:
#   ./scripts/vendor.sh            # fetch upstream at the pin, apply patches/*.patch
#   ./scripts/vendor.sh --check    # verify vendor/ matches upstream+patches; no writes
#
# --check exists because the vendored tree is a build input: if someone edits
# vendor/ by hand instead of adding a patch, the next re-vendor silently reverts
# it. --check fails loudly in that case (see UPSTREAM.md "Bump procedure").
set -euo pipefail

REPO_URL="https://github.com/tree-sitter/tree-sitter-typescript.git"
# Pinned tag v0.23.2 (2024-11-10), the latest tag at vendoring time.
PIN_SHA="f975a621f4e7f532fe322e13c4f79495e0a7b2e7"
PIN_TAG="v0.23.2"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$HERE/vendor/tree-sitter-typescript"
PATCH_DIR="$HERE/patches"

# vendor/ is .gitignore'd, but src/scanner.c #includes the tsx scanner
# header — Zed's file:// dev install compiles only what's committed at the
# pinned rev (never vendor/), so a copy of that header must live in src/
# itself. See UPSTREAM.md "A real defect this caused" for what happens
# without this (Zed's clean clone: "file not found").
COMMITTED_SCANNER_HEADER="$HERE/src/tree_sitter_typescript_scanner.h"
VENDORED_SCANNER_HEADER="$VENDOR_DIR/common/scanner.h"

CHECK_MODE=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=1
elif [[ $# -gt 0 ]]; then
  echo "vendor.sh: unknown argument '$1' (expected --check or nothing)" >&2
  exit 2
fi

# Fetch upstream at the pin into $1. Uses a blobless clone: the full history of
# this repo is large and only one tree is needed.
#
# Leaves $dest/.git in place — apply_patches needs a real repo there for
# `git -C $dest apply` to resolve against (see apply_patches' own comment for
# why this matters). The caller strips .git afterward.
fetch_upstream() {
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest"
  git -c advice.detachedHead=false clone --quiet --filter=blob:none \
    "$REPO_URL" "$dest" >/dev/null
  git -C "$dest" -c advice.detachedHead=false checkout --quiet "$PIN_SHA"

  local got
  got="$(git -C "$dest" rev-parse HEAD)"
  if [[ "$got" != "$PIN_SHA" ]]; then
    echo "vendor.sh: checked out $got, expected pin $PIN_SHA ($PIN_TAG)" >&2
    exit 1
  fi
}

apply_patches() {
  # `git -C "$dest" apply` requires $dest to be inside a real git worktree —
  # without one, git silently resolves -C upward to whatever repo happens to
  # enclose $dest (this package's own monorepo), the patch's paths don't
  # exist there, and `git apply` reports "Skipped patch" and exits 0. Caught
  # only because scripts/vendor.sh --check (added alongside this comment)
  # diffed a "regenerated" vendor/ against itself and found it unpatched —
  # every prior run of this function silently no-op'd, and nothing before
  # this ever re-ran it against a $dest with .git already stripped to notice.
  # fetch_upstream therefore leaves $dest/.git in place; THIS function is
  # what must strip it, immediately after applying, before it's used as a
  # source anywhere else — that ordering is the actual fix.
  local dest="$1"
  shopt -s nullglob
  local patches=("$PATCH_DIR"/*.patch)
  shopt -u nullglob

  if [[ ${#patches[@]} -eq 0 ]]; then
    echo "vendor.sh: no patches in $PATCH_DIR — refusing to vendor an unpatched tree" >&2
    echo "  (an unpatched vendor/ would silently drop every MX modification)" >&2
    exit 1
  fi

  if [[ ! -d "$dest/.git" ]]; then
    echo "vendor.sh: apply_patches called on $dest with no .git — patches would silently no-op" >&2
    exit 1
  fi

  local p
  for p in "${patches[@]}"; do
    if ! git -C "$dest" apply --whitespace=nowarn --verbose "$p"; then
      echo "vendor.sh: failed to apply $(basename "$p")" >&2
      echo "  Upstream likely drifted. See UPSTREAM.md 'Bump procedure'." >&2
      exit 1
    fi
  done

  # Drop upstream's own git metadata now that the patch is safely applied —
  # the vendored tree is content, not a repo.
  rm -rf "$dest/.git"
}

if [[ "$CHECK_MODE" -eq 1 ]]; then
  if [[ ! -d "$VENDOR_DIR" ]]; then
    echo "vendor.sh --check: $VENDOR_DIR does not exist; run ./scripts/vendor.sh" >&2
    exit 1
  fi

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  fetch_upstream "$TMP/expected"
  apply_patches "$TMP/expected"

  # Compare only the files the grammar build actually consumes. Upstream ships
  # bindings, CI config and prebuilt parsers for dialects MX does not use;
  # diffing those would make --check fail on noise.
  status=0
  for rel in common/define-grammar.js common/scanner.h tsx/grammar.js; do
    if ! diff -u "$TMP/expected/$rel" "$VENDOR_DIR/$rel" >/dev/null 2>&1; then
      echo "vendor.sh --check: DRIFT in $rel" >&2
      diff -u "$TMP/expected/$rel" "$VENDOR_DIR/$rel" >&2 || true
      status=1
    fi
  done

  # The committed copy of scanner.h (src/tree_sitter_typescript_scanner.h)
  # must be byte-identical to the vendored one — see "A real defect this
  # caused" in UPSTREAM.md. A hand-copied header nothing refreshes is exactly
  # the drift surface patches/ and overlay/ exist to prevent elsewhere.
  if ! diff -u "$TMP/expected/common/scanner.h" "$COMMITTED_SCANNER_HEADER" >/dev/null 2>&1; then
    echo "vendor.sh --check: DRIFT in src/tree_sitter_typescript_scanner.h (committed copy of common/scanner.h)" >&2
    diff -u "$TMP/expected/common/scanner.h" "$COMMITTED_SCANNER_HEADER" >&2 || true
    status=1
  fi

  if [[ "$status" -ne 0 ]]; then
    echo "vendor.sh --check: vendor/ does not match upstream $PIN_TAG + patches/" >&2
    echo "  Re-run ./scripts/vendor.sh, or capture your edit as a patch." >&2
    exit 1
  fi
  echo "vendor.sh --check: OK (upstream $PIN_TAG $PIN_SHA + ${PATCH_DIR##*/}/*.patch)"
  exit 0
fi

fetch_upstream "$VENDOR_DIR"
apply_patches "$VENDOR_DIR"

# Refresh the committed copy so it cannot silently drift from the pin.
cp "$VENDORED_SCANNER_HEADER" "$COMMITTED_SCANNER_HEADER"
echo "vendor.sh: refreshed ${COMMITTED_SCANNER_HEADER#"$HERE"/} from vendor/"

echo "vendor.sh: vendored $PIN_TAG ($PIN_SHA) into ${VENDOR_DIR#"$HERE"/} + patches applied"
