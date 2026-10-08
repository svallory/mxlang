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

/**
 * PR 3's expression differential: Babel 7.29.8 (MX's fork) ends
 * `Unexpected token, expected ","` with a period where Marko's bundled
 * 7.29.7 does not. The only difference on these inputs; the wording goes to
 * the lead as a decision (brief §1.2.3: version differences are measured,
 * not mapped away).
 */
const BABEL_MESSAGE_PERIOD = new Set([
  "g0259",
  "packages/hosts/hono/src/fixtures/region/for-by/input.hono.mx",
]);

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
    expect(
      differ
        .filter((path) => !ASYNC_METHOD_START.has(path))
        .filter((path) => !BABEL_MESSAGE_PERIOD.has(path)),
    ).toEqual([]);
  });
});

/**
 * Where today's front end throws ITS OWN error before the sugar rule
 * (ast \u00a73.13 keeps today's text for the rules themselves). Seven inputs;
 * the test below pins each one's exact today-first reason, so a rule change
 * that moves an entry into or out of this list fails there:
 * - `:=1` on an empty `:name` (`<div:=1/>`, `<let/x:=1/>`, `let/x:=1`,
 *   `<div :=1/>`, `<let/x :=1/>`): Marko's binding error "Attributes may
 *   only be bound to identifiers or member expressions" fires before
 *   `BOUND_ON_SUGAR`; MX records `MX_SUGAR_BOUND` at the sugar.
 * - `.` with arguments and no word (`<div x=a . (b) y/>`): today's attr
 *   with arguments is not sugar at all, so "Invalid attribute name `.`"
 *   fires instead of `MX_SUGAR_ARGUMENTS`.
 * - `=>` after a sugar attribute value (`(a) :É => a`, g1715): today's
 *   parser itself rejects the value (`Unexpected token` at the `>` of
 *   `=>`), so its parse error fires before `MX_SUGAR_NAME_INVALID`.
 */
const TODAY_OWN_FIRST = new Set([
  // `<div x=$!{a}/>`: today's Marko-front compile throws the Babel error as
  // an aggregate frame ("at s.mx:1:10"), not MX's dedicated code with the
  // same sentence at the same point.
  "g0755",
  "g0062",
  "g0330",
  "g0488",
  "g0489",
  "g1035",
  "g1355",
  "g1715",
]);

/** Each TODAY_OWN_FIRST entry's own expected first error from today (offset + message). */
const TODAY_OWN_REASON: Record<string, { start: number; message: string }> = {
  g0755: {
    start: 9,
    message: "at s.mx:1:10",
  },
  g0062: {
    start: 6,
    message:
      "Attributes may only be bound to identifiers or member expressions",
  },
  g0330: {
    start: 9,
    message:
      "Invalid attribute name `.`; Marko rejects it too — an attribute name may use letters, digits and `._:-`",
  },
  g0488: {
    start: 8,
    message:
      "Attributes may only be bound to identifiers or member expressions",
  },
  g0489: {
    start: 7,
    message:
      "Attributes may only be bound to identifiers or member expressions",
  },
  g1035: {
    start: 7,
    message:
      "Attributes may only be bound to identifiers or member expressions",
  },
  g1355: {
    start: 9,
    message:
      "Attributes may only be bound to identifiers or member expressions",
  },
  g1715: {
    start: 8,
    message: "at s.mx:1:9",
  },
};

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

  it("the named list differs through today's own earlier error, each for its pinned reason", () => {
    for (const { input, frontEnd, parsedToday } of rows) {
      if (!TODAY_OWN_FIRST.has(input.id)) continue;
      expect(frontEnd, input.id).toBeDefined();
      expect(parsedToday, input.id).toBe(true);
      const today = lowerToday(input.source);
      expect(today.ok, input.id).toBe(false);
      const reason = TODAY_OWN_REASON[input.id];
      expect({ start: today.start, message: today.message }, input.id).toEqual(
        reason,
      );
      expect(
        today.message === frontEnd?.message && today.start === frontEnd?.start,
        input.id,
      ).toBe(false);
    }
  });
});

/**
 * The curated reverse calibration matrix (review F8): the fixes from the
 * review — compound bound chains, node-kind bindability, unnamed and
 * trailing colons, the `div` fallback, nested silent-EOF tags — pinned in
 * the reverse direction. Each row states today's first error exactly, so a
 * rule that stops firing (or drifts) fails here even when the corpus never
 * contained the shape.
 */
