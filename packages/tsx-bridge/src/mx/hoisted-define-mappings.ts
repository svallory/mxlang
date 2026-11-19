import generate, { type GeneratorOptions } from "@babel/generator";
import type { File } from "@babel/types";
import type { HoistedDefine } from "@mxlang/babel";
import type { GeneratedMapping } from "@mxlang/core";

/**
 * `@babel/generator` ships as CJS with an interop default; under
 * `esModuleInterop` the namespace can arrive as either the function itself or
 * a `{ default }` wrapper depending on the loader. Normalize once.
 */
export const generator = (
  typeof generate === "function"
    ? generate
    : (generate as { default: typeof generate }).default
) as typeof generate;

/**
 * The formatting every printed module uses (`printAst`), and the only one a
 * hoisted define is measured with here, so the text this module records is
 * the text `printAst` writes for that define.
 *
 * `retainLines` keeps generated lines aligned with the original so the second
 * source-map hop (MX text -> JSX text -> Solid's output) stays faithful, and
 * `jsescOption.minimal` stops non-ASCII text from being escaped into `\uXXXX`
 * noise that would not match the hand-written twins.
 */
export const PRINT_OPTIONS = {
  retainLines: true,
  jsescOption: { minimal: true },
} as const satisfies GeneratorOptions;

/** One hoisted define's printed text and its mappings into that text. */
interface HoistedDefineRecord {
  /** The define's declarations, printed alone with `PRINT_OPTIONS`. */
  text: string;
  /** Offsets into `text`, each checked to hold its generated text. */
  mappings: GeneratedMapping[];
}

/**
 * The records `recordHoistedDefineMappings` took for each module, read by
 * `printAst` when that module is printed. Weak, so a module nobody prints
 * leaves nothing behind.
 */
const records = new WeakMap<File, HoistedDefineRecord[]>();

/** A generator mapping: 1-based lines, 0-based UTF-16 columns. */
interface RawMapping {
  generated: { line: number; column: number };
  original?: { line: number; column: number };
}

/** A character that continues an identifier. */
const NAME_CHAR = /[\p{ID_Continue}$\u200c\u200d]/u;

/**
 * Puts every location in `snippet` on line 1, column = the node's offset.
 *
 * The module print has no locations on a hoisted define (`detachLocations`),
 * so under `retainLines` it writes the define without the authored line
 * breaks outside JSX text (`{n > 1 ?\n 'a' : 'b'}` prints on one line).
 * Printed with its own multi-line locations the snippet would get those line
 * breaks back, and its text would never occur in the module. On one line it
 * prints exactly as the module does, and a raw mapping's `original.column`
 * is the snippet offset itself.
 */
function flattenLocations(snippet: File): void {
  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const { start, end, loc } = record;
    if (
      typeof start === "number" &&
      typeof end === "number" &&
      loc !== null &&
      typeof loc === "object"
    ) {
      record.loc = {
        ...loc,
        start: { line: 1, column: start, index: start },
        end: { line: 1, column: end, index: end },
      };
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== "loc" && key !== "extra") visit(child);
    }
  };
  visit(snippet);
}

/** The offset of each line's first character in `text`. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/**
 * Records where `entry.mappings` land when `snippet` — `entry.code` parsed on
 * its own, still carrying its snippet locations (flattened onto line 1 here)
 * — is printed, for `printAst`
 * to rebase onto `file`'s printed module. The hoisted declarations are
 * spliced into `file` without locations (a location would move the printed
 * module under `retainLines`), so the generator's source map cannot carry
 * them.
 *
 * `snippet` is printed alone with `PRINT_OPTIONS`; the generator's raw
 * mappings give, for each snippet position a token starts at, where the
 * printed text has it. A mapping is kept only when its `generatedStart` is
 * such a position and the printed text there equals the mapping's generated
 * text in `entry.code`, ending where a name ends there too. An identity copy
 * (source and generated lengths equal) whose text the printer reformatted is
 * split instead, at the token starts inside it, into the pieces whose printed
 * text still equals the snippet's. Any other mapping is dropped, never
 * guessed.
 */
