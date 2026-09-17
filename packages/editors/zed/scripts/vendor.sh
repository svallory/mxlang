#!/usr/bin/env bash
# Builds languages/{solidmx,ngmx}/*.scm from this monorepo's own
# tree-sitter-solidmx package plus hand-authored base content and overlays.
#
# SolidMX and AngularMX (`.solid.mx` and `.ng.mx`) share one grammar package
# (packages/editors/tree-sitter-solidmx): a patched tree-sitter-typescript
# tsx dialect whose only MX-specific addition is an opaque `mx_element`
# external token in expression position — nothing about the grammar is
# Solid- or Angular-specific, so both languages' queries are built from the
# same sources below rather than a second grammar package.
#
# Sources (see UPSTREAM.md for exact provenance):
#   - packages/editors/tree-sitter-solidmx  queries/highlights.scm (in-repo, not fetched
#     over the network — that package's own UPSTREAM.md/vendor.sh own the
#     tree-sitter-typescript pin this grammar is built from)
#   - base/<lang>/{injections,brackets,outline}.scm  hand-authored base content
#     per language (no reference Zed extension exists for this grammar, so
#     these play the role a `marko-js/zed`-style upstream would)
#
# For each language and each of the four query names, this script:
#   1. takes the base content — a local sibling package's file (highlights,
#      shared by both languages), or a hand-authored base/<lang>/<name>.scm
#      (injections/brackets/outline)
#   2. concatenates overlay/<lang>/<name>.scm onto the result
#   3. writes the result to languages/<lang>/<name>.scm
#
# Zed reads exactly one file per query name (see notes/zed-decisions.md
# Z6) — there is no multi-file merge at load time, so this concatenation has to
# happen here, at build time, instead.
#
# Usage:
#   scripts/vendor.sh              # (re)generate languages/{solidmx,ngmx}/*.scm
#
# There is no `--check` mode: the highlights source is local (this
# monorepo), so there is no networked upstream HEAD to drift against — a
# `--check` here could only ever report success, and a gate that cannot fail
# is not a gate (decision 55). `upstream-check.yml`'s `vendored-files-match`
# job does the only check that matters for this script: regenerate and diff
# against committed output.
#
# Never hand-edit languages/{solidmx,ngmx}/*.scm — edit overlay/<lang>/*.scm,
# base/<lang>/*.scm instead, then rerun this script.

set -euo pipefail

if [[ $# -gt 0 ]]; then
  echo "usage: $0   (no arguments — this script only regenerates; see its header comment)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"

TREE_SITTER_SOLIDMX_DIR="$(cd "$PKG_DIR/../tree-sitter-solidmx" && pwd)"

build_query() {
  # build_query <lang> <display-name> <name> <base-file>
  local lang="$1" display_name="$2" name="$3" base_file="$4"
  local overlay="$PKG_DIR/overlay/$lang/$name.scm"
  local out_dir="$PKG_DIR/languages/$lang"
  local out="$out_dir/$name.scm"

  mkdir -p "$out_dir"
  {
    cat "$base_file"
    if [[ -f "$overlay" ]]; then
      echo
      echo "; --- $display_name overlay (overlay/$lang/$name.scm) ---"
      cat "$overlay"
    fi
  } > "$out"

  echo "  wrote languages/$lang/$name.scm"
}

build_lang() {
  # build_lang <lang> <display-name>
  local lang="$1" display_name="$2"
  local base_dir="$PKG_DIR/base/$lang"

  build_query "$lang" "$display_name" "highlights" "$TREE_SITTER_SOLIDMX_DIR/queries/highlights.scm"
  build_query "$lang" "$display_name" "injections" "$base_dir/injections.scm"
  build_query "$lang" "$display_name" "brackets"   "$base_dir/brackets.scm"
  build_query "$lang" "$display_name" "outline"    "$base_dir/outline.scm"
}

echo "Building SolidMX queries..."
build_lang "solidmx" "SolidMX"

echo "Building AngularMX queries..."
build_lang "ngmx" "AngularMX"

echo "Done. languages/{solidmx,ngmx}/*.scm regenerated from packages/editors/tree-sitter-solidmx + base/{solidmx,ngmx} + overlays."
