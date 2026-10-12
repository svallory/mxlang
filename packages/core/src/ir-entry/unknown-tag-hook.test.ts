/**
 * `Dialect.explainUnknownTag`, through `lowerSource`, on a test-local dialect
 * (it names no real one): a tag with no contract is explained by the dialect
 * with its own message, code and position, as the tag's one error.
 *
 * Every row runs on both paths core finds an unknown tag on: the check of a
 * source that lowered ("success path"), and the parse-only scan of a source
 * whose lowering failed ("failure path"; an unrelated contract error elsewhere
 * in the file, `<needs/>`, forces it).
 */
import { describe, expect, it, vi } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import type {
  Dialect,
  UnknownTag,
  UnknownTagExplanation,
} from "../syntax-table.ts";
import { type LowerSourceOptions, lowerSource } from "./index.ts";

const CODE = "FIXTURE_UNSPACED";

/** The dialect's wording for a name written against its tag (`entity:Todo`). */
function againstTag(name: string, kind: string): string {
  return `\`${name}\` writes the name against the tag; write a name after a space: \`${kind} ${name.slice(name.indexOf(":"))}\``;
}

function noTag(name: string): string {
  return `\`${name}\` is a name with no tag before it; write a tag, a space, then the name: \`kind ${name}\``;
}

/** Explains a name with a colon in it, as the parent's `defaultTag` or the part before the colon. */
function explainColon(tag: UnknownTag): UnknownTagExplanation | undefined {
  const colon = tag.name.indexOf(":");
  if (colon < 0) return undefined;
  const parent = tag.ancestors.at(-1);
  const kind = tag.name.slice(0, colon) || parent?.contract?.defaultTag;
  return {
    code: CODE,
    at: tag.nameSpan,
    message: kind ? againstTag(tag.name, kind) : noTag(tag.name),
  };
}

function dialectOf(
  /** `null`: a dialect with no hook at all. */
  explain: Dialect["explainUnknownTag"] | null = explainColon,
  more: Partial<Dialect> = {},
): Dialect {
  return {
    id: "fixture",
    name: "Fixture",
    table: {},
    ...(explain ? { explainUnknownTag: explain } : {}),
    ...more,
  };
}

const contracts: Record<string, CustomTag> = {
  entity: { children: { attributes: {} } },
  // Closed: only `string` may be written in it.
  attributes: { parents: ["entity"], children: { string: {} } },
  string: {},
  // Open: it declares no `children`.
  fields: { defaultTag: "string" },
  set: { defaultTag: "setter" },
  setter: {},
  input: {},
  // A contract error of its own, for a file that must fail somewhere else.
  needs: { attributes: { name: { type: "string", required: true } } },
};

const NEEDS = "<needs/>\n";
const NEEDS_MESSAGE = "`<needs>`: missing required attribute `name`";

type Mode = "allow" | "reject";

function run(
  source: string,
  mode: Mode,
  options: Partial<LowerSourceOptions> = {},
) {
  return lowerSource(source, "/f.mx", {
    customTags: contracts,
    dialect: dialectOf(),
    tagRules: "none",
    unknownTags: mode,
    ...options,
  });
}

/** One expected diagnostic, as `IrDiagnostic` reports it. */
interface Expected {
  message: string;
  code?: string;
  line: number;
  column: number;
  offset: number;
  end?: { line: number; column: number; offset: number };
}

function error(expected: Expected) {
  return { severity: "error", ...expected };
}

function needsAt(source: string): Expected {
  const offset = source.length;
  const lines = source.split("\n");
  return {
    message: NEEDS_MESSAGE,
    line: lines.length,
    column: 0,
    offset,
    code: "MX_MISSING_ATTRIBUTE",
    // A whole-tag error ends at the end of `<needs`.
    end: { line: lines.length, column: 6, offset: offset + 6 },
  };
}

interface Row {
  name: string;
  source: string;
  /** Contracts for this row, over the shared ones. */
  tags?: Record<string, CustomTag>;
  /** What the dialect says, in both modes. */
  explained: Expected;
}

/** Rows whose source lowers on its own: the success path. */
const successRows: Row[] = [
  {
    name: "a root-level concise `entity:Todo`",
    source: "entity:Todo\n",
    explained: {
      message: againstTag("entity:Todo", "entity"),
      code: CODE,
      line: 1,
      column: 0,
      offset: 0,
      end: { line: 1, column: 11, offset: 11 },
    },
  },
  {
    name: "a root-level `<entity:Todo/>`, positioned at the name, not the `<`",
    source: "<entity:Todo/>\n",
    explained: {
      message: againstTag("entity:Todo", "entity"),
      code: CODE,
      line: 1,
      column: 1,
      offset: 1,
      end: { line: 1, column: 12, offset: 12 },
    },
  },
  {
    name: "`uuid:id` in an open `fields`",
    source: "fields\n  uuid:id\n",
    explained: {
      message: againstTag("uuid:id", "uuid"),
      code: CODE,
      line: 2,
      column: 2,
      offset: 9,
      end: { line: 2, column: 9, offset: 16 },
    },
  },
  {
    name: "`<string:title/>` in an open `<fields>`",
    source: "<fields>\n  <string:title/>\n</fields>\n",
    explained: {
      message: againstTag("string:title", "string"),
      code: CODE,
      line: 2,
      column: 3,
      offset: 12,
      end: { line: 2, column: 15, offset: 24 },
    },
  },
  {
    name: "`<:x/>` under `<set>`, whose contract has `defaultTag: setter`",
    source: "<set>\n  <:x/>\n</set>\n",
    tags: { set: { defaultTag: "setter" } },
    explained: {
      message: againstTag(":x", "setter"),
      code: CODE,
      line: 2,
      column: 3,
      offset: 9,
      end: { line: 2, column: 5, offset: 11 },
    },
  },
  {
    name: "`:id` under `input`, which has no `defaultTag`",
    source: "input\n  :id\n",
    explained: {
      message: noTag(":id"),
      code: CODE,
      line: 2,
      column: 2,
      offset: 8,
      end: { line: 2, column: 5, offset: 11 },
    },
  },
];