export function recordHoistedDefineMappings(
  file: File,
  snippet: File,
  entry: HoistedDefine,
): void {
  if (!entry.mappings?.length) return;
  flattenLocations(snippet);
  const printed = generator(snippet, {
    ...PRINT_OPTIONS,
    sourceMaps: true,
    sourceFileName: "hoisted-define",
  });
  const raw = (printed as unknown as { rawMappings?: RawMapping[] })
    .rawMappings;
  if (!raw) return;
  const printedLines = lineStarts(printed.code);
  // Snippet offset -> printed offset, first mapping per original position.
  // Every snippet location is on line 1, so `original.column` is the offset.
  const printedAt = new Map<number, number>();
  for (const { generated, original } of raw) {
    if (!original) continue;
    const to = printedLines[generated.line - 1];
    if (to === undefined) continue;
    if (!printedAt.has(original.column)) {
      printedAt.set(original.column, to + generated.column);
    }
  }
  const tokenStarts = [...printedAt.keys()].sort((a, b) => a - b);
  // A match that ends inside a longer name in the printed text is not that
  // name: `__mx_DefineRow1` is a prefix of the collision rename
  // `__mx_DefineRow1_2`.
  const endsAlike = (snippetEnd: number, printedEnd: number) =>
    !NAME_CHAR.test(entry.code[snippetEnd - 1] ?? "") ||
    NAME_CHAR.test(entry.code[snippetEnd] ?? "") ===
      NAME_CHAR.test(printed.code[printedEnd] ?? "");
  const mappings: GeneratedMapping[] = [];
  for (const mapping of entry.mappings) {
    const use = mapping.use ? { use: mapping.use } : {};
    const start = printedAt.get(mapping.generatedStart);
    const text = entry.code.slice(mapping.generatedStart, mapping.generatedEnd);
    if (
      start !== undefined &&
      printed.code.slice(start, start + text.length) === text &&
      endsAlike(mapping.generatedEnd, start + text.length)
    ) {
      mappings.push({
        generatedStart: start,
        generatedEnd: start + text.length,
        sourceStart: mapping.sourceStart,
        sourceEnd: mapping.sourceEnd,
        ...use,
      });
      continue;
    }
    // The printer reformatted the run (`{ go() }` printed as `{go();}`). An
    // identity copy maps offset k onto `sourceStart + k`, so it splits
    // exactly: from each token start inside it, the run of text the printer
    // kept up to the next token start maps onto the matching source text.
    if (mapping.sourceEnd - mapping.sourceStart !== text.length) continue;
    const inside = tokenStarts.filter(
      (offset) =>
        offset >= mapping.generatedStart && offset < mapping.generatedEnd,
    );
    inside.forEach((offset, index) => {
      const at = printedAt.get(offset) as number;
      const limit = (inside[index + 1] ?? mapping.generatedEnd) - offset;
      let length = 0;
      while (
        length < limit &&
        entry.code[offset + length] === printed.code[at + length]
      ) {
        length++;
      }
      if (length === 0 || !endsAlike(offset + length, at + length)) return;
      const shift = offset - mapping.generatedStart;
      mappings.push({
        generatedStart: at,
        generatedEnd: at + length,
        sourceStart: mapping.sourceStart + shift,
        sourceEnd: mapping.sourceStart + shift + length,
        ...use,
      });
    });
  }
  if (mappings.length === 0) return;
  const list = records.get(file) ?? [];
  list.push({ text: printed.code, mappings });
  records.set(file, list);
}

/**
 * The recorded hoisted-define mappings of `file`, rebased onto `code`, the
 * module `printAst` printed from it. A record whose printed text does not
 * occur in `code` exactly once is skipped: where it landed is not known.
 */
export function hoistedDefineMappings(
  file: File,
  code: string,
): GeneratedMapping[] {
  const mappings: GeneratedMapping[] = [];
  for (const record of records.get(file) ?? []) {
    const at = code.indexOf(record.text);
    if (at < 0 || code.indexOf(record.text, at + 1) >= 0) continue;
    for (const mapping of record.mappings) {
      mappings.push({
        ...mapping,
        generatedStart: mapping.generatedStart + at,
        generatedEnd: mapping.generatedEnd + at,
      });
    }
  }
  return mappings;
}
