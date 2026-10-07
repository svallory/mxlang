/**
 * Brief §1.2 D: the tree differential between the MX front end and today's
 * Marko tree, over every whole-file `.mx` source in the repo and every
 * grammar-corpus input. Equal on every input except the named lists below;
 * a difference no list or rule covers fails the test.
 */
import { describe, expect, it } from "vitest";
import { parse as parseMx } from "../../parser/src/frontend/parse.ts";
import { SIX } from "../../parser/src/frontend/test-support/options.ts";
import { PROBES } from "../../parser/src/template/grammar-spec.cases.ts";
import { compare, fixtureInputs, INPUT_GLOB } from "./differential.ts";
import { markoTagShape, projectMarko } from "./marko.ts";
import { lowerToday } from "./today-lower.ts";

/**
 * Attribute start includes `async` (ast §3.5): an async method's attribute
 * starts at `async`; today's loc starts at the name. A pinned, accepted
 * difference, no mapping rule (lead, Q9).
 */
const ASYNC_METHOD_START = new Set([
  "g0095",
  "g0118",
  "g0720",
  "g0726",
  "g1418",
  "g1549",
  "g1550",
  "packages/tooling/tsc/src/fixtures/expression-values/solid-for/page.mx",
]);

/**
 * TODO `concise-eof-open-delimiter-silent` / `concise-eof-interpolation-drops-event`
 * (decision 163 addendum 9, Q8): today's tags there carry no position.
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

/** Errors PR 2b raises at its seam (ast §3.13); today's Marko-front compile throws them, so the error branch matches and no list is needed. */

/**
 * The default value's name is zero-width at the method's `(` (ast §3.5,
 * review item 6); today's sits at `async` or the type parameters' `<`.
 */
const DEFAULT_NAME_AT_PAREN = new Set([
  "g0091",
  "g0518",
  "g0721",
  "g1419",
  "g1479",
  "g1494",
]);

/** A concise head ends at its last non-whitespace character (review item 5). */
const CONCISE_HEAD_TRIMMED = new Set(["g1259", "g1356"]);

/** Today's path crashes (a TypeError, no tree, no parse error). */
const TODAY_CRASHES = new Set(["g0387", "g1699", "g1700"]);

describe(`fixtures (${INPUT_GLOB})`, () => {
  const inputs = fixtureInputs();
  it("are the whole-file .mx sources", () => {
    expect(inputs.length).toBeGreaterThan(400);
  });

  it("equal today's tree except the listed async-method starts", () => {
    const differ: string[] = [];
    for (const { path, source } of inputs) {
      const outcome = compare(source);
      if (!outcome.equal) differ.push(path);
    }
    expect(differ.filter((path) => !ASYNC_METHOD_START.has(path))).toEqual([]);
  });
});

/**
 * Where today's front end throws ITS OWN error before the sugar rule
 * (ast \u00a73.13 keeps today's text for the rules themselves):
 * - `:=1` on an empty `:name` (`<div:=1/>`, `<let/x:=1/>`): Marko's Babel
 *   "Attributes may only be bound to identifiers or member expressions"
 *   fires before `BOUND_ON_SUGAR`; MX records `MX_SUGAR_BOUND` at the sugar.
 * - `.` with arguments and no word (`<div x=a . (b) y/>`): today's attr
 *   with arguments is not sugar at all, so "Invalid attribute name `.`"
 *   fires instead of `MX_SUGAR_ARGUMENTS`.
 */
const TODAY_OWN_FIRST = new Set([
  "g0062",
  "g0330",
  "g0488",
  "g0489",
  "g1035",
  "g1355",
]);