/** Rows whose own tag is not allowed in a closed parent: the failure path. */
const closedRows: Row[] = [
  {
    name: "`uuid:id` under a closed `attributes`",
    source: "entity\n  attributes\n    uuid:id\n",
    explained: {
      message: againstTag("uuid:id", "uuid"),
      code: CODE,
      line: 3,
      column: 4,
      offset: 24,
      end: { line: 3, column: 11, offset: 31 },
    },
  },
  {
    name: "`<string:title/>` under a closed `<attributes>`",
    source: "<entity>\n  <attributes><string:title/></attributes>\n</entity>\n",
    explained: {
      message: againstTag("string:title", "string"),
      code: CODE,
      line: 2,
      column: 15,
      offset: 24,
      end: { line: 2, column: 27, offset: 36 },
    },
  },
  {
    name: "`:x` under a closed `set`, with a `defaultTag`",
    source: "set\n  :x\n",
    tags: { set: { defaultTag: "setter", children: { setter: {} } } },
    explained: {
      message: againstTag(":x", "setter"),
      code: CODE,
      line: 2,
      column: 2,
      offset: 6,
      end: { line: 2, column: 4, offset: 8 },
    },
  },
];

describe("explainUnknownTag: the Mesh-style table, in both modes", () => {
  for (const mode of ["reject", "allow"] as const) {
    describe(`unknownTags: "${mode}"`, () => {
      for (const row of successRows) {
        it(`success path: ${row.name} is the dialect's one diagnostic, with no IR`, () => {
          const tags = { ...contracts, ...row.tags };
          // Without the hook the source lowers: the check is what finds the tag.
          const bare = run(row.source, "allow", {
            customTags: tags,
            dialect: dialectOf(null),
          });
          expect(bare.diagnostics).toEqual([]);
          expect(bare.ir).toBeDefined();
          const { ir, diagnostics } = run(row.source, mode, {
            customTags: tags,
          });
          expect(ir).toBeUndefined();
          expect(diagnostics).toEqual([error(row.explained)]);
        });

        it(`failure path: ${row.name} beside an unrelated contract error gives both`, () => {
          const tags = { ...contracts, ...row.tags };
          const source = row.source + NEEDS;
          const { ir, diagnostics } = run(source, mode, { customTags: tags });
          expect(ir).toBeUndefined();
          expect(diagnostics).toEqual([
            error(row.explained),
            error(needsAt(row.source)),
          ]);
        });
      }

      for (const row of closedRows) {
        it(`${row.name} is one diagnostic: the dialect's, not "not allowed" and not "unknown"`, () => {
          const tags = { ...contracts, ...row.tags };
          const { ir, diagnostics } = run(row.source, mode, {
            customTags: tags,
          });
          expect(ir).toBeUndefined();
          expect(diagnostics).toEqual([error(row.explained)]);
        });

        it(`${row.name}, beside an unrelated contract error, is still one diagnostic for the tag`, () => {
          const tags = { ...contracts, ...row.tags };
          const { diagnostics } = run(row.source + NEEDS, mode, {
            customTags: tags,
          });
          expect(diagnostics).toEqual([
            error(row.explained),
            error(needsAt(row.source)),
          ]);
        });
      }
    });
  }

  describe("a name the dialect leaves alone (`foo`, no colon)", () => {
    const source = "entity\n  attributes\n    foo\n";
    const notAllowed = {
      severity: "error",
      message:
        "`<attributes>`: `<foo>` is not allowed here; allowed children: `<string>`",
      code: "MX_TAG_NOT_ALLOWED",
      line: 3,
      column: 4,
      offset: 24,
      end: { line: 3, column: 7, offset: 27 },
    };

    it("is core's `MX_UNKNOWN_TAG` alone in reject mode", () => {
      const { diagnostics } = run(source, "reject");
      expect(diagnostics).toEqual([
        {
          severity: "error",
          message: "`<foo>` is not a known tag in the `fixture` dialect",
          code: "MX_UNKNOWN_TAG",
          line: 3,
          column: 4,
          offset: 24,
          end: { line: 3, column: 7, offset: 27 },
        },
      ]);
    });

    it("is core's own rule in allow mode", () => {
      const { diagnostics } = run(source, "allow");
      expect(diagnostics).toEqual([notAllowed]);
    });

    it("is core's own, byte for byte, with no hook at all", () => {
      for (const mode of ["reject", "allow"] as const) {
        const withHook = run(source, mode);
        const without = run(source, mode, { dialect: dialectOf(null) });
        expect(withHook.diagnostics).toEqual(without.diagnostics);
      }
    });

    it("in an open parent is nothing in allow mode, and a lowered IR", () => {
      const { ir, diagnostics } = run("fields\n  foo\n", "allow");
      expect(diagnostics).toEqual([]);
      expect(ir).toBeDefined();
    });
  });
});

