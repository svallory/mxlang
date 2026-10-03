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
