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
 * End of input inside a concise open delimiter (parser-grammar OQ 19):
 * today's parser is silent and its tags there carry no position. The front
 * end reports `MX_INPUT_ENDS_IN_DELIMITER` at the opener and closes the tags
 * at the end (no silent drop). TODO `concise-eof-interpolation-drops-event` (the template parser
 * still reports no event for g0380 g0381 g0382) stays open.
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
 * 7.29.7 does not — the only payload difference found across every input
 * (2,251 containers compared). Ruling 2026-10-08 (the lead): the fork's
 * wording stands; the comparison accepts a trailing period, and the row
 * stays to keep the difference disclosed.
 */
const BABEL_MESSAGE_PERIOD = new Set([
  "g0259",
  "packages/hosts/hono/src/fixtures/region/for-by/input.hono.mx",
]);

/**
 * Expression errors whose text or position differs from today's, each one
 * equally present on a twin with no `:` in it, so not from atoms (these
 * inputs parsed while the template parser lexed `:b` as an atom). One
 * difference each, pinned below:
 *
 * - `g0570` (`{ k: :a }`): MX's Babel 7.29.8 fork says "Unexpected token."
 *   inside an object literal, today's 7.29.7 "Unexpected token" (twin:
 *   `<div x={ k: + }/>`). Outside the comma ruling above.
 * - `g0980`, `g0981` (`[a,` U+2028 or U+2029 `:b]`): Babel counts the
 *   separator as a line break and Marko's line table does not, so Marko
 *   bounds the error to the expression's start; MX reports the token (twin:
 *   `[a,` U+2028 `+]`).
 */