describe("explainUnknownTag: one tag, one diagnostic", () => {
  const source =
    "<entity>\n  <attributes><string:title/></attributes>\n</entity>\n";

  it("an explained tag in a closed parent, in reject mode, is exactly the dialect's error", () => {
    const { diagnostics } = run(source, "reject");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual({
      severity: "error",
      message: againstTag("string:title", "string"),
      code: CODE,
      line: 2,
      column: 15,
      offset: 24,
      end: { line: 2, column: 27, offset: 36 },
    });
  });

  it("an explained tag in a closed parent, in allow mode, is exactly the dialect's error", () => {
    const { diagnostics } = run(source, "allow");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(CODE);
  });

  it("never also reports `MX_UNKNOWN_TAG` for the explained occurrence", () => {
    for (const mode of ["reject", "allow"] as const) {
      for (const tail of ["", NEEDS]) {
        const codes = run(source + tail, mode).diagnostics.map((d) => d.code);
        expect(codes).not.toContain("MX_UNKNOWN_TAG");
        expect(codes).not.toContain("MX_TAG_NOT_ALLOWED");
      }
    }
  });

  it("an explained tag and an unexplained one in the same parent each get their own one", () => {
    const both =
      "<entity>\n  <attributes>\n    <string:title/>\n    <bar/>\n  </attributes>\n</entity>\n";
    const reject = run(both, "reject").diagnostics;
    expect(reject.map((d) => [d.code, d.line, d.column])).toEqual([
      [CODE, 3, 5],
      ["MX_UNKNOWN_TAG", 4, 4],
    ]);
    // Allow mode has no unknown-tag error of core's: the lowering stops at its
    // first error, which the dialect's explanation replaces, and `<bar/>` (a
    // later not-allowed error the lowering never reached) is not listed.
    const allow = run(both, "allow").diagnostics;
    expect(allow.map((d) => [d.code, d.line, d.column])).toEqual([
      [CODE, 3, 5],
    ]);
  });

  describe("with the unrelated error before the tag (the not-allowed error is not the first one raised)", () => {
    const before = NEEDS + source;
    const needsFirst = error({
      message: NEEDS_MESSAGE,
      line: 1,
      column: 0,
      offset: 0,
      end: { line: 1, column: 6, offset: 6 },
      code: "MX_MISSING_ATTRIBUTE",
    });

    for (const mode of ["reject", "allow"] as const) {
      it(`${mode}: the explained tag is the dialect's one diagnostic beside it`, () => {
        const { diagnostics, ir } = run(before, mode);
        expect(ir).toBeUndefined();
        expect(diagnostics).toEqual([
          needsFirst,
          error({
            message: againstTag("string:title", "string"),
            code: CODE,
            line: 3,
            column: 15,
            offset: 33,
            end: { line: 3, column: 27, offset: 45 },
          }),
        ]);
      });
    }

    it("reject, no hook: the unknown tag is `MX_UNKNOWN_TAG` alone, with no not-allowed beside it", () => {
      const { diagnostics } = run(before, "reject", {
        dialect: dialectOf(null),
      });
      expect(diagnostics).toEqual([
        needsFirst,
        error({
          message:
            "`<string:title>` is not a known tag in the `fixture` dialect",
          code: "MX_UNKNOWN_TAG",
          line: 3,
          column: 14,
          offset: 32,
          end: { line: 3, column: 27, offset: 45 },
        }),
      ]);
    });

    it("allow, no hook: a not-allowed error is still core's, once", () => {
      const { diagnostics } = run(before, "allow", {
        dialect: dialectOf(null),
      });
      expect(diagnostics).toEqual([
        needsFirst,
        error({
          message:
            "`<attributes>`: `<string:title>` is not allowed here; allowed children: `<string>`",
          code: "MX_TAG_NOT_ALLOWED",
          line: 3,
          column: 14,
          offset: 32,
          end: { line: 3, column: 27, offset: 45 },
        }),
      ]);
    });
  });

  it("the dropped error's wildcard guidance stays on core's error, not on the dialect's", () => {
    const tags: Record<string, CustomTag> = {
      wild: { children: { "*": { pattern: "^T[a-z]+$" } } },
    };
    const { diagnostics } = run(
      "<wild>\n  <Ux/>\n  <y:z/>\n</wild>\n",
      "reject",
      {
        customTags: tags,
      },
    );
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      code: "MX_UNKNOWN_TAG",
      message: expect.stringContaining("`<Ux>` is not a known tag"),
    });
    expect(diagnostics[1]).toEqual(
      error({
        message: againstTag("y:z", "y"),
        code: CODE,
        line: 3,
        column: 3,
        offset: 18,
        end: { line: 3, column: 6, offset: 21 },
      }),
    );
  });
});

/** The hook, spied: it explains every colon name and records what it was given. */
function spied(explain: Dialect["explainUnknownTag"] = explainColon) {
  const calls: UnknownTag[] = [];
  const afterLower = vi.fn();
  const dialect = dialectOf(
    (tag) => {
      calls.push(tag);
      return explain?.(tag);
    },
    { afterLower },
  );
  return { calls, afterLower, dialect };
}

