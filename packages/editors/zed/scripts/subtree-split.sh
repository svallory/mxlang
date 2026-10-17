#!/usr/bin/env bash
# Splits packages/editors/zed out of this monorepo into a standalone repo
# whose ROOT holds extension.toml — the shape the Zed extension registry
# requires (a submodule pointing at a commit of the extension repo; see
# notes/zed-plan.md decision 6).
#
# `git subtree split` rewrites history so every commit touching
# packages/editors/zed becomes a commit at the repo root, with everything
# outside that directory removed. It reads the *committed* history of this
# repo, so uncommitted changes are not included — commit first.
#
# Usage:
#   scripts/subtree-split.sh [branch-name]
#
# Prints the resulting branch name and its tip sha. Push that branch to the
# target repo (e.g. mxlang/zed) yourself — this script does not push or touch
# any remote, so a bad split can be discarded by deleting the local branch.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
PREFIX="packages/editors/zed"
BRANCH="${1:-zed-split}"

cd "$REPO_ROOT"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "subtree-split.sh: working tree has uncommitted changes." >&2
  echo "  git subtree split only sees committed history — commit first." >&2
  exit 1
fi

if git show-ref --quiet "refs/heads/$BRANCH"; then
  echo "subtree-split.sh: branch '$BRANCH' already exists locally." >&2
  echo "  Delete it (git branch -D $BRANCH) or pass a different name." >&2
  exit 1
fi

echo "Splitting $PREFIX out of $(git rev-parse --abbrev-ref HEAD)..."
SPLIT_SHA="$(git subtree split --prefix="$PREFIX" HEAD)"
git branch "$BRANCH" "$SPLIT_SHA"

echo
echo "Split complete."
echo "  Branch: $BRANCH"
echo "  Tip:    $SPLIT_SHA"
echo
echo "Verify extension.toml is at the new tree's root:"
echo "  git show $BRANCH:extension.toml | head -1"
echo
echo "Push to the target repo, e.g.:"
echo "  git push <mxlang/zed remote url> $BRANCH:main"
echo
echo "Then, in extension.toml, swap [grammars.solid]'s repository from the"
echo "file:// dev form to the split-off tree-sitter-solid repo's real"
echo "GitHub URL (and drop 'path', since that repo's root is already the"
echo "grammar root) before registering with zed-industries/extensions."
