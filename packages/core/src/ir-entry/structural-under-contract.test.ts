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
  describe("declared through the dialect's contracts", () => {
    const dialect = {
      ...memberSyntax,
      name: "member",
      structural: "reject",
      unknownTags: "reject",
      contracts: {
        eater: {
          children: { leaf: { repeatable: true } },
          transform: () => [],
        },
        leaf: {},
        box: {},
        section: { parents: ["entity"] },
        entity: {},
      },
    } as unknown as NonNullable<Parameters<typeof lowerSource>[2]>["dialect"];

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
    ] as const)("%s", (_label, source, want) => {
      const result = lowerSource(source, "/t.mx", { dialect });
      expect(result.ir).toBeUndefined();
      expect(
        result.diagnostics.map((d) => [d.code, d.line, d.column, d.message]),
      ).toEqual([want]);
    });
  });
  describe("deeper than the direct body of a transforming tag", () => {
    const deep = (structural: "pass" | "reject") =>
      ({
        ...memberSyntax,
        name: "member",
        structural,
        unknownTags: "reject",
        contracts: {
          eater: {
            children: { string: {}, inner: {} },
            attributeTags: { meta: { children: { string: {} } } },
            transform: () => [],
          },
          inner: { children: { string: {} } },
          string: {},
          box: {},
        },
      }) as unknown as NonNullable<
        Parameters<typeof lowerSource>[2]
      >["dialect"];
    const found = (source: string, structural: "pass" | "reject") => {
      const result = lowerSource(source, "/t.mx", {
        dialect: deep(structural),
      });
      return result.diagnostics.map((d) => [
        d.code,
        d.line,
        d.column,
        d.message,
      ]);
    };
    const nested =
      "<eater>\n  <inner>\n    <for|x| of=[1]>\n      <box/>\n    </for>\n  </inner>\n</eater>\n";
    const meta =
      "<eater>\n  <@meta>\n    <for|x| of=[1]>\n      <box/>\n    </for>\n  </@meta>\n</eater>\n";

    it.each([
      [
        "a for in a contract tag inside the transforming tag",
        nested,
        3,
        4,
        FOR,
      ],
      ["a for in an attribute tag of the transforming tag", meta, 3, 4, FOR],
      [
        "an if in a contract tag inside the transforming tag",
        nested.replace("<for|x| of=[1]>", "<if=a>").replace("</for>", "</if>"),
        3,
        4,
        IF,
      ],
    ] as const)("reject: %s is the construct", (_l, source, line, col, msg) => {
      expect(found(source, "reject")).toEqual([
        ["MX_STRUCTURAL_CONSTRUCT", line, col, msg],
      ]);
    });

    it("pass: the contract still checks what the for holds", () => {
      expect(found(nested, "pass").map((d) => d[0])).toEqual([
        "MX_TAG_NOT_ALLOWED",
      ]);
      expect(found(meta, "pass").map((d) => d[0])).toContain(
        "MX_TAG_NOT_ALLOWED",
      );
    });

    it("reports the earlier of a disallowed child and a construct in the body", () => {
      expect(
        found("<eater>\n  <box/>\n  <for|x| of=[1]/>\n</eater>\n", "reject"),
      ).toEqual([
        [
          "MX_TAG_NOT_ALLOWED",
          2,
          2,
          "`<eater>`: `<box>` is not allowed here; allowed children: `<string>`, `<inner>`",
        ],
      ]);
      expect(
        found("<eater>\n  <for|x| of=[1]/>\n  <box/>\n</eater>\n", "reject"),
      ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR]]);
    });
  });
});

