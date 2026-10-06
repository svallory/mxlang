/**
 * The probe corpus of the parser grammar (decision 165): the normative
 * content of `apps/docs/docs/architecture/parser-grammar.md` is its tables,
 * and every table row there cites the probes below that pin it.
 *
 * `grammar-spec.corpus.json` holds the probes. Each has a stable `id` (never
 * renumbered; the document cites it), the `input`, the `options` that matter
 * and `expected`: every parser event in order, rendered by `renderProbe`.
 * A probe with `todo` pins today's behaviour of a recorded defect; the fix
 * for that TODO regenerates exactly those probes.
 *
 * The corpus runs against this source copy (`grammar-spec.test.ts`) and
 * against both builds of the patched npm `htmljs-parser`
 * (`patches/htmljs-parser.test.ts`), like `mx-atoms.cases.ts`.
 *
 * `expected` is never typed by hand. To regenerate it from this source copy
 * after a parser change, then review the diff:
 *
 *   cd packages/parser
 *   GRAMMAR_SPEC_UPDATE=1 bunx vitest run --root ../.. --project @mxlang/parser grammar-spec
 *   bunx biome format --write src/template/grammar-spec.corpus.json
 *
 * Rendering, one string per event: the event name without `on`, its range
 * and what `read()` returns for it, then each other field (`key=…`); a
 * nested range is `start-end "read() text"`. An error is
 * `Error start-end CODE "message"`. A parse that throws ends with
 * `throw <ErrorName>`. With a base position the list ends with the
 * positions of the input's first and last offset.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

interface Range {
  start: number;
  end: number;
}

interface ProbeParser {
  parse(code: string, base?: ProbeOptions["base"]): void;
  read(range: Range): string;
  positionAt?(offset: number): unknown;
  offsetAt?(offset: number): unknown;
}

/** The structural subset of a parser module the probes drive. */
export interface ProbeParserModule {
  createParser(handlers: unknown): ProbeParser;
  TagType: { text: number; void: number; statement: number };
}

export const CORPUS_PATH = fileURLToPath(
  new URL("./grammar-spec.corpus.json", import.meta.url),
);

export const PROBES: Probe[] = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));

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

function renderFields(parser: ProbeParser, value: object): string {
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
    return `${value.start}-${value.end} ${text}${renderFields(parser, value)}`;
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
          out.push(`${name.slice(2)} ${renderValue(parser, event)}`);
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

/** The probes a build without the base-position API can run. */
export const PORTABLE_PROBES = PROBES.filter((probe) => !probe.options?.base);
