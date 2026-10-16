import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import memberSyntax from "../fixtures/syntax/member-fixture.ts";
import { lowerSource } from "./index.ts";

/**
 * A `for` or `if` under `structural: "reject"` is one error, at the
 * construct, whatever it holds and wherever it stands. Before, a contract
 * tag's check of its children looked through the construct (control flow is
 * transparent to a contract) and failed the lowering first, so the file was
 * told about a child the construct holds and never about the construct.
 *
 * Under `structural: "pass"` the construct is legal and a contract still sees
 * what it holds: those rows pin that the fix did not blind it.
 */

const customTags: Record<string, CustomTag> = {
  // An entity-like parent: closed children, one of them with children of its own.
  entity: {
    children: { string: { repeatable: true }, section: { repeatable: true } },
  },
  section: { parents: ["entity"], children: { string: { repeatable: true } } },
  // A string-like child that lives only under those parents.
  string: { parents: ["entity", "section"] },
  // A tag with no contract on its children, and one no parent allows.
  plain: {},
  box: {},
  // A parent whose only child may appear once, and one that requires a child.
  single: { children: { item: {} } },
  item: {},
  need: { children: { title: { required: true } } },
  title: {},
};

const FOR = "Data files are static, so they do not evaluate `<for>`";
const IF = "Data files are static, so they do not evaluate `<if>`";

type Row = readonly [
  label: string,
  source: string,
  // [code, line, column, message]
  expected: ReadonlyArray<readonly [string, number, number, string]>,
];

function seen(source: string, options: Parameters<typeof lowerSource>[2]) {
  const result = lowerSource(source, "/t.mx", { customTags, ...options });
  expect(result.ir).toBeUndefined();
  return result.diagnostics.map((d) => [d.code, d.line, d.column, d.message]);
}

const OF = "|x| of=[1, 2]";

/** Each construct, with a body, with none and with an empty one, directly under `parent`. */
function underParent(
  open: string,
  close: string,
  indent: string,
  body: string,
): Row[] {
  const wrap = (inner: string) =>
    open ? `${open}\n${inner}\n${close}\n` : `${inner}\n`;
  const nested = (text: string) =>
    text
      .split("\n")
      .map((line) => (open ? `${indent}${line}` : line))
      .join("\n");
  const at = open ? 2 : 1;
  const col = open ? indent.length : 0;
  const forAt = ["MX_STRUCTURAL_CONSTRUCT", at, col, FOR] as const;
  const ifAt = ["MX_STRUCTURAL_CONSTRUCT", at, col, IF] as const;
  return [
    ["for with a body", wrap(nested(`<for${OF}>\n  ${body}\n</for>`)), [forAt]],
    ["for without a body", wrap(nested(`<for${OF}/>`)), [forAt]],
    ["for with an empty body", wrap(nested(`<for${OF}></for>`)), [forAt]],
    ["if with a body", wrap(nested(`<if=a>\n  ${body}\n</if>`)), [ifAt]],
    ["if without a body", wrap(nested("<if=a/>")), [ifAt]],
    ["if with an empty body", wrap(nested("<if=a></if>")), [ifAt]],
    [
      "if, else-if and else with bodies: one error, at the if",
      wrap(
        nested(
          `<if=a>\n  ${body}\n</if>\n<else-if=b>\n  ${body}\n</else-if>\n<else>\n  ${body}\n</else>`,
        ),
      ),
      [ifAt],
    ],
    [
      "if, else-if and else, empty",
      wrap(nested("<if=a></if>\n<else-if=b></else-if>\n<else></else>")),
      [ifAt],
    ],
    ["if and else without bodies", wrap(nested("<if=a/>\n<else/>")), [ifAt]],
  ];
}