const REVERSE_MATRIX: readonly {
  id: string;
  source: string;
  /** `null`: no front-end error. */
  mx: { code: string; start: number; message: string } | null;
  /** Today's first error; `null`: today accepts it. */
  today: { start: number; message: string } | null;
}[] = [
  {
    id: "bound-compound-dot",
    source: "<div .c:n:=x/>",
    mx: {
      code: "MX_SUGAR_BOUND",
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
    today: {
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
  },
  {
    id: "bound-compound-dot-value-ignored",
    source: "<div .c:n:=1/>",
    mx: {
      code: "MX_SUGAR_BOUND",
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
    today: {
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
  },
  {
    id: "bound-compound-two-shorthands",
    source: "<div .a.b:=x/>",
    mx: {
      code: "MX_SUGAR_BOUND",
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
    today: {
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
  },
  {
    id: "bindable-computed-member",
    source: "<div :n:=obj[key]/>",
    mx: {
      code: "MX_SUGAR_BOUND",
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
    today: {
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
  },
  {
    id: "bindable-computed-index",
    source: "<div :n:=obj[0]/>",
    mx: {
      code: "MX_SUGAR_BOUND",
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
    today: {
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
  },
  {
    id: "bindable-non-ascii",
    source: "<div :n:=é/>",
    mx: {
      code: "MX_SUGAR_BOUND",
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
    today: {
      start: 5,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
  },
  {
    id: "bindable-parenthesized",
    source: "<a :n:=(obj.x)/>",
    mx: {
      code: "MX_SUGAR_BOUND",
      start: 3,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
    today: {
      start: 3,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
  },
  {
    id: "not-bindable-true",
    source: "<a :n:=true/>",
    mx: null,
    today: {
      start: 7,
      message:
        "Attributes may only be bound to identifiers or member expressions",
    },
  },
  {
    id: "not-bindable-this",
    source: "<a :n:=this/>",
    mx: null,
    today: {
      start: 7,
      message:
        "Attributes may only be bound to identifiers or member expressions",
    },
  },
  {
    id: "unnamed-colon-word",
    source: "<:1/>",
    mx: {
      code: "MX_SUGAR_NAME_INVALID",
      start: 1,
      message:
        "`:1` in a tag name is not a name; `:name` takes an identifier (`:email`, `:first-name`)",
    },
    today: {
      start: 1,
      message:
        "`:1` in a tag name is not a name; `:name` takes an identifier (`:email`, `:first-name`)",
    },
  },
  {
    id: "unnamed-colon-empty",
    source: "<:/>",
    mx: {
      code: "MX_SUGAR_NAME_MISSING",
      start: 1,
      message: "`:` in a tag name needs a name after it (`:email`)",
    },
    today: {
      start: 1,
      message: "`:` in a tag name needs a name after it (`:email`)",
    },
  },
  {
    id: "unnamed-colon-second",
    source: "<:b:c/>",
    mx: {
      code: "MX_SECOND_NAME",
      start: 3,
      message:
        'a tag takes one `:name`; this one already has a name (write the second as `name="…"`)',
    },
    today: {
      start: 3,
      message:
        'a tag takes one `:name`; this one already has a name (write the second as `name="…"`)',
    },
  },
  {
    id: "shorthand-trailing-colon",
    source: "<div.c:/>",
    mx: {
      code: "MX_SUGAR_NAME_MISSING",
      start: 6,
      message:
        "`:` in a shorthand class or id needs a name after it (`:email`)",
    },
    today: {
      start: 6,
      message:
        "`:` in a shorthand class or id needs a name after it (`:email`)",
    },
  },
  {
    id: "shorthand-trailing-colon-dynamic",
    source: "<div.${x}:/>",
    mx: {
      code: "MX_SUGAR_NAME_MISSING",
      start: 9,
      message:
        "`:` in a shorthand class or id needs a name after it (`:email`)",
    },
    today: {
      start: 9,
      message:
        "`:` in a shorthand class or id needs a name after it (`:email`)",
    },
  },
  {
    id: "statement-empty-colon",
    source: "<import:/>",
    mx: {
      code: "MX_SUGAR_ON_STATEMENT",
      start: 7,
      message:
        "a `:name` is not supported on the statement tag `import`: its text is code, not attributes — write `import …` at the root of the template instead",
    },
    today: {
      start: 7,
      message:
        "a `:name` is not supported on the statement tag `import`: its text is code, not attributes — write `import …` at the root of the template instead",
    },
  },
  {
    id: "dynamic-shorthand-fallback-div",
    source: "<${t} .a${x}/>",
    mx: {
      code: "MX_SUGAR_DYNAMIC",
      start: 6,
      message:
        "a dynamic shorthand works only tag-adjacent (`<div.a${x}>`), not as `.a${x}` after the tag name",
    },
    today: {
      start: 6,
      message:
        "a dynamic shorthand works only tag-adjacent (`<div.a${x}>`), not as `.a${x}` after the tag name",
    },
  },
  {
    id: "authored-range-with-value",
    source: "<div .c:bad%=1/>",
    mx: {
      code: "MX_SUGAR_NAME_INVALID",
      start: 7,
      message:
        "`:bad%` in `.c:bad%=1` is not a name; `:name` takes an identifier (`:email`, `:first-name`)",
    },
    today: {
      start: 7,
      message:
        "`:bad%` in `.c:bad%=1` is not a name; `:name` takes an identifier (`:email`, `:first-name`)",
    },
  },
  {
    id: "nested-silent-eof-attribute-tag",
    source: "div\n  @slot(a",
    mx: null,
    today: {
      start: 0,
      message:
        "attribute tag `@slot` on `<div>`; attribute tags are props of components, so they are only valid directly inside a component call",
    },
  },
  // Concise-mode and fragment-base neighbours: the same rules at different
  // offsets and with leading content.
  {
    id: "concise-bound-compound",
    source: "div .c:n:=x",
    mx: {
      code: "MX_SUGAR_BOUND",
      start: 4,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
    today: {
      start: 4,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
  },
  {
    id: "fragment-base-bound-compound",
    source: "<p/>x<div .c:n:=x/>",
    mx: {
      code: "MX_SUGAR_BOUND",
      start: 10,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
    today: {
      start: 10,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
  },
  {
    id: "newline-fragment-bound-compound",
    source: "x\n<div .c:n:=x/>",
    mx: {
      code: "MX_SUGAR_BOUND",
      start: 7,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
    today: {
      start: 7,
      message:
        "a bound value is not supported on name sugar; write name=... value:=...",
    },
  },
];

describe("the curated reverse calibration matrix (review F8)", () => {
  it("every row fires exactly the stated front-end error, or none", () => {
    const wrong: string[] = [];
    for (const row of REVERSE_MATRIX) {
      const document = parseMx(row.source, {
        statementKeywords: SIX,
        tagShape: markoTagShape,
      });
      const frontEnd = document.errors.find((e) => e.origin === "front-end");
      const got = frontEnd
        ? {
            code: frontEnd.code,
            start: frontEnd.start,
            message: frontEnd.message,
          }
        : null;
      if (JSON.stringify(got) !== JSON.stringify(row.mx)) {
        wrong.push(
          `${row.id}: got ${JSON.stringify(got)} want ${JSON.stringify(row.mx)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every row's today outcome is the stated one (absent rules drift here)", () => {
    const wrong: string[] = [];
    for (const row of REVERSE_MATRIX) {
      const today = lowerToday(row.source);
      const got = today.ok
        ? null
        : { start: today.start, message: today.message };
      if (JSON.stringify(got) !== JSON.stringify(row.today)) {
        wrong.push(
          `${row.id}: got ${JSON.stringify(got)} want ${JSON.stringify(row.today)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
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
          TODAY_CRASHES.has(probe.id) ||
          BABEL_MESSAGE_PERIOD.has(probe.id)
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

  it("the Babel-message-period inputs differ only in that trailing period", () => {
    for (const id of BABEL_MESSAGE_PERIOD) {
      const source = id.startsWith("g")
        ? (PROBES.find((probe) => probe.id === id)?.input as string)
        : fixtureInputs().find((input) => input.path === id)?.source;
      expect(source, id).toBeDefined();
      const outcome = compare(source as string);
      expect(
        outcome.expressions.differences.filter(
          (line: string) => !/ != today ".*(?<!\.)"@/.test(line),
        ),
        id,
      ).toEqual([]);
      expect(outcome.expressions.differences.length, id).toBeGreaterThan(0);
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