describe("explainUnknownTag: the view the hook gets", () => {
  it("a root tag has no ancestors, the mode, the file and the source", () => {
    const { calls, dialect } = spied();
    const source = "entity:Todo\n";
    run(source, "reject", { dialect });
    expect(calls).toHaveLength(1);
    const [tag] = calls;
    expect(tag).toEqual({
      name: "entity:Todo",
      nameSpan: { sourceStart: 0, sourceEnd: 11 },
      // A concise tag's element runs to the end of its line.
      span: { sourceStart: 0, sourceEnd: 12 },
      ancestors: [],
      mode: "reject",
      file: "/f.mx",
      source,
    });
  });

  it("the mode is the call's, in allow mode too", () => {
    const { calls, dialect } = spied();
    run("entity:Todo\n", "allow", { dialect });
    expect(calls[0]?.mode).toBe("allow");
  });

  it("ancestors are the authored tags around it, outermost first, with the contract data", () => {
    const { calls, dialect } = spied();
    const source =
      "<entity>\n  <fields>\n    <string:title/>\n  </fields>\n</entity>\n";
    run(source, "reject", {
      dialect,
      customTags: {
        ...contracts,
        entity: { children: { attributes: {}, fields: {} } },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ancestors).toEqual([
      {
        tag: "entity",
        nameSpan: { sourceStart: 1, sourceEnd: 7 },
        contract: { children: { attributes: {}, fields: {} } },
      },
      {
        tag: "fields",
        nameSpan: { sourceStart: 12, sourceEnd: 18 },
        contract: { defaultTag: "string" },
      },
    ]);
  });

  it("an ancestor with no contract has no `contract` key", () => {
    const { calls, dialect } = spied();
    run("<mystery>\n  <string:title/>\n</mystery>\n", "allow", { dialect });
    const call = calls.find((c) => c.name === "string:title");
    expect(call?.ancestors).toEqual([
      { tag: "mystery", nameSpan: { sourceStart: 1, sourceEnd: 8 } },
    ]);
    expect("contract" in (call?.ancestors[0] ?? {})).toBe(false);
  });

  it("a tag a `transform` emitted is not an ancestor: what the author wrote around the unknown tag is", () => {
    const { calls, dialect } = spied();
    run("<wrap>\n  <string:title/>\n</wrap>\n", "reject", {
      dialect,
      customTags: {
        wrap: {
          transform: (call, ctx) => [
            ctx.build.delegatedTag(
              "emitted:x",
              call.content?.children ?? [],
              call.attributeTags,
            ),
          ],
        },
      },
    });
    const call = calls.find((c) => c.name === "string:title");
    expect(call?.ancestors.map((a) => a.tag)).not.toContain("emitted:x");
  });

  it('a tag inside a dynamic tag: asked on the failure path with an ancestor named "", not on the success path', () => {
    // A dynamic tag is always an error under `lowerSource` (it has no name), so
    // this is a file that already has one. The scan still reads its children.
    const failing = spied();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a dynamic tag's source text
    const source = "<${name}>\n  <g:h/>\n</>\n";
    const { diagnostics } = run(source + NEEDS, "reject", {
      dialect: failing.dialect,
    });
    expect(failing.calls).toHaveLength(1);
    expect(failing.calls[0]?.name).toBe("g:h");
    expect(failing.calls[0]?.ancestors).toEqual([
      // The name span is the `${...}` expression.
      { tag: "", nameSpan: { sourceStart: 1, sourceEnd: 8 } },
    ]);
    expect(diagnostics.some((d) => d.code === CODE)).toBe(true);
    // The success path's walk does not enter a dynamic tag.
    const ok = spied();
    const lowered = run(source, "reject", { dialect: ok.dialect });
    expect(ok.calls).toEqual([]);
    expect(lowered.diagnostics.map((d) => d.message)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the message's own text
      "a dynamic tag (`<${expr}>`) has no name; the data tree is static and needs one",
    ]);
  });

  it("the data handed to the hook is frozen", () => {
    const { calls, dialect } = spied();
    run("<fields>\n  <string:title/>\n</fields>\n", "allow", { dialect });
    const [tag] = calls;
    expect(Object.isFrozen(tag)).toBe(true);
    expect(Object.isFrozen(tag?.ancestors)).toBe(true);
    expect(Object.isFrozen(tag?.ancestors[0])).toBe(true);
    expect(Object.isFrozen(tag?.ancestors[0]?.contract)).toBe(true);
  });
});

describe("explainUnknownTag: the same view on both paths", () => {
  /** What the hook gets for `source` alone, and for `source` plus an unrelated error. */
  function both(source: string, tags: Record<string, CustomTag>) {
    const success = spied();
    const resultOk = run(source, "reject", {
      dialect: success.dialect,
      customTags: tags,
    });
    const failure = spied();
    const resultFail = run(source + NEEDS, "reject", {
      dialect: failure.dialect,
      customTags: tags,
    });
    return { success, failure, resultOk, resultFail };
  }

  /** `UnknownTag` but for the source text, which differs by the appended error. */
  function withoutSource(tag: UnknownTag | undefined) {
    if (!tag) return undefined;
    const { source: _source, ...rest } = tag;
    return rest;
  }

  const cases: Array<[string, string, Record<string, CustomTag>]> = [
    [
      "a nested tag, with its ancestors' contracts and a `defaultTag`",
      "<entity>\n  <fields>\n    <string:title/>\n  </fields>\n</entity>\n",
      { ...contracts, entity: { children: { attributes: {}, fields: {} } } },
    ],
    [
      "an unnamed-shorthand tag, under a parent with a `defaultTag`",
      "<set>\n  <:x/>\n</set>\n",
      { ...contracts, set: { defaultTag: "setter" } },
    ],
    [
      "a tag under `<if>` (not an ancestor) in an attribute tag with a `defaultTag`",
      "<holder>\n  <@row>\n    <if=cond>\n      <:x/>\n    </if>\n  </@row>\n</holder>\n",
      {
        ...contracts,
        holder: { attributeTags: { row: { defaultTag: "cell" } } },
        cell: {},
      },
    ],
    [
      "a tag under a wildcard-claimed child, whose inline contract has a `defaultTag`",
      "<wild>\n  <abc>\n    <:x/>\n  </abc>\n</wild>\n",
      {
        ...contracts,
        wild: {
          children: { "*": { pattern: "^[a-z]+$", defaultTag: "cell" } },
        },
        cell: {},
      },
    ],
  ];

  for (const [name, source, tags] of cases) {
    it(`${name}: the hook gets equal views`, () => {
      const { success, failure, resultOk, resultFail } = both(source, tags);
      expect(success.calls).toHaveLength(1);
      expect(failure.calls).toHaveLength(1);
      expect(withoutSource(failure.calls[0])).toEqual(
        withoutSource(success.calls[0]),
      );
      expect(failure.calls[0]?.source).toBe(source + NEEDS);
      expect(success.calls[0]?.source).toBe(source);
      // And so are the diagnostics for the tag itself.
      expect(resultFail.diagnostics[0]).toEqual(resultOk.diagnostics[0]);
      expect(resultOk.diagnostics).toHaveLength(1);
      expect(resultFail.diagnostics).toHaveLength(2);
    });
  }

  it("the view carries the ancestors' `defaultTag` on both paths (not an empty object)", () => {
    const { success, failure } = both("<set>\n  <:x/>\n</set>\n", {
      ...contracts,
      set: { defaultTag: "setter" },
    });
    expect(success.calls[0]?.ancestors[0]?.contract?.defaultTag).toBe("setter");
    expect(failure.calls[0]?.ancestors[0]?.contract?.defaultTag).toBe("setter");
  });
});

describe("explainUnknownTag: how often it runs", () => {
  it("runs once per unknown occurrence on the success path, and `afterLower` once", () => {
    const { calls, afterLower, dialect } = spied();
    run("fields\n  a:b\n  c:d\n", "reject", { dialect });
    expect(calls.map((c) => c.name)).toEqual(["a:b", "c:d"]);
    expect(afterLower).toHaveBeenCalledTimes(1);
  });

  it("runs once per unknown occurrence on the failure path, and the source lowers once", () => {
    const { calls, afterLower, dialect } = spied();
    run("<needs/>\n<fields>\n  <a:b/>\n  <c:d/>\n</fields>\n", "reject", {
      dialect,
    });
    expect(calls.map((c) => c.name)).toEqual(["a:b", "c:d"]);
    // `afterLower` runs only for a unit that lowered cleanly; the failed
    // lowering never reached it, and no second lowering was made to find the
    // tags (that would run it for a clean second pass).
    expect(afterLower).toHaveBeenCalledTimes(0);
  });

  it("a closed-parent occurrence is explained once, though two checks list it", () => {
    const { calls, dialect } = spied();
    run("entity\n  attributes\n    uuid:id\n", "reject", { dialect });
    expect(calls.map((c) => c.name)).toEqual(["uuid:id"]);
  });

  it("allow mode with a hook, on a source that lowers, runs `afterLower` once", () => {
    const { afterLower, dialect } = spied();
    const result = run("fields\n  foo\n", "allow", { dialect });
    expect(result.ir).toBeDefined();
    expect(afterLower).toHaveBeenCalledTimes(1);
  });

  it("with no hook, allow mode never walks for unknown tags (no ancestors built)", () => {
    const result = run("fields\n  a:b\n", "allow", {
      dialect: dialectOf(null),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.ir).toBeDefined();
  });
});

describe("explainUnknownTag: when it is not asked", () => {
  it("not for a declared tag", () => {
    const { calls, dialect } = spied();
    const { diagnostics } = run(
      "entity\n  attributes\n    string\n",
      "reject",
      {
        dialect,
      },
    );
    expect(diagnostics).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("not for a child a parent's wildcard claims", () => {
    const { calls, dialect } = spied();
    const { diagnostics } = run("<wild>\n  <abc/>\n</wild>\n", "reject", {
      dialect,
      customTags: {
        wild: { children: { "*": { pattern: "^[a-z]+$" } } },
      },
    });
    expect(diagnostics).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("not on the failure path for a wildcard-claimed child, either", () => {
    const { calls, dialect } = spied();
    const { diagnostics } = run(
      "<wild>\n  <abc/>\n</wild>\n<needs/>\n",
      "reject",
      {
        dialect,
        customTags: {
          ...contracts,
          wild: { children: { "*": { pattern: "^[a-z]+$" } } },
        },
      },
    );
    expect(diagnostics.map((d) => d.message)).toEqual([NEEDS_MESSAGE]);
    expect(calls).toEqual([]);
  });

  it("not for a tag a `transform` emitted (no authored name)", () => {
    const { calls, dialect } = spied();
    const { diagnostics } = run("<wrap/>\n", "reject", {
      dialect,
      customTags: {
        wrap: {
          transform: (call, ctx) => [
            ctx.build.delegatedTag(
              "emitted:x",
              call.content?.children ?? [],
              call.attributeTags,
            ),
          ],
        },
      },
    });
    expect(calls.map((c) => c.name)).not.toContain("emitted:x");
    expect(diagnostics.every((d) => d.code !== CODE)).toBe(true);
  });

  it("not for an attribute tag `<@x>`", () => {
    const { calls, dialect } = spied();
    const { diagnostics } = run("<holder><@meta:x/></holder>\n", "reject", {
      dialect,
      customTags: { holder: { attributeTags: { "meta:x": {} } } },
    });
    expect(diagnostics).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("not for an unknown attribute tag on the failure path", () => {
    const { calls, dialect } = spied();
    run("<holder><@meta:x/></holder>\n<needs/>\n", "reject", {
      dialect,
      customTags: { ...contracts, holder: {} },
    });
    expect(calls).toEqual([]);
  });

  it("not for a dynamic tag", () => {
    const { calls, dialect } = spied();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a dynamic tag's source text
    const { diagnostics } = run("<${name}/>\n", "reject", { dialect });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/dynamic tag/);
    expect(calls).toEqual([]);
  });

  it("not for a structural name (`if`, `for`, `const`)", () => {
    const { calls, dialect } = spied();
    run(
      "<if=a>\n  <for|x| of=y>\n    <const/z=1/>\n  </for>\n</if>\n",
      "allow",
      {
        dialect,
      },
    );
    expect(calls).toEqual([]);
    const failing = spied();
    run(
      "<needs/>\n<if=a>\n  <for|x| of=y>\n    <const/z=1/>\n  </for>\n</if>\n",
      "allow",
      { dialect: failing.dialect },
    );
    expect(failing.calls).toEqual([]);
  });

  it("not in a file whose dialect has no hook", () => {
    const { calls } = spied();
    const result = run("entity:Todo\n", "reject", {
      dialect: dialectOf(null),
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MX_UNKNOWN_TAG"]);
    expect(calls).toEqual([]);
  });
});

describe("explainUnknownTag: a hook that misbehaves is one positioned diagnostic", () => {
  const source = "<fields>\n  <a:b/>\n</fields>\n";
  const at = { line: 2, column: 2, offset: 11 };

  function hookError(message: string) {
    return {
      severity: "error",
      message,
      code: "MX_DIALECT_HOOK_ERROR",
      ...at,
      end: { line: 2, column: 6, offset: 15 },
    };
  }

  const broken: Array<[string, Dialect["explainUnknownTag"], string]> = [
    [
      "throws an Error",
      () => {
        throw new Error("boom");
      },
      "the dialect's `explainUnknownTag` threw while explaining `<a:b>`: boom",
    ],
    [
      "throws a non-Error",
      () => {
        throw "plain";
      },
      'the dialect\'s `explainUnknownTag` threw while explaining `<a:b>`: "plain"',
    ],
    [
      "returns an empty message",
      () => ({ message: "" }),
      'the dialect\'s `explainUnknownTag` must return a non-empty `message`, got "" for `<a:b>`',
    ],
    [
      "returns a non-string message",
      () => ({ message: 3 }) as never,
      "the dialect's `explainUnknownTag` must return a non-empty `message`, got a number for `<a:b>`",
    ],
    [
      "returns a span outside the document",
      () => ({ message: "x", at: { sourceStart: 0, sourceEnd: 9999 } }),
      "the dialect's `explainUnknownTag` must return `at` as a `{ sourceStart, sourceEnd }` span inside the document (0 to LEN) for `<a:b>`",
    ],
    [
      "returns a backwards span",
      () => ({ message: "x", at: { sourceStart: 5, sourceEnd: 2 } }),
      "the dialect's `explainUnknownTag` must return `at` as a `{ sourceStart, sourceEnd }` span inside the document (0 to LEN) for `<a:b>`",
    ],
    [
      "returns a non-string code",
      () => ({ message: "x", code: 7 }) as never,
      "the dialect's `explainUnknownTag` must return `code` as a non-empty string, got a number for `<a:b>`",
    ],
    [
      "returns an empty code",
      () => ({ message: "x", code: "" }),
      'the dialect\'s `explainUnknownTag` must return `code` as a non-empty string, got "" for `<a:b>`',
    ],
    [
      "returns a code that starts with `MX_`, MX's own prefix",
      () => ({ message: "x", code: "MX_UNKNOWN_TAG" }),
      "the dialect's `explainUnknownTag` returned a reserved `code` for `<a:b>`: code `MX_UNKNOWN_TAG` starts with `MX_`, which is MX's own prefix for its diagnostic codes; use the dialect's own prefix",
    ],
    [
      "returns a string",
      () => "nope" as never,
      'the dialect\'s `explainUnknownTag` must return an explanation object or undefined, got "nope" for `<a:b>`',
    ],
    [
      "returns null",
      () => null as never,
      "the dialect's `explainUnknownTag` must return an explanation object or undefined, got null for `<a:b>`",
    ],
    [
      "returns no message at all",
      () => ({}) as never,
      "the dialect's `explainUnknownTag` must return a non-empty `message`, got undefined for `<a:b>`",
    ],
    [
      "returns a promise",
      () => Promise.resolve({ message: "x" }) as never,
      "the dialect's `explainUnknownTag` must be synchronous: it returned a promise for `<a:b>`",
    ],
    [
      "returns an explanation whose `message` getter throws",
      () =>
        ({
          get message(): string {
            throw new Error("getter");
          },
        }) as never,
      "the dialect's `explainUnknownTag` threw while explaining `<a:b>`: getter",
    ],
    [
      "returns an explanation whose `at` getter throws",
      () =>
        ({
          message: "x",
          get at(): never {
            throw new Error("at getter");
          },
        }) as never,
      "the dialect's `explainUnknownTag` threw while explaining `<a:b>`: at getter",
    ],
    [
      "returns a proxy that throws on any read",
      () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error("proxy");
            },
          },
        ) as never,
      "the dialect's `explainUnknownTag` threw while explaining `<a:b>`: proxy",
    ],
    [
      "returns an array",
      () => [] as never,
      "the dialect's `explainUnknownTag` must return an explanation object or undefined, got an array for `<a:b>`",
    ],
  ];

  for (const mode of ["reject", "allow"] as const) {
    for (const [what, hook, message] of broken) {
      it(`${mode}: a hook that ${what} gives one MX_DIALECT_HOOK_ERROR at the tag, success path`, () => {
        const result = run(source, mode, { dialect: dialectOf(hook) });
        expect(result.ir).toBeUndefined();
        expect(result.diagnostics).toEqual([
          hookError(message.replace("LEN", String(source.length))),
        ]);
      });

      it(`${mode}: a hook that ${what} gives one MX_DIALECT_HOOK_ERROR at the tag, failure path`, () => {
        const result = run(`${source}${NEEDS}`, mode, {
          dialect: dialectOf(hook),
        });
        expect(result.ir).toBeUndefined();
        expect(result.diagnostics).toEqual([
          hookError(
            message.replace("LEN", String(source.length + NEEDS.length)),
          ),
          error(needsAt(source)),
        ]);
      });
    }
  }

  it("returning undefined is not an error", () => {
    const result = run(source, "allow", {
      dialect: dialectOf(() => undefined),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.ir).toBeDefined();
  });

  it("a valid span with no code gives the default `MX_DIALECT_ERROR` at `at`", () => {
    const result = run(source, "allow", {
      dialect: dialectOf((tag) => ({
        message: "plain",
        at: {
          sourceStart: tag.span.sourceStart,
          sourceEnd: tag.span.sourceEnd,
        },
      })),
    });
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        message: "plain",
        line: 2,
        column: 2,
        offset: 11,
        end: { line: 2, column: 8, offset: 17 },
        code: "MX_DIALECT_ERROR",
      },
    ]);
  });

  it("with no `at`, the error sits at the tag's `<`", () => {
    const result = run(source, "allow", {
      dialect: dialectOf(() => ({ message: "here" })),
    });
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        message: "here",
        line: 2,
        column: 2,
        offset: 11,
        end: { line: 2, column: 6, offset: 15 },
        code: "MX_DIALECT_ERROR",
      },
    ]);
  });

  it("`at` is read by core: a span at the very end of the document is allowed", () => {
    const result = run(source, "allow", {
      dialect: dialectOf(() => ({
        message: "end",
        at: { sourceStart: source.length, sourceEnd: source.length },
      })),
    });
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        message: "end",
        line: 4,
        column: 0,
        offset: source.length,
        end: { line: 4, column: 0, offset: source.length },
        code: "MX_DIALECT_ERROR",
      },
    ]);
  });

  it("lowerSource never throws, whatever the hook does", () => {
    expect(() =>
      run(source, "allow", {
        dialect: dialectOf(() => {
          throw undefined;
        }),
      }),
    ).not.toThrow();
  });
});

