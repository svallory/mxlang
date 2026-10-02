/**
 * Stands in for a target package's *own* copy of `@mxlang/core`.
 *
 * A real one would import `@mxlang/core`'s built `dist`. Core's TypeScript
 * source cannot play that part here: it uses parameter properties, which
 * Node's strip-only loader (the one `loadTargetDescriptor` runs under)
 * rejects, and `dist` does not exist until `bun run build`. What the fixture
 * needs from a second copy is only its observable property: a class with
 * `TranslateError`'s name that is not the tool's `TranslateError`.
 */
export class TranslateError extends Error {
  override readonly name = "TranslateError";
  readonly line: number;
  readonly column: number;
  readonly file?: string;

  constructor(message: string, line: number, column: number, file?: string) {
    super(message);
    this.line = line;
    this.column = column;
    if (file !== undefined) this.file = file;
  }
}
