#!/usr/bin/env bash
# Re-vendors @babel/parser's TypeScript source into packages/parser/src/babel/.
# Idempotent: deletes the existing src/babel/ before re-fetching. Not run by CI —
# vendoring a new tag is a deliberate, reviewed action, not an automatic pull.
#
# Usage: scripts/vendor.sh [tag]
#   tag defaults to the currently pinned v7.29.8 (see UPSTREAM.md / root README.md
#   "Pinned versions" table).
#
# After this script finishes, it does NOT rebuild, retypecheck, or rerun the
# equivalence test, and it does NOT reapply the local modifications documented
# in UPSTREAM.md (the parser/index.ts self-import rewrite, the tokenizer/state.ts
# @bit decorator reimplementation, or the util/string-parser.ts vendoring) — a
# new tag can shift line numbers or change these call sites enough that blindly
# reapplying a patch would be wrong. Re-diff by hand against UPSTREAM.md's
# "Local modifications" section, then:
#   bun run build   (from packages/parser)
#   bun run test    (from packages/parser)

set -euo pipefail

TAG="${1:-v7.29.8}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
BABEL_DIR="$PACKAGE_DIR/src/babel"
STRING_PARSER_DIR="packages/babel-helper-string-parser/src"
STRING_PARSER_SRC="$STRING_PARSER_DIR/index.ts"
STRING_PARSER_DEST="$BABEL_DIR/util/string-parser.ts"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Fetching babel/babel @ $TAG (packages/babel-parser/src, $STRING_PARSER_DIR)..."
git clone --filter=blob:none --sparse --depth 1 --branch "$TAG" \
  https://github.com/babel/babel.git "$TMP_DIR" --quiet
# sparse-checkout set (cone mode) takes directories, not file paths — passing
# a file path here fails with "is not a directory" and aborts under set -e.
(cd "$TMP_DIR" && git sparse-checkout set packages/babel-parser/src "$STRING_PARSER_DIR")

COMMIT="$(cd "$TMP_DIR" && git rev-parse HEAD)"
echo "Resolved $TAG -> $COMMIT"

echo "Removing existing $BABEL_DIR..."
rm -rf "$BABEL_DIR"
mkdir -p "$BABEL_DIR"

echo "Copying vendored source..."
cp -R "$TMP_DIR/packages/babel-parser/src/." "$BABEL_DIR/"

echo "Dropping plugins/flow/ (MX has no Flow story)..."
rm -rf "$BABEL_DIR/plugins/flow"

echo "Vendoring util/string-parser.ts (@babel/helper-string-parser, inlined — no shipped .d.ts)..."
cp "$TMP_DIR/$STRING_PARSER_SRC" "$STRING_PARSER_DEST"

cat <<EOF

Done. src/babel/ is now $TAG ($COMMIT), flow dropped.

This script did NOT:
  - remove 'flow' from plugin-utils.ts's mixinPlugins/mixinPluginNames
  - reapply the parser/index.ts self-import rewrite
  - reapply the tokenizer/state.ts @bit decorator reimplementation
  - rewrite util/string-parser.ts's import in tokenizer/index.ts
  - fix the non-null assertion in util/string-parser.ts
  - update UPSTREAM.md's tag/commit/date

Reapply each by hand against UPSTREAM.md's "Local modifications" section
(line numbers may have shifted), update UPSTREAM.md's Pin section, then run
from packages/parser:
  bun run build
  bun run test
EOF