describe("explainUnknownTag: an explained tag gives no IR, even in allow mode", () => {
  it("allow mode, success path", () => {
    const { ir, diagnostics } = run("entity:Todo\n", "allow");
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
  });

  it("allow mode with the hook declining the tag lowers as before", () => {
    const { ir, diagnostics } = run("fields\n  other\n", "allow");
    expect(ir).toBeDefined();
    expect(diagnostics).toEqual([]);
  });

  it("allow mode with no hook accepts the colon name, as it does today", () => {
    const { ir } = run("entity:Todo\n", "allow", {
      dialect: dialectOf(null),
    });
    expect(ir).toBeDefined();
  });
});

describe("explainUnknownTag: errors inside an explained tag keep their label", () => {
  const holder: Record<string, CustomTag> = {
    ...contracts,
    holder: { attributes: {} },
  };

  it("a core error inside an explained tag is labelled; the explanation itself is not", () => {
    // `x:y` is explained; the unknown-attribute error inside it, a lowering
    // error, is labelled with the tag it is in.
    const source =
      "<holder>\n  <x:y>\n    <string zzz=1/>\n  </x:y>\n</holder>\n";
    const { diagnostics } = run(source, "reject", { customTags: holder });
    expect(diagnostics.map((d) => d.code)).toContain(CODE);
    const explained = diagnostics.find((d) => d.code === CODE);
    expect(explained?.message).toBe(againstTag("x:y", "x"));
    expect(explained?.message).not.toContain("inside the unknown tag");
  });

  it("a structural error inside an explained tag is labelled with the tag", () => {
    const { diagnostics } = run(
      "<fields>\n  <x:y>\n    <!doctype html>\n  </x:y>\n</fields>\n",
      "reject",
      { customTags: holder },
    );
    const labelled = diagnostics.find((d) => d.code !== CODE);
    expect(labelled?.message).toContain(
      "(inside the unknown tag `<x:y>`; may resolve once it is declared)",
    );
    const explained = diagnostics.find((d) => d.code === CODE);
    expect(explained?.message).toBe(againstTag("x:y", "x"));
  });

  it("on the failure path too", () => {
    // The lowering error is inside the explained tag: labelled with it.
    const { diagnostics } = run(
      "<fields>\n  <x:y>\n    <needs/>\n  </x:y>\n</fields>\n",
      "reject",
      { customTags: holder },
    );
    const labelled = diagnostics.find((d) => d.code !== CODE);
    expect(labelled?.message).toBe(
      `${NEEDS_MESSAGE} (inside the unknown tag \`<x:y>\`; may resolve once it is declared)`,
    );
    expect(diagnostics.find((d) => d.code === CODE)?.message).toBe(
      againstTag("x:y", "x"),
    );
  });

  it("an error not inside the explained tag is not labelled", () => {
    const { diagnostics } = run(
      "<needs/>\n<fields>\n  <x:y/>\n</fields>\n",
      "reject",
      { customTags: holder },
    );
    expect(diagnostics.map((d) => d.message)).toEqual([
      NEEDS_MESSAGE,
      againstTag("x:y", "x"),
    ]);
  });
});