describe("structural: reject, a for or if written with a head the construct would refuse", () => {
  // The construct is the error however its head is written. A shape error of
  // the head (arguments, params, a missing condition) would otherwise name a
  // way to write the construct that this file cannot use either.
  const reject = { structural: "reject", unknownTags: "reject" } as const;
  const eaters: Record<string, CustomTag> = {
    ...customTags,
    leaf: {},
    eater: {
      children: { leaf: { repeatable: true }, inner: { repeatable: true } },
      transform: () => [],
    },
    inner: { parents: ["eater"], children: { leaf: { repeatable: true } } },
  };
  const found = (
    source: string,
    options: Parameters<typeof lowerSource>[2],
    tags: Record<string, CustomTag> = eaters,
  ) => {
    const result = lowerSource(source, "/t.mx", {
      customTags: tags,
      ...options,
    });
    expect(result.ir).toBeUndefined();
    return result.diagnostics.map((d) => [d.code, d.line, d.column, d.message]);
  };

  // [label, the construct's lines, keyword]
  const heads: ReadonlyArray<readonly [string, string, "for" | "if"]> = [
    ["if(x)", "<if(x)>\n  <string/>\n</if>", "if"],
    ["if(x) with an attribute", "<if(x) y=1>\n  <string/>\n</if>", "if"],
    ["if(x) with no body", "<if(x)/>", "if"],
    ["if with params", "<if|x|=a>\n  <string/>\n</if>", "if"],
    ["if with params and arguments", "<if|x|(y)>\n  <string/>\n</if>", "if"],
    ["if with no condition", "<if>\n  <string/>\n</if>", "if"],
    [
      "else-if(x) after an if",
      "<if=a>\n  <string/>\n</if>\n<else-if(x)>\n  <string/>\n</else-if>",
      "if",
    ],
    [
      "else(x) after an if",
      "<if=a>\n  <string/>\n</if>\n<else(x)>\n  <string/>\n</else>",
      "if",
    ],
    [
      "if(x) and else-if(x): one error, at the if",
      "<if(x)>\n  <string/>\n</if>\n<else-if(x)>\n  <string/>\n</else-if>",
      "if",
    ],
    ["for(x)", "<for(x)>\n  <string/>\n</for>", "for"],
    ["for|x|(y)", "<for|x|(y)>\n  <string/>\n</for>", "for"],
    ["for|x|(y) of=[1]", "<for|x|(y) of=[1]>\n  <string/>\n</for>", "for"],
    ["for with no params", "<for>\n  <string/>\n</for>", "for"],
    ["for|x| with no source", "<for|x|>\n  <string/>\n</for>", "for"],
    ["for|x| with two sources", "<for|x| of=[1] in=o/>", "for"],
  ];
  const at = (keyword: "for" | "if") => (keyword === "for" ? FOR : IF);
  const indent = (text: string, by: string) =>
    text
      .split("\n")
      .map((line) => by + line)
      .join("\n");

  describe.each([
    ["at the top level", (s: string) => s, 1, 0],
    [
      "directly under a closed parent",
      (s: string) => `<entity>\n${indent(s, "  ")}\n</entity>`,
      2,
      2,
    ],
    [
      "directly under a plain tag",
      (s: string) => `<plain>\n${indent(s, "  ")}\n</plain>`,
      2,
      2,
    ],
    [
      "two contracts deep",
      (s: string) =>
        `<entity>\n  <section>\n${indent(s, "    ")}\n  </section>\n</entity>`,
      3,
      4,
    ],
    [
      "directly under a tag whose transform consumes its body",
      (s: string) => `<eater>\n${indent(s, "  ")}\n</eater>`,
      2,
      2,
    ],
    [
      "in a contract tag inside a tag whose transform consumes its body",
      (s: string) =>
        `<eater>\n  <inner>\n${indent(s, "    ")}\n  </inner>\n</eater>`,
      3,
      4,
    ],
  ])("%s", (_where, wrap, line, column) => {
    it.each(heads)("%s is the construct, once", (_l, text, keyword) => {
      const want = ["MX_STRUCTURAL_CONSTRUCT", line, column, at(keyword)];
      const rows = found(`${wrap(text)}\n`, reject);
      expect(rows).toEqual([want]);
      expect(String(rows[0]?.[3])).toMatch(/\bevaluate `<(for|if)>`$/);
    });
  });

  it.each([
    ["if(x)", "entity\n  if(x)\n    string\n", "if"],
    ["for|x|(y)", "entity\n  for|x|(y)\n    string\n", "for"],
    [
      "else-if(x)",
      "entity\n  if=a\n    string\n  else-if(x)\n    string\n",
      "if",
    ],
  ] as const)("concise %s is the construct, once", (_l, source, keyword) => {
    expect(found(source, reject)).toEqual([
      ["MX_STRUCTURAL_CONSTRUCT", 2, 2, at(keyword)],
    ]);
  });

  it("reports each construct that is shaped like one, in the dialect's own words", () => {
    const dialect = {
      ...memberSyntax,
      name: "member",
      structural: "reject",
      unknownTags: "reject",
    } as const;
    expect(
      found("<entity>\n  <if(x)/>\n</entity>\n", { dialect }, customTags),
    ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 2, 2, IF]]);
    expect(
      found("<entity>\n  <for|x|(y)/>\n</entity>\n", { dialect }, customTags),
    ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 2, 2, FOR]]);
  });

  it("keeps the shape error where the construct is legal: structural pass and unset", () => {
    const IF_HINT =
      "Tag does not support arguments. Write the condition as a value attribute instead: `<if=condition>`. For an event handler write `onX=handler`";
    const ELSE_IF_HINT = IF_HINT.replace("<if=", "<else-if=");
    const ELSE_HINT =
      "Tag does not support arguments. Write the condition as an attribute instead: `<else if=condition>`. For an event handler write `onX=handler`";
    const FOR_HINT =
      "Tag does not support arguments. For an event handler write `onY=handler`";
    for (const options of [
      { structural: "pass", unknownTags: "reject" },
      { unknownTags: "reject" },
    ] as const) {
      expect(found("<plain>\n  <if(x)/>\n</plain>\n", options)).toEqual([
        ["MX_UNSUPPORTED_CONSTRUCT", 2, 6, IF_HINT],
      ]);
      expect(found("<if(x)/>\n", options)).toEqual([
        ["MX_UNSUPPORTED_CONSTRUCT", 1, 4, IF_HINT],
      ]);
      expect(found("<if=a/>\n<else-if(x)/>\n", options)).toEqual([
        ["MX_UNSUPPORTED_CONSTRUCT", 2, 9, ELSE_IF_HINT],
      ]);
      expect(found("<if=a/>\n<else(x)/>\n", options)).toEqual([
        ["MX_UNSUPPORTED_CONSTRUCT", 2, 6, ELSE_HINT],
      ]);
      expect(found("<for|x|(y)/>\n", options)).toEqual([
        ["MX_UNSUPPORTED_CONSTRUCT", 1, 8, FOR_HINT],
      ]);
      expect(found("<plain>\n  <for|x|(y)/>\n</plain>\n", options)).toEqual([
        ["MX_UNSUPPORTED_CONSTRUCT", 2, 10, FOR_HINT],
      ]);
      expect(found("<for/>\n", options)).toEqual([
        [
          "MX_INVALID_FOR",
          1,
          0,
          "`<for>` needs tag params: `<for|item| of=…>`",
        ],
      ]);
      expect(found("<if/>\n", options)).toEqual([
        ["MX_INVALID_IF", 1, 0, "`<if>` without a condition"],
      ]);
      expect(found("<if|x|=a/>\n", options)).toEqual([
        [
          "MX_UNSUPPORTED_CONSTRUCT",
          1,
          0,
          "tag params `|...|` on `<if>` are not supported in a standalone template",
        ],
      ]);
    }
  });

  it("keeps MX's own hint with no contract, no dialect and no structural option", () => {
    const result = lowerSource("<if(x)/>\n", "/t.mx", {});
    expect(result.diagnostics.map((d) => [d.code, d.line, d.column])).toEqual([
      ["MX_UNSUPPORTED_CONSTRUCT", 1, 4],
    ]);
    expect(result.diagnostics[0]?.message).toBe(
      "Tag does not support arguments. Write the condition as a value attribute instead: `<if=condition>`. For an event handler write `onX=handler`",
    );
    const loop = lowerSource("<for|x|(y)/>\n", "/t.mx", {});
    expect(loop.diagnostics.map((d) => [d.code, d.line, d.column])).toEqual([
      ["MX_UNSUPPORTED_CONSTRUCT", 1, 8],
    ]);
    expect(loop.diagnostics[0]?.message).toBe(
      "Tag does not support arguments. For an event handler write `onY=handler`",
    );
  });

  it("still reports a construct written well, and an error that is not the construct's head", () => {
    expect(found("<if=a>\n  <string/>\n</if>\n", reject)).toEqual([
      ["MX_STRUCTURAL_CONSTRUCT", 1, 0, IF],
    ]);
    expect(found("<entity>\n  <box/>\n</entity>\n", reject)[0]?.[0]).toBe(
      "MX_TAG_NOT_ALLOWED",
    );
  });
});

