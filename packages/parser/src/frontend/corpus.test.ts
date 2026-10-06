/**
 * Brief §1.2 C: every probe of the parser grammar corpus
 * (`../template/grammar-spec.corpus.json`) through the front end. Each parses
 * without throwing, its template error equals the probe's pinned error code
 * and range, the span invariant holds, every atom the parser announced is in
 * exactly one container, and the tree's projection equals the committed
 * snapshot `corpus.snapshot.json`, so a later PR sees any change.
 *
 * To regenerate the snapshot after a deliberate change, then review its diff:
 *
 *   cd packages/parser
 *   FRONTEND_SNAPSHOT_UPDATE=1 bunx vitest run --root ../.. --project @mxlang/parser frontend/corpus
 *   bunx biome format --write src/frontend/corpus.snapshot.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MxBodyMode, MxStatementKeyword } from "@mxlang/babel/mx-ast";
import { describe, expect, it } from "vitest";
import { PROBES, type Probe } from "../template/grammar-spec.cases.ts";
import { createParser, ErrorCode } from "../template/index.ts";
import { parse, seams } from "./parse.ts";
import { allAtoms, checkInvariants } from "./test-support/invariants.ts";
import { SIX } from "./test-support/options.ts";
import { projectDocument } from "./test-support/project.ts";

const SNAPSHOT = fileURLToPath(
  new URL("./corpus.snapshot.json", import.meta.url),
);

// The corpus consumer's tag types (`grammar-spec.cases.ts`), as body modes.
const TEXT = new Set([
  "script",
  "style",
  "textarea",
  "html-comment",
  "html-script",
  "html-style",
]);
const VOID = new Set(["input", "br"]);
const tagShape = (name: string): MxBodyMode =>
  TEXT.has(name) ? "parsed-text" : VOID.has(name) ? "void" : "html";
const NONE: ReadonlySet<MxStatementKeyword> = new Set();

/**
 * Decision 163 addendum 7 item 4: the corpus consumer answers "statement"
 * for an HTML-mode `<static …>`, so these probes pin RESERVED_TAG_NAME; the
 * front end answers `tagShape` there and records no template error. PR 2b's
 * MX_STATEMENT_IN_HTML_MODE takes their place.
 */
const STATEMENT_IN_HTML_MODE = new Set(["g0234", "g1274"]);

/**
 * Silent end of input, TODO `concise-eof-open-delimiter-silent` and TODO
 * `concise-eof-interpolation-drops-event` (parser-grammar OQ 19): the parser
 * stops with no error and no close events. The front end closes the open
 * tags there and clamps ranges past the input (decision 163 addendum 9, Q8).
 * The parser fix changes exactly these probes.
 */
const SILENT_EOF = new Set([
  "g0368",
  "g0370",
  "g0373",
  "g0374",
  "g0375",
  "g0376",
  "g0377",
  "g0378",
  "g0380",
  "g0382",
  "g0866",
  "g1318",
  "g1325",
  "g1329",
  "g1522",
]);

const CODE_NAMES = new Map(
  Object.entries(ErrorCode).map(([name, code]) => [String(code), name]),
);

function run(probe: Probe) {
  const base = probe.options?.base;
  return parse(probe.input, {
    statementKeywords: probe.options?.statements === false ? NONE : SIX,
    tagShape,
    ...(base
      ? {
          base: {
            offset: base.startOffset,
            line: base.startLine,
            column: base.startColumn,
          },
        }
      : {}),
  });
}

/** The atoms the template parser announces for `input`, as `[start, end)` strings. */
function announcedAtoms(probe: Probe): string[] {
  const found: string[] = [];
  const statements = probe.options?.statements !== false;
  const parser = createParser({
    onAtom: (e) => found.push(`${e.start},${e.end}`),
    onOpenTagName: (e) => {
      const name = probe.input.slice(e.start, e.end);
      if (
        statements &&
        SIX.has(name as MxStatementKeyword) &&
        probe.input[e.start - 1] !== "<"
      ) {
        return 3;
      }
      if (TEXT.has(name)) return 1;
      if (VOID.has(name)) return 2;
      return undefined;
    },
  });
  try {
    parser.parse(probe.input);
  } catch {
    // a throwing probe is reported by the no-throw test
  }
  return found;
}

