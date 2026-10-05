#!/usr/bin/env bash
#
# Acceptance gate: `tree-sitter highlight` must run without error over every
# .solid.mx fixture and example.
#
# This checks the queries load and apply — a malformed queries/highlights.scm
# fails here even when parsing is fine. Exits non-zero on any failure, and
# distinguishes "highlight ran and rejected the file" from "could not run".
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

cd "$HERE" || exit 2

mapfile -t FILES < <(
  { find "$REPO_ROOT/fixtures" -name '*.solid.mx' -type f 2>/dev/null
    find "$REPO_ROOT/examples" -name '*.solid.mx' -type f 2>/dev/null
    find "$HERE/fixtures" -name '*.solid.mx' -type f 2>/dev/null
  } | sort
)

# Zero files highlighted is a failure, not a pass — see parse-all.sh for why a
# check must assert it did work rather than only that nothing failed.
#
# Hardcoded for the same reason as parse-all.sh: an env-overridable floor can be
# set to 0 by any caller, which makes the guard advisory rather than binding.
MIN_FILES=14

# Testing hook: may only RAISE the floor, never lower it, so it cannot disable
# the guard.
if [[ -n "${MX_PARSE_FLOOR_OVERRIDE_FOR_TESTING:-}" ]]; then
  if [[ "$MX_PARSE_FLOOR_OVERRIDE_FOR_TESTING" -lt "$MIN_FILES" ]]; then
    echo "highlight-smoke: refusing to lower the file floor below $MIN_FILES" >&2
    exit 2
  fi
  MIN_FILES="$MX_PARSE_FLOOR_OVERRIDE_FOR_TESTING"
fi

if [[ ${#FILES[@]} -lt "$MIN_FILES" ]]; then
  echo "highlight-smoke: found only ${#FILES[@]} .solid.mx file(s), expected at least $MIN_FILES" >&2
  echo "  searched: $REPO_ROOT/fixtures, $REPO_ROOT/examples, $HERE/fixtures" >&2
  exit 2
fi

bad=0
total=0

for f in "${FILES[@]}"; do
  total=$((total + 1))
  rel="${f#"$REPO_ROOT"/}"

  out="$(bunx tree-sitter highlight --quiet "$f" 2>&1)"
  rc=$?

  if [[ "$rc" -ne 0 ]]; then
    printf '  %-58s FAIL\n' "$rel"
    # Show the shortest decisive line rather than the whole dump.
    grep -m1 -i 'error\|invalid\|failed' <<<"$out" | sed 's/^/      /' >&2
    bad=$((bad + 1))
  else
    printf '  %-58s ok\n' "$rel"
  fi
done

echo
echo "highlight-smoke: $total file(s); $bad failed"

if [[ "$total" -lt "$MIN_FILES" ]]; then
  echo "highlight-smoke: FAILED — processed $total file(s), expected at least $MIN_FILES" >&2
  exit 2
fi

if [[ "$bad" -ne 0 ]]; then
  echo "highlight-smoke: FAILED — $bad file(s) did not highlight" >&2
  exit 1
fi
echo "highlight-smoke: OK"
