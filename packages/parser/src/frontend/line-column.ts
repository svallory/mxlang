/**
 * `lineColumnAt(document, offset)` (ast §5.2, decision 163 addendum 6): a
 * file offset to a 1-based line and 0-based column, the fragment base
 * applied (ast §5.3). The line-start index is private: the document stays
 * plain data.
 */
import type { MxFragmentBase } from "@mxlang/babel/mx-ast";

interface Indexed {
  readonly source: string;
  readonly base: MxFragmentBase;
}

const LINE_STARTS = new WeakMap<Indexed, readonly number[]>();

/** Offsets where each line of `source` starts; only `\n` starts a line, as in htmljs's `getLines`. */
function lineStarts(document: Indexed): readonly number[] {
  let starts = LINE_STARTS.get(document);
  if (!starts) {
    const found = [0];
    const { source } = document;
    for (
      let at = source.indexOf("\n");
      at !== -1;
      at = source.indexOf("\n", at + 1)
    ) {
      found.push(at + 1);
    }
    starts = found;
    LINE_STARTS.set(document, starts);
  }
  return starts;
}

export function lineColumnAt(
  document: Indexed,
  offset: number,
): { line: number; column: number } {
  const local = offset - document.base.offset;
  if (!Number.isInteger(local) || local < 0 || local > document.source.length) {
    throw new RangeError(
      `lineColumnAt: offset ${offset} is outside the document [${document.base.offset}, ${document.base.offset + document.source.length}]`,
    );
  }
  const starts = lineStarts(document);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] as number) <= local) low = mid;
    else high = mid - 1;
  }
  const column = local - (starts[low] as number);
  return {
    line: 1 + document.base.line + low,
    column: low === 0 ? column + document.base.column : column,
  };
}