describe("structural: reject, a for or if under a contract tag", () => {
  const options = { structural: "reject", unknownTags: "reject" } as const;

  describe.each([
    ["a tag the contract allows", "<string/>"],
    ["a tag the contract does not allow", "<box/>"],
  ])("holding %s", (_name, body) => {
    describe.each([
      ["directly under a contract tag", "<entity>", "</entity>", "  "],
      ["directly under a plain tag", "<plain>", "</plain>", "  "],
      ["at the top level", "", "", ""],
    ])("%s", (_where, open, close, indent) => {
      it.each(underParent(open, close, indent, body))("%s", (_l, src, want) => {
        expect(seen(src, options)).toEqual(want);
      });
    });
  });

  it("reports the construct two contracts deep, not what it holds", () => {
    expect(
      seen(
        "<entity>\n  <section>\n    <for|x| of=[1, 2]>\n      <box/>\n    </for>\n  </section>\n</entity>\n",
        options,
      ),
    ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 3, 4, FOR]]);
    expect(
      seen(
        "<entity>\n  <section>\n    <if=a>\n      <box/>\n    </if>\n  </section>\n</entity>\n",
        options,
      ),
    ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 3, 4, IF]]);
  });

  it("reports the construct when it is written as a concise line", () => {
    expect(seen("entity\n  for|x| of=[1, 2]\n    box\n", options)).toEqual([
      ["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR],
    ]);
    expect(seen("entity\n  if=a\n    box\n", options)).toEqual([
      ["MX_STRUCTURAL_CONSTRUCT", 2, 2, IF],
    ]);
  });

  it("does not report the parent the construct is transparent to", () => {
    // `string` lives under `entity` or `section` only.
    expect(
      seen(
        "<plain>\n  <for|x| of=[1, 2]>\n    <string/>\n  </for>\n</plain>\n",
        options,
      ),
    ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR]]);
    expect(seen("<for|x| of=[1, 2]>\n  <string/>\n</for>\n", options)).toEqual([
      ["MX_STRUCTURAL_CONSTRUCT", 1, 0, FOR],
    ]);
  });

  it("does not report a repeated, missing or text child the construct holds", () => {
    expect(
      seen(
        "<single>\n  <for|x| of=[1, 2]>\n    <item/>\n  </for>\n</single>\n",
        options,
      ),
    ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR]]);
    expect(
      seen("<need>\n  <if=a>\n    <title/>\n  </if>\n</need>\n", options),
    ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 2, 2, IF]]);
    expect(
      seen(
        "<entity>\n  <for|x| of=[1, 2]>\n    hello\n  </for>\n</entity>\n",
        options,
      ),
    ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR]]);
  });

  it("still reports a child the contract rejects with no construct around it", () => {
    expect(seen("<entity>\n  <box/>\n</entity>\n", options)).toEqual([
      [
        "MX_TAG_NOT_ALLOWED",
        2,
        2,
        "`<entity>`: `<box>` is not allowed here; allowed children: `<string>`, `<section>`",
      ],
    ]);
  });

  it("still reports a required child that is missing with no construct around it", () => {
    expect(seen("<need>\n  <plain/>\n</need>\n", options)).toEqual([
      [
        "MX_TAG_NOT_ALLOWED",
        2,
        2,
        "`<need>`: `<plain>` is not allowed here; allowed children: `<title>`",
      ],
    ]);
  });

  it("ends the message with the backticked construct", () => {
    for (const source of [
      "<entity>\n  <for|x| of=[1, 2]>\n    <box/>\n  </for>\n</entity>\n",
      "<entity>\n  <if=a>\n    <box/>\n  </if>\n</entity>\n",
    ]) {
      const [row] = seen(source, options);
      expect(row?.[0]).toBe("MX_STRUCTURAL_CONSTRUCT");
      expect(row?.[3]).toMatch(/\bevaluate `<(for|if)>`$/);
    }
  });

  it("is the same when the dialect, not the call, sets structural and unknownTags", () => {
    const dialect = {
      ...memberSyntax,
      name: "member",
      structural: "reject",
      unknownTags: "reject",
    } as const;
    expect(
      seen(
        "<entity>\n  <for|x| of=[1, 2]>\n    <box/>\n  </for>\n</entity>\n",
        {
          dialect,
        },
      ),
    ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR]]);
  });
});

