#!/usr/bin/env bash
# Checks every grammar in extension.toml that points at this repository
# (`repository` is `file://...` or https://github.com/svallory/mxlang, with or
# without `.git`) against this checkout:
#   1. `rev` is a commit this repo has and an ancestor of HEAD (Zed fetches
#      exactly that sha; a commit left behind by a rebase would vanish from
#      the merged history);
#   2. `<path>/src/parser.c` exists at `rev` (Zed's depth-1 clone compiles
#      only what is there);
#   3. `<path>/src` at `rev` is the same tree as at HEAD, so Zed compiles the
#      grammar this checkout tests, not an older one.
#
# Why: [grammars.solidmx] pinned e8bb6e17, a commit from before the
# packages/editors/ regroup (f130d8a4). At that rev `path` did not exist, and
# a dev install failed with "clang: no such file:
# grammars/solidmx/packages/editors/tree-sitter-solidmx/src/parser.c", while
# every check here stayed green: zed-compile-check compiles HEAD, never the
# pinned rev. A grammar commit without a `rev` bump fails check 3 the same way.
#
# Needs full history (CI: `fetch-depth: 0`). Usage: scripts/check-grammar-revs.sh
# Exit 0: every such grammar is consistent. Exit 1: one is not, one lacks
# `rev` or `path`, or no grammar points at this repository (a check that
# selects nothing would pass silently).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
ROOT="$(git rev-parse --show-toplevel)"
# `path` is relative to the repository root, as Zed reads it.
git() { command git -C "$ROOT" "$@"; }

# Captured first: a failing command substitution in a plain assignment stops
# the script under `set -e`, where a `done < <(...)` process substitution's
# exit status is ignored.
grammars="$(python3 - <<'PY'
import tomllib
MONOREPO = ("https://github.com/svallory/mxlang", "https://github.com/svallory/mxlang.git")
with open("extension.toml", "rb") as f:
    grammars = tomllib.load(f).get("grammars", {})
for name, g in grammars.items():
    repo = g.get("repository", "")
    if repo.startswith("file://") or repo in MONOREPO:
        if "path" not in g or "rev" not in g:
            raise SystemExit(f"[grammars.{name}] points at this repository but has no rev/path")
        print(f"{name}\t{g['rev']}\t{g['path']}")
PY
)"
[[ -n "$grammars" ]] || { echo "check-grammar-revs: no grammar in extension.toml points at this repository (file:// or https://github.com/svallory/mxlang)" >&2; exit 1; }

status=0
while IFS=$'\t' read -r name rev path; do
  if ! git cat-file -e "$rev^{commit}" 2>/dev/null; then
    echo "check-grammar-revs: [grammars.$name] rev $rev is not a commit in this repository" >&2
    status=1
    continue
  fi
  if ! git merge-base --is-ancestor "$rev" HEAD; then
    echo "check-grammar-revs: [grammars.$name] rev $rev is not an ancestor of HEAD (rebased away?); move rev to $(git log -1 --format=%H HEAD -- "$path/src")" >&2
    status=1
    continue
  fi
  if [[ -z "$(git ls-tree "$rev" -- "$path/src/parser.c")" ]]; then
    echo "check-grammar-revs: [grammars.$name] rev $rev has no $path/src/parser.c (Zed's clone would not compile)" >&2
    status=1
    continue
  fi
  at_rev="$(git rev-parse "$rev:$path/src")"
  at_head="$(git rev-parse "HEAD:$path/src")"
  if [[ "$at_rev" != "$at_head" ]]; then
    echo "check-grammar-revs: [grammars.$name] rev $rev has a different $path/src than HEAD; move rev to $(git log -1 --format=%H HEAD -- "$path/src")" >&2
    status=1
    continue
  fi
  echo "check-grammar-revs: [grammars.$name] OK ($rev, $path)"
done <<< "$grammars"
exit "$status"