describe("explainUnknownTag: the parent's `defaultTag`, not the call's, names an unnamed tag", () => {
  const tags: Record<string, CustomTag> = {
    set: { defaultTag: "setter", children: { uuid: {} } },
    setter: {},
    uuid: {},
  };

  it("`<set><#a/></set>`: one diagnostic, the one lowering gives (no spurious unknown tag)", () => {
    const { ir, diagnostics } = lowerSource("<set><#a/></set>", "/f.mx", {
      customTags: tags,
      tagRules: "none",
      unknownTags: "reject",
      defaultTag: "thing",
    });
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "MX_TAG_NOT_ALLOWED",
      line: 1,
      column: 5,
      offset: 5,
    });
    expect(diagnostics[0]?.message).toContain("`<setter>`");
    expect(diagnostics.map((d) => d.code)).not.toContain("MX_UNKNOWN_TAG");
  });

  it("the call's `defaultTag` still names an unnamed tag where no contract states one", () => {
    const { diagnostics } = lowerSource("<#a/>\n<needs/>\n", "/f.mx", {
      customTags: { needs: contracts.needs as CustomTag },
      tagRules: "none",
      unknownTags: "reject",
      defaultTag: "thing",
    });
    // `thing` has no contract; it is unknown, and so reported on the scan path.
    expect(diagnostics.map((d) => d.code)).toContain("MX_UNKNOWN_TAG");
  });

  it("an invalid contract `defaultTag` falls through to the call's, as lowering does", () => {
    const { diagnostics } = lowerSource(
      "<set><#a/></set>\n<needs/>\n",
      "/f.mx",
      {
        customTags: {
          ...contracts,
          set: { defaultTag: "nosuchtag", children: { uuid: {} } },
          uuid: {},
        },
        tagRules: "none",
        unknownTags: "reject",
      },
    );
    // Neither is a spurious `MX_UNKNOWN_TAG` for `<nosuchtag>`.
    expect(diagnostics.map((d) => d.message).join("\n")).not.toContain(
      "`<nosuchtag>` is not a known tag",
    );
  });

  it("the hook is told the name lowering uses for an unnamed tag", () => {
    const { calls, dialect } = spied(() => ({ message: "x" }));
    lowerSource("<set><#a/></set>", "/f.mx", {
      customTags: { set: { defaultTag: "unknownkind" } },
      dialect,
      tagRules: "none",
      unknownTags: "reject",
    });
    // The invalid default falls through to `object`, which is declared.
    expect(calls).toEqual([]);
  });
});

describe("explainUnknownTag: a dialect without the hook", () => {
  it("gives the same diagnostics as a dialect with a hook that explains nothing", () => {
    const sources = [
      "entity:Todo\n",
      "entity\n  attributes\n    foo\n",
      "<needs/>\nentity:Todo\n",
    ];
    for (const source of sources) {
      for (const mode of ["reject", "allow"] as const) {
        const none = run(source, mode, { dialect: dialectOf(null) });
        const declining = run(source, mode, {
          dialect: dialectOf(() => undefined),
        });
        expect(declining.diagnostics).toEqual(none.diagnostics);
        expect(declining.ir === undefined).toBe(none.ir === undefined);
      }
    }
  });
});

describe("explainUnknownTag: a module may export the hook", () => {
  it("a dialect whose `explainUnknownTag` is not a function is refused, naming the field", () => {
    const { ir, diagnostics } = run("entity:Todo\n", "allow", {
      dialect: { ...dialectOf(null), explainUnknownTag: "nope" as never },
    });
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain(
      "`dialect.explainUnknownTag` must be a function",
    );
  });
});