describe("the grammar corpus through the front end", () => {
  const results = PROBES.map((probe) => {
    let document: ReturnType<typeof run> | undefined;
    let thrown: unknown;
    let clamps = 0;
    const clamped = seams.clamped;
    seams.clamped = () => {
      clamps++;
    };
    try {
      document = run(probe);
    } catch (error) {
      thrown = error;
    } finally {
      seams.clamped = clamped;
    }
    return { probe, document, thrown, clamps };
  });

  it("the range clamp fires only on the silent end-of-input probes", () => {
    const fired = results.filter((r) => r.clamps > 0).map((r) => r.probe.id);
    expect(fired.every((id) => SILENT_EOF.has(id))).toBe(true);
    expect(fired.length).toBeGreaterThan(0);
  });

  it("silent end of input: the open tags are closed, no error, today's shape", () => {
    for (const { probe, document } of results) {
      if (!SILENT_EOF.has(probe.id) || !document) continue;
      expect(document.errors, probe.id).toEqual([]);
      expect(document.complete, probe.id).toBe(true);
      expect(
        document.body.every((c) => c.end <= document.end),
        probe.id,
      ).toBe(true);
    }
  });

  it(`parses all ${PROBES.length} probes without throwing`, () => {
    expect(PROBES.length).toBeGreaterThanOrEqual(1688);
    expect(results.filter((r) => r.thrown).map((r) => r.probe.id)).toEqual([]);
    expect(
      results
        .filter((r) =>
          r.document?.errors.some((e) => e.code === "MX_FRONT_END_INTERNAL"),
        )
        .map((r) => r.probe.id),
    ).toEqual([]);
  });

  it("each tree's template error is the probe's pinned error", () => {
    const wrong: string[] = [];
    for (const { probe, document } of results) {
      if (!document) continue;
      const pinned = probe.expected.find((line) => line.startsWith("Error "));
      const offset = document.base.offset;
      const actual = document.errors.find((e) => e.origin === "template");
      const rendered = actual
        ? `Error ${actual.start - offset}-${actual.end - offset} ${actual.code}`
        : undefined;
      const expected = pinned?.replace(
        /^Error (\d+-\d+) (\d+) .*$/,
        (_, range, code) => `Error ${range} ${CODE_NAMES.get(code)}`,
      );
      if (STATEMENT_IN_HTML_MODE.has(probe.id)) {
        if (rendered !== undefined) {
          wrong.push(`${probe.id}: expected no template error`);
        }
        continue;
      }
      if (rendered !== expected)
        wrong.push(`${probe.id}: ${rendered} != ${expected}`);
      if (document.complete !== !actual)
        wrong.push(`${probe.id}: complete flag`);
    }
    expect(wrong).toEqual([]);
  });

  it("the span invariant holds on every tree", () => {
    const broken = results.flatMap(({ probe, document }) =>
      document
        ? checkInvariants(document).map(
            (p) => `${probe.id} ${JSON.stringify(probe.input)}: ${p}`,
          )
        : [],
    );
    expect(broken).toEqual([]);
  });

  it("every announced atom is in exactly one container (complete parses)", () => {
    const wrong: string[] = [];
    for (const { probe, document } of results) {
      if (!document) continue;
      const offset = document.base.offset;
      const listed = allAtoms(document).map(
        (a) => `${a.start - offset},${a.end - offset}`,
      );
      const announced = announcedAtoms(probe);
      if (document.complete) {
        if (
          JSON.stringify([...listed].sort()) !==
          JSON.stringify([...announced].sort())
        ) {
          wrong.push(`${probe.id}: listed ${listed} announced ${announced}`);
        }
      } else if (
        listed.some((a) => !announced.includes(a)) ||
        new Set(listed).size !== listed.length
      ) {
        wrong.push(
          `${probe.id}: incomplete parse lists an atom twice or one not announced`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("the projections equal the committed snapshot", () => {
    const projected: Record<string, string[]> = {};
    for (const { probe, document } of results) {
      if (document) projected[probe.id] = projectDocument(document);
    }
    if (process.env.FRONTEND_SNAPSHOT_UPDATE) {
      writeFileSync(SNAPSHOT, `${JSON.stringify(projected, null, 2)}\n`);
    }
    expect(projected).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
  });
});