describe("front-end rules against today's lowering (PR 2b)", () => {
  // One input: the front end's first `MX_*` error and today's lowering pass.
  const inputs = [
    ...PROBES.map((probe) => ({ id: probe.id, source: probe.input })),
    ...fixtureInputs().map(({ path, source }) => ({ id: path, source })),
  ];
  const rows = inputs.map((input) => {
    // The front end's first error (compare keeps only its own view of it).
    const document = parseMx(input.source, {
      statementKeywords: SIX,
      tagShape: markoTagShape,
    });
    const frontEnd = document.errors.find((e) => e.origin === "front-end");
    const marko = projectMarko(input.source);
    const parsedToday =
      marko.crash === undefined && marko.document.error === null;
    return { input, frontEnd, parsedToday };
  });

  it("every front-end error is today's first thrown error, same text and position", () => {
    const wrong: string[] = [];
    for (const { input, frontEnd, parsedToday } of rows) {
      if (!frontEnd || !parsedToday) continue;
      const today = lowerToday(input.source);
      if (today.ok) {
        wrong.push(
          `${input.id}: MX ${frontEnd.code}@${frontEnd.start}, today's lowering accepted it`,
        );
        continue;
      }
      if (TODAY_OWN_FIRST.has(input.id)) continue;
      if (
        today.message !== frontEnd.message ||
        today.start !== frontEnd.start
      ) {
        wrong.push(
          `${input.id}: MX ${frontEnd.code}@${frontEnd.start} ${JSON.stringify(frontEnd.message)} != today@${today.start} ${JSON.stringify(today.message)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("the named list still differs through today's own earlier error", () => {
    for (const { input, frontEnd, parsedToday } of rows) {
      if (!TODAY_OWN_FIRST.has(input.id)) continue;
      expect(frontEnd, input.id).toBeDefined();
      expect(parsedToday, input.id).toBe(true);
      const today = lowerToday(input.source);
      expect(today.ok, input.id).toBe(false);
      expect(
        today.message === frontEnd?.message && today.start === frontEnd?.start,
        input.id,
      ).toBe(false);
    }
  });
});

describe("grammar corpus inputs", () => {
  const results = PROBES.map((probe) => ({
    probe,
    outcome: compare(probe.input),
  }));

  it("every input today's path accepts is equal, except the named lists", () => {
    const unexplained = results
      .filter(({ probe, outcome }) => {
        if (outcome.equal) return false;
        return !(
          ASYNC_METHOD_START.has(probe.id) ||
          DEFAULT_NAME_AT_PAREN.has(probe.id) ||
          CONCISE_HEAD_TRIMMED.has(probe.id) ||
          SILENT_EOF.has(probe.id) ||
          TODAY_CRASHES.has(probe.id)
        );
      })
      .map(({ probe, outcome }) => ({
        id: probe.id,
        input: probe.input,
        mx: outcome.mx,
        marko: outcome.marko,
        text: outcome.text,
        note: outcome.note,
      }));
    expect(unexplained).toEqual([]);
  });

  it("each named list still differs (a fix shows up here)", () => {
    for (const { probe, outcome } of results) {
      if (
        ASYNC_METHOD_START.has(probe.id) ||
        DEFAULT_NAME_AT_PAREN.has(probe.id) ||
        CONCISE_HEAD_TRIMMED.has(probe.id) ||
        SILENT_EOF.has(probe.id)
      ) {
        expect(outcome.equal, probe.id).toBe(false);
      }
    }
  });

  it("today's path crashes on the listed inputs only", () => {
    const crashed = PROBES.filter(
      (probe) => projectMarko(probe.input).crash !== undefined,
    ).map((probe) => probe.id);
    expect(crashed.sort()).toEqual([...TODAY_CRASHES].sort());
  });

  it("the async-method difference is the attribute start alone", () => {
    const outcome = compare("<div async onClick(a) {b}/>");
    expect(outcome.mx).toEqual([
      'tag "div"@[1,4) [0,27)',
      '  · attr "onClick" [5,25) name=[11,18) method "async onClick(a) {b}"@[5,25)',
    ]);
    expect(outcome.marko).toEqual([
      'tag "div"@[1,4) [0,27)',
      '  · attr "onClick" [11,25) name=[11,18) method "async onClick(a) {b}"@[5,25)',
    ]);
  });

  it("interim: a bare `,` line is an unnamed MxTag; today's path crashes", () => {
    // Interim: PR 2b records MX_TAG_NAME_MISSING here (decision 163
    // addendum 9), never an element nobody wrote.
    const outcome = compare(",");
    expect(outcome.note).toMatch(/^today's path threw: /);
    expect(outcome.mx).toEqual(["tag (unnamed)@[1,1) [1,1)"]);
  });

  it("silent end of input: today's tags carry no position, the front end closes them at the end", () => {
    expect(compare("div(a").mx).toEqual([
      'tag "div"@[0,3) [0,5)',
      '  · args "a"@[4,5)',
    ]);
    expect(compare("div(a").marko).toEqual([
      'tag "div"@[0,3) [-1,-1)',
      '  · args "a"@[4,5)',
    ]);
    expect(compare("$ {a").mx).toEqual(["scriptlet [0,4)"]);
    expect(compare("$ {a").marko).toEqual(["scriptlet [0,5)"]);
  });
});
