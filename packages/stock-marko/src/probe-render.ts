/**
 * A local copy of `@mxlang/parser`'s `renderProbe` and its types
 * (`packages/parser/src/template/grammar-spec.cases.ts`), duplicated because
 * that file is not part of the parser package's public exports and the brief
 * forbids changing `packages/parser` in this branch. Keep byte-identical
 * rendering so stock and MX event streams compare directly.
 */

export interface ProbeOptions {
  /** `false`: `onOpenTagName` types no tag as a statement. */
  statements?: boolean;
  /** The base position handed to `parse` (source copy only). */
  base?: { startOffset: number; startLine: number; startColumn: number };
}

export interface Probe {
  id: string;
  input: string;
  options?: ProbeOptions;
  /** The TODO whose fix changes this probe's expected events. */
  todo?: string;
  expected: string[];
}

type SerializedPosition = Record<string, unknown>;

interface Range {
  start: number;
  end: number;
}

export interface ProbeParser {
  parse(code: string, base?: ProbeOptions["base"]): void;
  read(range: Range): string;
  positionAt?(offset: number): SerializedPosition | undefined;
  offsetAt?(offset: number): SerializedPosition | undefined;
}

/** The structural subset of a parser module the probes drive. */
export interface ProbeParserModule {
  createParser(handlers: unknown): ProbeParser;
  TagType: { text: number; void: number; statement: number };
}

// The tag types the probes' consumer returns from `onOpenTagName`: core's
// text tags, its statement set and two void tags.
const TEXT_TAGS = new Set([
  "script",
  "style",
  "textarea",
  "html-comment",
  "html-script",
  "html-style",
]);
const STATEMENT_TAGS = new Set([
  "static",
  "import",
  "export",
  "server",
  "client",
  "class",
]);
const VOID_TAGS = new Set(["input", "br"]);

const isRange = (value: unknown): value is Range =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Range).start === "number" &&
  typeof (value as Range).end === "number";

function renderFields(
  parser: ProbeParser,
  value: Record<string, unknown>,
): string {
  let out = "";
  for (const [key, field] of Object.entries(value)) {
    if (key === "start" || key === "end" || field === undefined) continue;
    out += ` ${key}=${renderValue(parser, field)}`;
  }
  return out;
}

function renderValue(parser: ProbeParser, value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => renderValue(parser, item)).join(", ")}]`;
  }
  if (isRange(value)) {
    const text = JSON.stringify(parser.read(value));
    // SAFETY: Range's fields are string-keyed numerics; Object.entries only reads them.
    return `${value.start}-${value.end} ${text}${renderFields(parser, value as unknown as Record<string, unknown>)}`;
  }
  return JSON.stringify(value);
}

export function renderProbe(mod: ProbeParserModule, probe: Probe): string[] {
  const { input, options = {} } = probe;
  const out: string[] = [];
  const handlers = new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string" || !name.startsWith("on")) {
          return undefined;
        }
        return (event: Range & { code?: string; message?: string }) => {
          if (name === "onError") {
            out.push(
              `Error ${event.start}-${event.end} ${event.code} ${JSON.stringify(event.message)}`,
            );
            return undefined;
          }
          // SAFETY: event is a range-like event object; renderValue only reads its own enumerable fields.
          out.push(
            `${name.slice(2)} ${renderValue(parser, event as unknown as Record<string, unknown>)}`,
          );
          if (name !== "onOpenTagName") return undefined;
          const tag = input.slice(event.start, event.end);
          if (TEXT_TAGS.has(tag)) return mod.TagType.text;
          if (VOID_TAGS.has(tag)) return mod.TagType.void;
          if (options.statements !== false && STATEMENT_TAGS.has(tag)) {
            return mod.TagType.statement;
          }
          return undefined;
        };
      },
    },
  );
  const parser = mod.createParser(handlers);
  try {
    if (options.base) parser.parse(input, options.base);
    else parser.parse(input);
  } catch (err) {
    out.push(`throw ${(err as Error).name}`);
  }
  if (options.base) {
    out.push(
      `positionAt(0)=${JSON.stringify(parser.positionAt?.(0))}`,
      `positionAt(${input.length})=${JSON.stringify(parser.positionAt?.(input.length))}`,
      `offsetAt(0)=${JSON.stringify(parser.offsetAt?.(0))}`,
    );
  }
  return out;
}
