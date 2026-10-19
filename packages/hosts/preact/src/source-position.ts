/** File line (1-based) and column (0-based) of a UTF-16 source offset. */
export function sourcePosition(source: string, offset: number) {
  const before = source.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - (lastBreak + 1),
  };
}
