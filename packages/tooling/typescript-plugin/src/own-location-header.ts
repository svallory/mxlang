import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

// `\r?` before the end: a CRLF message keeps its `\r` on every line once
// split on "\n", and the `\r` defeated the match (the header was kept).
const AT_LINE = /^[ \t]*at (.+):(\d+):(\d+)[ \t]*\r?$/;

/** Every spelling of `p` that can name the same file: lexical resolve, plus its realpath when the path exists. */
function pathIdentities(p: string): string[] {
  const resolved = resolve(p);
  try {
    return [...new Set([resolved, realpathSync(resolved)])];
  } catch {
    // Missing file: the lexical resolve is the only spelling it has.
    return [resolved];
  }
}

/** Whether two spellings name the same file: `resolve`/`realpathSync` of both sides, never the raw strings. */
function sameFile(a: string, b: string): boolean {
  const identities = new Set(pathIdentities(a));
  return pathIdentities(b).some((identity) => identities.has(identity));
}

/**
 * Drops Marko's `    at <path>:L:C` line from a compile error message when it
 * names the diagnosed file itself.
 *
 * `@marko/compiler` prints that line above the code frame. The diagnostic
 * already carries the file and position (`file(L,C)` in `mx-tsc`, the range in
 * an editor), so the line only repeats them. A line naming another file (an
 * error inside a callee tag) is the only place that file is named and stays.
 * Marko prints the path relative to the cwd, so both spellings are resolved
 * before comparing — and realpath'd as well, so a relative or symlinked
 * `fileName` still matches. Kleur colourises the line under `FORCE_COLOR`
 * (path, line and column each wrapped in SGR runs), so the match runs on a
 * VT-stripped copy; lines that stay keep their original text. Generic path
 * logic only (decision 126).
 */
export function dropOwnLocationHeader(
  message: string,
  fileName: string,
): string {
  return message
    .split("\n")
    .filter((line) => {
      // The `at` line is matched on a VT-stripped copy: kleur colours the
      // path and numbers under FORCE_COLOR, and the raw line would never
      // reach the identity comparison. Kept lines return untouched.
      const found = AT_LINE.exec(stripVTControlCharacters(line));
      return !(found && sameFile(found[1] as string, fileName));
    })
    .join("\n");
}
