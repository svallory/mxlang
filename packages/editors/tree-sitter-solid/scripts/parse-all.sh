#!/usr/bin/env bash
#
# Acceptance gate: every .solid.mx fixture and example must parse with zero
# ERROR and zero MISSING nodes.
#
# Reports a per-file count and exits non-zero if any file is bad OR if the parse
# could not be run at all. Those two cases print differently on purpose: a
# harness that collapses "ran, result was bad" into "clean" proves nothing.
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

# A check must assert it did work, not merely that it found no failures: zero
# errors across zero files satisfies every "no failures" predicate. So require a
# floor on the number of files actually parsed. Raise MIN_FILES when fixtures
# are added; a drop below it means the search found less than it should, which
# is a failure even though nothing "failed".
#
# The floor is HARDCODED, deliberately. It was briefly an env override
# (MX_MIN_PARSE_FILES), which meant any caller — including CI — could set it to
# 0 and turn the guard off, making it a floor by convention rather than a floor.
# A guard whose stated purpose is to be non-bypassable must not ship with a
# documented bypass.
#
# For testing the guard itself there is an explicit, obviously-named opt-out
# below that can only RAISE the requirement, never lower it.
MIN_FILES=14

# Testing hook: raise the floor to prove the guard fires. It cannot lower the
# floor, so it cannot be used to disable the check.
if [[ -n "${MX_PARSE_FLOOR_OVERRIDE_FOR_TESTING:-}" ]]; then
  if [[ "$MX_PARSE_FLOOR_OVERRIDE_FOR_TESTING" -lt "$MIN_FILES" ]]; then
    echo "parse-all: refusing to lower the file floor below $MIN_FILES" >&2
    echo "  (the override exists to prove the guard fires, not to disable it)" >&2
    exit 2
  fi
  MIN_FILES="$MX_PARSE_FLOOR_OVERRIDE_FOR_TESTING"
fi

if [[ ${#FILES[@]} -lt "$MIN_FILES" ]]; then
  echo "parse-all: found only ${#FILES[@]} .solid.mx file(s), expected at least $MIN_FILES" >&2
  echo "  searched: $REPO_ROOT/fixtures, $REPO_ROOT/examples, $HERE/fixtures" >&2
  echo "  (a short list means the search is wrong, not that everything passed)" >&2
  exit 2
fi

bad=0
failed_to_run=0
total=0

for f in "${FILES[@]}"; do
  total=$((total + 1))
  rel="${f#"$REPO_ROOT"/}"

  # `tree-sitter parse` exits non-zero BOTH for a tree containing ERROR/MISSING
  # nodes and for an outright invocation failure (bad grammar, bad args, a
  # crash). The exit code is therefore the authoritative signal that something
  # went wrong; the output only tells us WHICH of the two it was.
  #
  # Do not invert this. Deciding from the output alone means anything that dies
  # without printing a recognised phrase — a segfault, an OOM kill, a message
  # this script never anticipated — yields errors=0/missing=0 and reports
  # `ERROR=0 MISSING=0`, i.e. a green gate for a run that never happened. That
  # is the defect `ec21bc0` fixed in packages/editors/zed/scripts/
  # parse-fixtures.sh; the same rule applies here.
  out="$(bunx tree-sitter parse "$f" 2>&1)"
  rc=$?

  # `grep -c` rather than `grep -o | wc -l`: grep exits 1 when it matches
  # nothing, which on a CLEAN file would abort the script under `set -e`.
  # `|| true` keeps the no-match exit from propagating either way.
  errors=$(grep -c 'ERROR' <<<"$out" || true)
  missing=$(grep -c 'MISSING' <<<"$out" || true)

  if [[ "$rc" -ne 0 ]]; then
    if [[ "$errors" -ne 0 || "$missing" -ne 0 ]]; then
      # It did parse, just not cleanly.
      printf '  %-58s ERROR=%s MISSING=%s  <-- FAIL\n' "$rel" "$errors" "$missing"
      bad=$((bad + 1))
    else
      # Non-zero with no ERROR/MISSING node printed: the parse never ran.
      printf '  %-58s COULD NOT RUN (exit %s)\n' "$rel" "$rc"
      grep -m1 -i 'error\|failed\|not found\|fault' <<<"$out" | sed 's/^/      /' >&2
      failed_to_run=$((failed_to_run + 1))
    fi
    continue
  fi

  # rc == 0. A clean exit with ERROR/MISSING text would be a contradiction;
  # treat it as a failure rather than trusting either signal over the other.
  if [[ "$errors" -ne 0 || "$missing" -ne 0 ]]; then
    printf '  %-58s ERROR=%s MISSING=%s  <-- FAIL (exit 0)\n' "$rel" "$errors" "$missing"
    bad=$((bad + 1))
  else
    printf '  %-58s ERROR=0 MISSING=0\n' "$rel"
  fi
done

echo
echo "parse-all: $total file(s); $bad with errors; $failed_to_run could not run"

# Re-assert the floor on what was actually processed, not just what was found:
# the loop above must have run for every file.
if [[ "$total" -lt "$MIN_FILES" ]]; then
  echo "parse-all: FAILED — processed $total file(s), expected at least $MIN_FILES" >&2
  exit 2
fi

if [[ "$failed_to_run" -ne 0 ]]; then
  echo "parse-all: FAILED — some files could not be parsed at all" >&2
  exit 2
fi
if [[ "$bad" -ne 0 ]]; then
  echo "parse-all: FAILED — $bad file(s) had ERROR or MISSING nodes" >&2
  exit 1
fi
echo "parse-all: OK"
