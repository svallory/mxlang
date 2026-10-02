/**
 * The `:line:column` a diagnostic is printed with. Lines and columns travel
 * through the compiler as Babel/Marko give them (1-based line, 0-based
 * column); everything a person or an agent reads is 1-based, the basis
 * `mx-tsc` prints (`file(line,column)`), so the column gains one here, at the
 * print site, and nowhere else. Empty when there is no line.
 */
export function positionSuffix(line?: number, column?: number): string {
  if (line === undefined) return "";
  return column === undefined ? `:${line}` : `:${line}:${column + 1}`;
}