const EXPRESSION_ERROR_DIFFERS = new Map([
  [
    "g0570",
    'expression [7,16): MX error "Unexpected token."@[12,12) != today "Unexpected token"@[12,12)',
  ],
  [
    "g0980",
    'expression [7,14): MX error "Unexpected token"@[11,11) != today "Unexpected token"@[7,7)',
  ],
  [
    "g0981",
    'expression [7,14): MX error "Unexpected token"@[11,11) != today "Unexpected token"@[7,7)',
  ],
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
 * Where today's front end throws ITS OWN error before the front end's rule
 * (ast \u00a73.13 keeps today's text for the rules themselves). One input;
 * the test below pins its exact today-first reason, so a rule change that
 * moves an entry into or out of this list fails there:
 * - `<div x=$!{a}/>`: today's Marko-front compile throws the Babel error as
 *   an aggregate frame ("at s.mx:1:10"), not MX's dedicated code with the
 *   same sentence at the same point.
 */
const TODAY_OWN_FIRST = new Set(["g0755"]);

/** Each TODAY_OWN_FIRST entry's own expected first error from today (offset + message). */
const TODAY_OWN_REASON: Record<string, { start: number; message: string }> = {
  g0755: {
    start: 9,
    message: "at s.mx:1:10",
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
      // New in MX: today's parser was silent here.
      if (frontEnd.code === "MX_INPUT_ENDS_IN_DELIMITER") continue;
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

  it("`MX_INPUT_ENDS_IN_DELIMITER` fires exactly on the silent end-of-input probes, where today's parser reported nothing", () => {
    for (const { input, frontEnd, parsedToday } of rows) {
      const ended = frontEnd?.code === "MX_INPUT_ENDS_IN_DELIMITER";
      // g0381 (`${x`): no event and no tag at all, so its tree compares
      // equal and it is not in `SILENT_EOF`.
      expect(ended, input.id).toBe(
        SILENT_EOF.has(input.id) || input.id === "g0381",
      );
      if (ended) expect(parsedToday, input.id).toBe(true);
    }
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
 * The curated reverse calibration matrix (review F8), pinned in the reverse
 * direction: each row states the front end's first error and today's first
 * error exactly, so a rule that stops firing (or drifts) fails here even when
 * the corpus never contained the shape. The colon and spaced-shorthand rows
 * pin Marko's own reading: the front end records nothing, and today's error
 * (or acceptance) is what stock Marko reads (`<div .c:n:=x/>` is an attribute
 * named `.c:n`, `<:1/>` a tag named `:1`, `<div.c:/>` the class `c:`).
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
    mx: null,
    today: {
      start: 5,
      message:
        "Invalid attribute name `.c` — a `#id` or `.class` shorthand goes on the tag name with no space (`<div#a>`, `<div.cls>`); otherwise write `id=` or `class=`",
    },
  },
  {
    id: "bound-compound-dot-value-ignored",
    source: "<div .c:n:=1/>",
    mx: null,
    today: {
      start: 11,
      message:
        "Attributes may only be bound to identifiers or member expressions",
    },
  },
  {
    id: "bound-compound-two-shorthands",
    source: "<div .a.b:=x/>",
    mx: null,
    today: {
      start: 5,
      message:
        "Invalid attribute name `.a.b` — a `#id` or `.class` shorthand goes on the tag name with no space (`<div#a>`, `<div.cls>`); otherwise write `id=` or `class=`",
    },
  },
  {
    id: "bindable-computed-member",
    source: "<div :n:=obj[key]/>",
    mx: null,
    today: null,
  },
  {
    id: "bindable-computed-index",
    source: "<div :n:=obj[0]/>",
    mx: null,
    today: null,
  },
  {
    id: "bindable-non-ascii",
    source: "<div :n:=é/>",
    mx: null,
    today: null,
  },
  {
    id: "bindable-parenthesized",
    source: "<a :n:=(obj.x)/>",
    mx: null,
    today: null,
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
    mx: null,
    today: null,
  },
  {
    id: "unnamed-colon-empty",
    source: "<:/>",
    mx: null,
    today: null,
  },
  {
    id: "unnamed-colon-second",
    source: "<:b:c/>",
    mx: null,
    today: null,
  },
  {
    id: "shorthand-trailing-colon",
    source: "<div.c:/>",
    mx: null,
    today: null,
  },
  {
    id: "shorthand-trailing-colon-dynamic",
    source: "<div.${x}:/>",
    mx: null,
    today: null,
  },
  {
    id: "statement-empty-colon",
    source: "<import:/>",
    mx: null,
    today: null,
  },
  {
    id: "dynamic-shorthand-fallback-div",
    source: "<${t} .a${x}/>",
    mx: null,
    today: {
      start: 6,
      message:
        "Invalid attribute name `.a${x}` — a `#id` or `.class` shorthand goes on the tag name with no space (`<div#a>`, `<div.cls>`); otherwise write `id=` or `class=`",
    },
  },
  {
    id: "authored-range-with-value",
    source: "<div .c:bad%=1/>",
    mx: null,
    today: {
      start: 5,
      message:
        "Invalid attribute name `.c` — a `#id` or `.class` shorthand goes on the tag name with no space (`<div#a>`, `<div.cls>`); otherwise write `id=` or `class=`",
    },
  },
  {
    id: "nested-silent-eof-attribute-tag",
    source: "div\n  @slot(a",
    // Not the root rule (the tag has its real ancestor); the input ending
    // inside `(`.
    mx: {
      code: "MX_INPUT_ENDS_IN_DELIMITER",
      start: 11,
      message: "the input ends inside `(`…`)` opened here",
    },
    today: {
      start: 0,
      message:
        "attribute tag `@slot` on `<div>`; attribute tags are props of components, so they are only valid directly inside a component call",
    },
  },
  {
    id: "concise-bound-compound",
    source: "div .c:n:=x",
    mx: null,
    today: {
      start: 4,
      message:
        "Invalid attribute name `.c` — a `#id` or `.class` shorthand goes on the tag name with no space (`<div#a>`, `<div.cls>`); otherwise write `id=` or `class=`",
    },
  },
  {
    id: "fragment-base-bound-compound",
    source: "<p/>x<div .c:n:=x/>",
    mx: null,
    today: {
      start: 10,
      message:
        "Invalid attribute name `.c` — a `#id` or `.class` shorthand goes on the tag name with no space (`<div#a>`, `<div.cls>`); otherwise write `id=` or `class=`",
    },
  },
  {
    id: "newline-fragment-bound-compound",
    source: "x\n<div .c:n:=x/>",
    mx: null,
    today: {
      start: 7,
      message:
        "Invalid attribute name `.c` — a `#id` or `.class` shorthand goes on the tag name with no space (`<div#a>`, `<div.cls>`); otherwise write `id=` or `class=`",
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
          BABEL_MESSAGE_PERIOD.has(probe.id) ||
          EXPRESSION_ERROR_DIFFERS.has(probe.id)
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

  it("each expression-error difference is that one difference and nothing else", () => {
    for (const [id, difference] of EXPRESSION_ERROR_DIFFERS) {
      const outcome = results.find(({ probe }) => probe.id === id)?.outcome;
      expect(outcome, id).toBeDefined();
      expect(outcome?.expressions.differences, id).toEqual([difference]);
      expect(outcome?.mx, id).toEqual(outcome?.marko);
      expect(outcome?.text, id).toEqual([]);
    }
  });

  it("the Babel-message-period inputs compare equal under the ruling (the fork's wording stands)", () => {
    for (const id of BABEL_MESSAGE_PERIOD) {
      const source = id.startsWith("g")
        ? (PROBES.find((probe) => probe.id === id)?.input as string)
        : fixtureInputs().find((input) => input.path === id)?.source;
      expect(source, id).toBeDefined();
      const outcome = compare(source as string);
      expect(outcome.expressions.differences, id).toEqual([]);
      expect(outcome.equal, id).toBe(true);
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
    // Interim: PR 2b records MX_TAG_NAME_MISSING here, never an element nobody wrote.
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