describe("structural: pass (or unset), a contract tag still sees what a for or if holds", () => {
  const cases: ReadonlyArray<readonly [string, object]> = [
    ["structural: pass", { structural: "pass" }],
    ["structural unset", {}],
  ];

  describe.each(cases)("%s", (_name, options) => {
    it("accepts a tag the contract allows inside a for or if", () => {
      const ok = [
        "<entity>\n  <for|x| of=[1, 2]>\n    <string/>\n  </for>\n</entity>\n",
        "<entity>\n  <if=a>\n    <string/>\n  </if>\n  <else>\n    <string/>\n  </else>\n</entity>\n",
        "<entity>\n  <for|x| of=[1, 2]/>\n  <if=a/>\n</entity>\n",
      ];
      for (const source of ok) {
        const result = lowerSource(source, "/t.mx", {
          customTags,
          unknownTags: "reject",
          ...options,
        });
        expect(result.diagnostics).toEqual([]);
        expect(result.ir).toBeDefined();
      }
    });

    it.each([
      [
        "a child the contract does not allow, in a for",
        "<entity>\n  <for|x| of=[1, 2]>\n    <box/>\n  </for>\n</entity>\n",
        [
          "MX_TAG_NOT_ALLOWED",
          3,
          4,
          "`<entity>`: `<box>` is not allowed here; allowed children: `<string>`, `<section>`",
        ],
      ],
      [
        "a child the contract does not allow, in an if",
        "<entity>\n  <if=a>\n    <box/>\n  </if>\n</entity>\n",
        [
          "MX_TAG_NOT_ALLOWED",
          3,
          4,
          "`<entity>`: `<box>` is not allowed here; allowed children: `<string>`, `<section>`",
        ],
      ],
      [
        "a child the contract does not allow, in an else",
        "<entity>\n  <if=a>\n    <string/>\n  </if>\n  <else>\n    <box/>\n  </else>\n</entity>\n",
        [
          "MX_TAG_NOT_ALLOWED",
          6,
          4,
          "`<entity>`: `<box>` is not allowed here; allowed children: `<string>`, `<section>`",
        ],
      ],
      [
        "a child the contract does not allow, two contracts deep",
        "<entity>\n  <section>\n    <for|x| of=[1, 2]>\n      <box/>\n    </for>\n  </section>\n</entity>\n",
        [
          "MX_TAG_NOT_ALLOWED",
          4,
          6,
          "`<section>`: `<box>` is not allowed here; allowed children: `<string>`",
        ],
      ],
      [
        "a child the contract does not allow, on a concise line",
        "entity\n  if=a\n    box\n",
        [
          "MX_TAG_NOT_ALLOWED",
          3,
          4,
          "`<entity>`: `<box>` is not allowed here; allowed children: `<string>`, `<section>`",
        ],
      ],
      [
        "text",
        "<entity>\n  <for|x| of=[1, 2]>\n    hello\n  </for>\n</entity>\n",
        [
          "MX_TEXT_NOT_ALLOWED",
          3,
          4,
          "`<entity>`: text is not allowed here; it accepts only the child tags `<string>`, `<section>`",
        ],
      ],
      [
        "a non-repeatable child in a for",
        "<single>\n  <for|x| of=[1, 2]>\n    <item/>\n  </for>\n</single>\n",
        ["MX_REPEATED_CHILD", 3, 4, "`<single>`: `<item>` may not be repeated"],
      ],
      [
        "a required child only inside an if with no else",
        "<need>\n  <if=a>\n    <title/>\n  </if>\n</need>\n",
        [
          "MX_MISSING_CHILD",
          1,
          0,
          "`<need>`: missing required child `<title>`",
        ],
      ],
      [
        "a tag whose parent is the tag the for sits in",
        "<plain>\n  <for|x| of=[1, 2]>\n    <string/>\n  </for>\n</plain>\n",
        [
          "MX_PARENT_NOT_ALLOWED",
          3,
          4,
          "`<string>` must be inside `<entity>`, `<section>`; found inside `<plain>`",
        ],
      ],
      [
        "a tag whose parent is the top level, in a for",
        "<for|x| of=[1, 2]>\n  <string/>\n</for>\n",
        [
          "MX_PARENT_NOT_ALLOWED",
          2,
          2,
          "`<string>` must be inside `<entity>`, `<section>`; found at the top level",
        ],
      ],
    ])("reports %s", (_label, source, want) => {
      expect(seen(source, { unknownTags: "reject", ...options })).toEqual([
        want,
      ]);
    });
  });
});

