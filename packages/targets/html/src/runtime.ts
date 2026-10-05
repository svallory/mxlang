/**
 * `@mxlang/html/runtime` — the output sink a compiled template renders into
 * (decision 155, the Marko render model).
 *
 * Every compiled unit has two entries: `render(input, out)`, which writes its
 * HTML to `out` and returns the unit's `<return>` value, and a default export
 * `(input) => string`, which creates an `Out`, calls `render`, and returns the
 * string. A tag call between units passes the caller's `out` down, so the
 * output of a whole tree lands in one sink and a `<return>` value never
 * travels inside it.
 *
 * `Out` is deliberately small: it is the seam a streaming implementation will
 * replace later without touching emitted code. Emitted code only ever calls
 * `createOut()`, `createBufferedOut()`, `write`, `toString` and `commit`.
 *
 * Nothing here depends on the compiler, so a compiled module's runtime stays
 * at `escape` plus these two functions.
 */

/** Where a compiled template writes its HTML. */
export interface Out {
  /** Appends already-escaped HTML. */
  write(html: string): void;
  /** Everything written so far. */
  toString(): string;
}

/**
 * A sink that holds its output until `commit()` hands it to its parent.
 *
 * `<try>` renders its body into one: when the body throws, the buffered
 * output is dropped and `<@catch>` renders into the parent instead, so a
 * half-rendered body never reaches the page. A streaming sink can flush the
 * parent up to this point and hold only the buffered part.
 */
export interface BufferedOut extends Out {
  /**
   * Writes the buffered output to the parent sink.
   *
   * Call it once, after the last write. It is not enforced: a second call
   * writes the buffer again, and a write after the call never reaches the
   * parent. Emitted code commits exactly once, as the last statement of a
   * `<try>` body.
   */
  commit(): void;
}

/** A new string-buffer sink: what a template's default export renders into. */
export function createOut(): Out {
  let html = "";
  return {
    write(chunk) {
      html += chunk;
    },
    toString() {
      return html;
    },
  };
}

/** A sink buffered on top of `parent`, for `<try>`. See {@link BufferedOut}. */
export function createBufferedOut(parent: Out): BufferedOut {
  const buffer = createOut();
  return {
    write: buffer.write,
    toString: buffer.toString,
    commit() {
      parent.write(buffer.toString());
    },
  };
}
