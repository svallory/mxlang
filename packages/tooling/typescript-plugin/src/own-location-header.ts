import { resolve } from "node:path";

const AT_LINE = /^[ \t]*at (.+):(\d+):(\d+)[ \t]*$/;

/**
 * Drops Marko's `    at <path>:L:C` line from a compile error message when it
 * names the diagnosed file itself.
 *
 * `@marko/compiler` prints that line above the code frame. The diagnostic
 * already carries the file and position (`file(L,C)` in `mx-tsc`, the range in
 * an editor), so the line only repeats them. A line naming another file (an
 * error inside a callee tag) is the only place that file is named and stays.
 * Marko prints the path relative to the cwd, so both spellings are resolved
 * before comparing.
 */
export function dropOwnLocationHeader(
  message: string,
  fileName: string,
): string {
  const own = resolve(fileName);
  return message
    .split("\n")
    .filter((line) => {
      const found = AT_LINE.exec(line);
      return !(found && resolve(found[1] as string) === own);
    })
    .join("\n");
}

// Marko wraps the tail of a message in SGR codes when colour is on (CI,
// FORCE_COLOR), so they may follow the position.
const SGR = "(?:\\u001b\\[[0-9;]*m)*";
const BABEL_POSITION_SUFFIX = new RegExp(`\\s*\\(\\d+:\\d+\\)${SGR}\\s*$`);

/**
 * Drops Babel's trailing 0-based ` (line:column)` from a compile error message.
 *
 * Babel appends it to every syntax error. The diagnostic's own range already
 * carries the position (1-based in `mx-tsc`'s `file(L,C)`, a range in an
 * editor), so the suffix is a second, differently-based spelling of it, and
 * beside Marko's 1-based ` at L:C` opener annotation it puts two bases in one
 * sentence. Anchored to the end, so `(foo)` and `(1)` endings stay.
 *
 * Call it only where the diagnostic carries a position of its own.
 */
export function dropBabelPositionSuffix(message: string): string {
  return message.replace(BABEL_POSITION_SUFFIX, "");
}
