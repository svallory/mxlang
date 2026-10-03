import { isTranslateError } from "./core.ts";

// With colours on (CI, FORCE_COLOR) Marko wraps the tail of a message in SGR
// codes, so they may follow the position.
const SGR = "(?:\\u001b\\[[0-9;]*m)*";
const BABEL_POSITION_SUFFIX = new RegExp(`\\s*\\((\\d+):(\\d+)\\)${SGR}\\s*$`);

function parserLoc(error: unknown): { line: number; column: number } | null {
  if (!error || typeof error !== "object") return null;
  const loc = (error as { loc?: unknown }).loc;
  if (!loc || typeof loc !== "object") return null;
  const direct = loc as { line?: unknown; column?: unknown; start?: unknown };
  const at = (typeof direct.line === "number" ? direct : direct.start) as
    | { line?: unknown; column?: unknown }
    | undefined;
  return typeof at?.line === "number" && typeof at.column === "number"
    ? { line: at.line, column: at.column }
    : null;
}

/**
 * Drops Babel's trailing 0-based ` (line:column)` from a parse error's message
 * when, and only when, it provably repeats the position the diagnostic already
 * carries: the error is a parser error whose `loc` (Babel's 1-based line,
 * 0-based column) names the file being compiled, and the suffix equals it.
 *
 * Anything else keeps its text. A wrapped custom-tag error (a `TranslateError`
 * raised at the caller's tag over a foreign parser's message) carries the only
 * copy of the foreign source's position. A plain `Error` may have numeric
 * `line`/`column` (Bun gives every Error its JavaScript construction site), so
 * their presence is never evidence of a positioned parse error: only a
 * parser's own `loc` object is.
 */
export function dropOwnParserPosition(error: unknown, message: string): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { file?: unknown };
    if (isTranslateError(error) || typeof e.file === "string") return message;
  }
  const loc = parserLoc(error);
  const found = BABEL_POSITION_SUFFIX.exec(message);
  if (!loc || !found) return message;
  if (Number(found[1]) !== loc.line || Number(found[2]) !== loc.column) {
    return message;
  }
  return message.slice(0, found.index);
}