describe("structural: reject, an orphan else or else-if is the if construct", () => {
  const orphanText = (name: string) =>
    `\`<${name}>\` is part of \`<if>\`, and data files are static, so they do not evaluate \`<if>\``;
  const reservedText = (name: string) =>
    `\`<${name}>\` cannot name a data tag: it is reserved — core consumes the structural names (\`if\`, \`else\`, \`else-if\`, \`for\`, \`const\`, \`define\`, \`return\`, \`import\`, \`export\`, \`static\`) and \`<try>\` before a target sees them`;
  const eaters: Record<string, CustomTag> = {
    ...customTags,
    eater: { children: { box: { repeatable: true } }, transform: () => [] },
  };
  const reject = { structural: "reject", unknownTags: "reject" } as const;
  const run = (
    source: string,
    options: Parameters<typeof lowerSource>[2],
    tags: Record<string, CustomTag> | undefined = eaters,
  ) => {
    const result = lowerSource(source, "/t.mx", {
      ...(tags ? { customTags: tags } : {}),
      ...options,
    });
    expect(result.ir).toBeUndefined();
    return result.diagnostics.map((d) => [d.code, d.line, d.column, d.message]);
  };
  const indent = (text: string, by: string) =>
    text
      .split("\n")
      .map((line) => by + line)
      .join("\n");

  const forms: ReadonlyArray<readonly [string, string, string]> = [
    ["an orphan else with a body", "<else>\n  <box/>\n</else>", "else"],
    ["an empty orphan else", "<else/>", "else"],
    ["an orphan else-if(x)", "<else-if(x)>\n  <box/>\n</else-if>", "else-if"],
    ["an orphan else-if=x", "<else-if=x>\n  <box/>\n</else-if>", "else-if"],
  ];
  const wrappers: ReadonlyArray<
    readonly [string, (s: string) => string, number]
  > = [
    ["at the root", (s) => `${s}\n`, 0],
    [
      "under a closed parent",
      (s) => `<entity>\n${indent(s, "  ")}\n</entity>\n`,
      2,
    ],
    [
      "under a transforming tag",
      (s) => `<eater>\n${indent(s, "  ")}\n</eater>\n`,
      2,
    ],
    [
      "two contracts deep",
      (s) =>
        `<entity>\n  <section>\n${indent(s, "    ")}\n  </section>\n</entity>\n`,
      4,
    ],
  ];

  describe.each(wrappers)("%s", (_where, wrap, col) => {
    it.each(forms)("reject: %s is one error, at the tag", (_l, src, name) => {
      // The tag sits on line `n` of the wrapped source; find it.
      const wrapped = wrap(src);
      const line =
        wrapped
          .split("\n")
          .findIndex((l) => l.trimStart().startsWith(`<${name}`)) + 1;
      expect(run(wrapped, reject)).toEqual([
        ["MX_STRUCTURAL_CONSTRUCT", line, col, orphanText(name)],
      ]);
    });
  });

  it("reject: an else after a non-if sibling is the construct, at the else", () => {
    expect(run("<plain/>\n<else>\n  <box/>\n</else>\n", reject)).toEqual([
      ["MX_STRUCTURAL_CONSTRUCT", 2, 0, orphanText("else")],
    ]);
    expect(run("<plain>\n  <box/>\n  <else/>\n</plain>\n", reject)).toEqual([
      ["MX_STRUCTURAL_CONSTRUCT", 3, 2, orphanText("else")],
    ]);
  });

  it("reject: concise orphan else and else-if", () => {
    expect(run("else\n  box\n", reject)).toEqual([
      ["MX_STRUCTURAL_CONSTRUCT", 1, 0, orphanText("else")],
    ]);
    expect(run("else-if=x\n  box\n", reject)).toEqual([
      ["MX_STRUCTURAL_CONSTRUCT", 1, 0, orphanText("else-if")],
    ]);
  });

  it("reject: an else after an if keeps the one report, at the if", () => {
    expect(run("<if=a><box/></if>\n<else><box/></else>\n", reject)).toEqual([
      ["MX_STRUCTURAL_CONSTRUCT", 1, 0, IF],
    ]);
  });

  it("reject: an else that follows a closed if chain is reported once", () => {
    expect(
      run(
        "<if=a><box/></if>\n<else><box/></else>\n<else><box/></else>\n",
        reject,
      ),
    ).toEqual([["MX_STRUCTURAL_CONSTRUCT", 3, 0, orphanText("else")]]);
  });

  it("ends the message with the backticked if, as Mesh parses it", () => {
    expect(run("<else/>\n", reject)[0]?.[3]).toMatch(/\bevaluate `<if>`$/);
  });

  describe("pass, unset and no dialect keep the reserved-name text", () => {
    it.each([
      ["pass", { structural: "pass", unknownTags: "reject" } as const, eaters],
      ["unset", { unknownTags: "reject" } as const, eaters],
      ["no dialect", {} as const, undefined],
    ])("%s", (_mode, options, tags) => {
      expect(run("<else>\n  <box/>\n</else>\n", options, tags)).toEqual([
        ["MX_NOT_IN_DATA_FILE", 1, 0, reservedText("else")],
      ]);
      expect(run("<else-if=x>\n  <box/>\n</else-if>\n", options, tags)).toEqual(
        [["MX_NOT_IN_DATA_FILE", 1, 0, reservedText("else-if")]],
      );
    });
  });
});