describe("a tag whose transform consumes its body", () => {
  // `eater` returns no nodes, so a `for` or `if` in its body never reaches the
  // IR and the IR check cannot see it: the contract check reports it.
  const eaters: Record<string, CustomTag> = {
    ...customTags,
    leaf: {},
    eater: { children: { leaf: { repeatable: true } }, transform: () => [] },
    // No children contract at all.
    bare: { transform: () => [] },
  };
  const run = (
    source: string,
    options: Parameters<typeof lowerSource>[2],
  ): { ir: unknown; seen: unknown[] } => {
    const result = lowerSource(source, "/t.mx", {
      customTags: eaters,
      ...options,
    });
    return {
      ir: result.ir,
      seen: result.diagnostics.map((d) => [
        d.code,
        d.line,
        d.column,
        d.message,
      ]),
    };
  };
  const reject = { structural: "reject", unknownTags: "reject" } as const;
  const pass = { structural: "pass", unknownTags: "reject" } as const;

  it.each([
    [
      "a for holding a tag the contract does not allow",
      "<eater>\n  <for|x| of=[1]>\n    <box/>\n  </for>\n</eater>\n",
      ["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR],
    ],
    [
      "an if holding a tag that needs another parent",
      "<eater>\n  <if=a>\n    <section/>\n  </if>\n</eater>\n",
      ["MX_STRUCTURAL_CONSTRUCT", 2, 2, IF],
    ],
    [
      "a for holding a tag the contract allows",
      "<eater>\n  <for|x| of=[1]>\n    <leaf/>\n  </for>\n</eater>\n",
      ["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR],
    ],
    [
      "an if, else-if and else: one error, at the if",
      "<eater>\n  <if=a>\n    <box/>\n  </if>\n  <else-if=b>\n    <box/>\n  </else-if>\n  <else>\n    <box/>\n  </else>\n</eater>\n",
      ["MX_STRUCTURAL_CONSTRUCT", 2, 2, IF],
    ],
    [
      "an empty for",
      "<eater>\n  <for|x| of=[1]></for>\n</eater>\n",
      ["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR],
    ],
    [
      "a for in a transform tag with no children contract",
      "<bare>\n  <for|x| of=[1]>\n    <box/>\n  </for>\n</bare>\n",
      ["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR],
    ],
  ] as const)("reject: %s is the construct", (_label, source, want) => {
    const { ir, seen: found } = run(source, reject);
    expect(ir).toBeUndefined();
    expect(found).toEqual([want]);
    expect(want[3]).toMatch(/\bevaluate `<(for|if)>`$/);
  });

  it.each([
    [
      "a for holding a tag the contract does not allow",
      "<eater>\n  <for|x| of=[1]>\n    <box/>\n  </for>\n</eater>\n",
      [
        "MX_TAG_NOT_ALLOWED",
        3,
        4,
        "`<eater>`: `<box>` is not allowed here; allowed children: `<leaf>`",
      ],
    ],
  ] as const)("pass: %s is still checked", (_label, source, want) => {
    expect(run(source, pass).seen).toEqual([want]);
  });

  it("pass: a for holding an allowed tag is clean", () => {
    const { ir, seen: found } = run(
      "<eater>\n  <for|x| of=[1]>\n    <leaf/>\n  </for>\n</eater>\n",
      pass,
    );
    expect(found).toEqual([]);
    expect(ir).toBeDefined();
  });
});
