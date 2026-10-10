/**
 * Every error of a file is a positioned diagnostic, and no input makes
 * `lowerSource` throw. Measured before this change (on `parseData`, which this
 * entry point replaced): Marko's `CompileErrors` aggregate (several parse
 * errors) and an internal span invariant escaped as raw throws, and the check,
 * the structural reject and `unknownTags` each reported only the first hit.
 */

import { WEB_ELEMENTS } from "@mxlang/web-elements";
import { describe, expect, it } from "vitest";
import { compileSource } from "../compile.ts";
import type { CustomTag } from "../custom-tags.ts";
import type { Ir } from "../ir.ts";
import { taglibsOfRules, tagRulesPreset } from "../tag-presets.ts";
import { createTargetLookup } from "../target-descriptor.ts";
import { checkIr } from "./checks.ts";
import { DEFAULT_TAG, entryDeclarations } from "./declarations.ts";
import { type LowerSourceOptions, lowerSource } from "./index.ts";

const customTags: Record<string, CustomTag> = { a: {} };

/** `[line, column]` of every diagnostic, in order. */
function positions(source: string, options?: LowerSourceOptions) {
  const { diagnostics } = lowerSource(source, "/t.mx", options);
  return diagnostics.map((d) => [d.line, d.column]);
}

describe("every error is reported", () => {
  it("returns every syntax error Marko's parser recovers from", () => {
    const { ir, diagnostics } = lowerSource(
      `<a x=\${y}/><!-- c\n<b x=(\n`,
      "/t.mx",
    );
    expect(ir).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message: "Expected a single expression, but found `{` after it.",
        line: 1,
        column: 6,
        offset: 6,
      },
      {
        severity: "error",
        message: "EOF reached while parsing comment",
        line: 1,
        column: 11,
        offset: 11,
      },
    ]);
  });

  it("returns every build reject, in file order", () => {
    const { ir, diagnostics } = lowerSource(
      `<\${x}/>\n<\${y}/>\n<a/>\n<!doctype html>\n`,
      "/t.mx",
    );
    expect(ir).toBeUndefined();
    expect(diagnostics.map((d) => [d.line, d.column, d.offset])).toEqual([
      [1, 0, 0],
      [2, 0, 8],
      [4, 0, 21],
    ]);
    expect(diagnostics.map((d) => d.message.slice(0, 13))).toEqual([
      "a dynamic tag",
      "a dynamic tag",
      "`<!doctype>` ",
    ]);
  });

  it("returns a reject in every sibling and inside every parent", () => {
    expect(
      positions(`<a/x/>\n<b>\n  <\${y}/>\n  <c/z/>\n</b>\n<d.k class='m'/>\n`),
    ).toEqual([
      [1, 0],
      [3, 2],
      [4, 2],
      [6, 0],
    ]);
  });

  it("returns every structural construct under structural: reject; comments are not among them", () => {
    const source = `import a from 'b'\n<a>hi</a>\n\${x}\n<!-- c -->\n<if=x><b/></if>\n<for|i| of=l><c/></for>\n<const/y=1/>\nexport const z = 1\n`;
    const { diagnostics } = lowerSource(source, "/t.mx", {
      structural: "reject",
    });
    // Line 4 is the comment: never structural, never reported (decision 131
    // addendum 5).
    expect(diagnostics.map((d) => [d.line, d.column])).toEqual([
      [1, 0],
      [2, 3],
      [3, 0],
      [5, 0],
      [6, 0],
      [7, 0],
      [8, 0],
    ]);
    expect(diagnostics[0]?.message).toBe(
      "the data tree is static; this file's consumer does not evaluate `import`",
    );
  });

  it("returns every unknown tag, the one inside an unknown tag included", () => {
    expect(
      positions("<foo/>\n<bar/>\n<baz><qux/></baz>\n", {
        unknownTags: "reject",
        customTags,
      }),
    ).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 5],
    ]);
  });

  it("merges build, structural and unknown-tag errors by position", () => {
    const { diagnostics } = lowerSource(
      `<\${x}/>\n<foo/>\n<a>hi</a>\n<a/>\n`,
      "/t.mx",
      { structural: "reject", unknownTags: "reject", customTags },
    );
    expect(diagnostics.map((d) => [d.line, d.column])).toEqual([
      [1, 0],
      [2, 0],
      [3, 3],
    ]);
    expect(diagnostics[0]?.message).toMatch(/^a dynamic tag/);
    expect(diagnostics[1]?.message).toMatch(/^`<foo>` is not a known tag/);
    expect(diagnostics[2]?.message).toMatch(/^the data tree is static/);
  });

  it("lists the unknown tags beside a core lowering error", () => {
    const diagnostics = lowerSource("<foo/>\n<if(x)></if>\n<bar/>\n", "/t.mx", {
      unknownTags: "reject",
      customTags,
    }).diagnostics;
    expect(diagnostics.map((d) => [d.line, d.column])).toEqual([
      [1, 0],
      [2, 4],
      [3, 0],
    ]);
    expect(diagnostics[1]?.message).toContain(
      "Tag does not support arguments.",
    );
  });

  // An expression that fails to parse does not hide the unknown tags: the
  // reject scan refuses only a template that does not parse (PR 450 round 2;
  // values measured on main, 9293794df).
  const unknown = (name: string) =>
    `\`<${name}>\` is not a known tag: it has no contract in \`customTags\``;
  it.each([
    [
      "<foo x=a.#b/>",
      [
        [unknown("foo"), 1, 0],
        ["Private name #b is not defined.", 1, 9],
      ],
    ],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax, not a JS template
      "<foo>${a +}</foo>",
      [
        [unknown("foo"), 1, 0],
        ["Unexpected token", 1, 10],
      ],
    ],
    [
      "<div:=this.#x/>",
      [
        [unknown("div"), 1, 0],
        ["Private name #x is not defined.", 1, 11],
      ],
    ],
    [
      "<foo/>\n<bar x=a.#b/>",
      [
        [unknown("foo"), 1, 0],
        [unknown("bar"), 2, 0],
        ["Private name #b is not defined.", 2, 9],
      ],
    ],
    [
      "<foo x=(a b)/>",
      [
        [unknown("foo"), 1, 0],
        ['Unexpected token, expected ","', 1, 10],
      ],
    ],
  ])(
    "lists the unknown tags beside an expression error: %j",
    (source, expected) => {
      const { ir, diagnostics } = lowerSource(source, "/t.mx", {
        unknownTags: "reject",
      });
      expect(ir).toBeUndefined();
      expect(diagnostics.map((d) => [d.message, d.line, d.column])).toEqual(
        expected,
      );
    },
  );

  it("reports one error once, even when two walks find it", () => {
    const { diagnostics } = lowerSource("<a/z/>\n", "/t.mx", {
      structural: "reject",
      unknownTags: "reject",
      customTags: {},
    });
    const keys = diagnostics.map((d) => `${d.line}:${d.column}:${d.message}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not add an internal error for the tag a merged class rejects", () => {
    const { diagnostics } = lowerSource('<x.a class="b"/>\n<y/z/>\n', "/t.mx");
    expect(diagnostics.map((d) => [d.line, d.column])).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(diagnostics.some((d) => d.message.startsWith("internal"))).toBe(
      false,
    );
  });
});

describe("no input makes lowerSource throw", () => {
  const OPTIONS: (LowerSourceOptions | undefined)[] = [
    undefined,
    { structural: "reject" },
    { unknownTags: "reject", customTags: {} },
    { defaultTag: "nope" },
  ];
  // Inputs that threw before: Marko's `CompileErrors` aggregate, and sources
  // whose lowering leaves a node without a span.
  const FORMER_THROWS = [
    `<a x=\${y}/><!-- c\n`,
    "}</a>}",
    `<a x:y=1/><a x=\${y}/><a <b/>/>`,
    "'<a/[x]/><a  /><a x=(#",
    "<a x=1 x=2 x=3/><a x:=1/>",
    `x<a x=\`\${<a>`,
    `:x<a x=\`\${<a></a>`,
  ];

  for (const source of FORMER_THROWS) {
    it(`returns diagnostics for ${JSON.stringify(source)}`, () => {
      for (const options of OPTIONS) {
        const result = lowerSource(source, "/t.mx", options);
        const errors = result.diagnostics.filter((d) => d.severity === "error");
        if (result.ir) expect(errors).toEqual([]);
        else expect(errors.length).toBeGreaterThan(0);
        for (const d of result.diagnostics) {
          expect(d.line).toBeGreaterThanOrEqual(1);
          expect(d.column).toBeGreaterThanOrEqual(0);
          expect(d.offset).toBeGreaterThanOrEqual(0);
        }
      }
    });
  }

  it("flattens a Marko aggregate that has no position of its own", () => {
    const { diagnostics } = lowerSource(`<a x=\${y}/><!-- c\n`, "/t.mx");
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(diagnostics.every((d) => d.line >= 1)).toBe(true);
  });

  it("reports input ending inside a concise open delimiter at the opener", () => {
    // Marko's parser was silent here and its tree left `<x>` with no
    // position, which only this target's span invariant caught; the front end
    // reports it (decision 161: no silent drop).
    const { ir, diagnostics } = lowerSource(`x<a x=\`\${<a>`, "/t.mx");
    expect(ir).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message: "the input ends inside `<`…`>` opened here",
        line: 1,
        column: 1,
        offset: 1,
      },
    ]);
  });

  // Main's first diagnostic was a real error (kept first, same text and
  // position) or only the span invariant / nothing (the new error stands).
  it.each([
    [
      "$ {a",
      "scriptlets (`$ statement`) are not supported in MX (decision 54)",
      1,
      0,
    ],
    [`script -- \${b`, "EOF reached while parsing placeholder", 1, 12],
    ["div(a", "the input ends inside `(`…`)` opened here", 1, 3],
    ["div|a", "the input ends inside `|`…`|` opened here", 1, 3],
    ["div onClick(a) {b", "the input ends inside `{`…`}` opened here", 1, 15],
    [`div x=\`\${a`, "the input ends inside `` ` ``…`` ` `` opened here", 1, 6],
    [`\${x`, `the input ends inside \`\${\`…\`}\` opened here`, 1, 0],
  ])(
    "%j at end of input: main's error first, else the new one",
    (source, message, line, column) => {
      // Measured against `parseData`, whose taglib was the `none` preset.
      const { ir, diagnostics } = lowerSource(source, "/t.mx", {
        tagRules: "none",
      });
      expect(ir).toBeUndefined();
      expect(diagnostics[0]).toMatchObject({ message, line, column });
    },
  );

  it("under the strict default, a `script` body's open `${` is the new error", () => {
    // `script` is raw text there (decision 212 item 8), so the `${` opens in
    // its body text rather than in a tag head.
    const { ir, diagnostics } = lowerSource(`script -- \${b`, "/t.mx");
    expect(ir).toBeUndefined();
    expect(diagnostics[0]).toMatchObject({
      message: `the input ends inside \`\${\`…\`}\` opened here`,
      line: 1,
      column: 10,
    });
  });

  it("reports an internal invariant at the file start under a distinct prefix", () => {
    // A macro returning a node with no span breaks the invariant.
    const { ir, diagnostics } = lowerSource("<a/>\n<m/>\n", "/t.mx", {
      customTags: {
        m: {
          transform: () => [
            { kind: "Text", value: "x", loc: { line: 2, column: 0 } },
          ],
        },
      },
    });
    expect(ir).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message:
          "internal error: @mxlang/core: IR invariant broken — text carries no span",
        line: 1,
        column: 0,
        offset: 0,
      },
    ]);
  });

  it("keeps a source error free of the internal prefix", () => {
    const { diagnostics } = lowerSource("<a b=>\n", "/t.mx");
    expect(diagnostics[0]?.message).toBe("Missing value for attribute");
  });
});

describe("a clean file is unchanged", () => {
  it("returns the IR and no diagnostics", () => {
    const { ir, diagnostics } = lowerSource(
      '<a b="1">\n  <c d=2/>\n</a>\n',
      "/t.mx",
    );
    expect(diagnostics).toEqual([]);
    expect(ir?.body.map((node) => node.kind)).toEqual(["DelegatedTag"]);
  });

  it("still returns its warnings alongside the IR", () => {
    const { ir, diagnostics } = lowerSource("<a/>\n<b x=1 x=2/>\n", "/t.mx");
    expect(ir).toBeDefined();
    expect(diagnostics.map((d) => [d.severity, d.line, d.column])).toEqual([
      ["warning", 2, 3],
    ]);
  });

  it("is clean under every strict option", () => {
    const { ir, diagnostics } = lowerSource("<a b=1/>\n", "/t.mx", {
      structural: "reject",
      unknownTags: "reject",
      customTags,
    });
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();
  });
});

/** The suffix an error inside the unknown tag `<name>` carries. */
const inside = (name: string) =>
  ` (inside the unknown tag \`<${name}>\`; may resolve once it is declared)`;
const VAR =
  "`/var` on `<open>` is not supported: it has no template, so it has no `<return>` to bind";
const UNKNOWN = (name: string) =>
  `\`<${name}>\` is not a known tag: it has no contract in \`customTags\``;

describe("an error inside an unknown tag is labelled, never dropped (decision 161)", () => {
  const open: Record<string, CustomTag> = { open: {} };
  const list = (source: string, options: LowerSourceOptions = {}) =>
    lowerSource(source, "/t.mx", {
      unknownTags: "reject",
      customTags: open,
      ...options,
    }).diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`);

  it("keeps an independent error at the root unlabelled", () => {
    expect(list("<foo/>\n<open/z/>\n")).toEqual([
      `1:0 ${UNKNOWN("foo")}`,
      `2:0 ${VAR}`,
    ]);
  });

  it("keeps a `/var` inside an unknown tag, labelled", () => {
    expect(list("<foo>\n  <open/z/>\n</foo>\n<bar/>\n")).toEqual([
      `1:0 ${UNKNOWN("foo")}`,
      `2:2 ${VAR}${inside("foo")}`,
      `4:0 ${UNKNOWN("bar")}`,
    ]);
  });

  it("keeps a `<!doctype>` inside an unknown tag, labelled", () => {
    expect(list("<foo>\n  <!doctype html>\n</foo>\n<bar/>\n")).toEqual([
      `1:0 ${UNKNOWN("foo")}`,
      expect.stringMatching(
        /^2:2 .*<!doctype>.*\(inside the unknown tag `<foo>`; may resolve once it is declared\)$/,
      ),
      `4:0 ${UNKNOWN("bar")}`,
    ]);
  });

  it("keeps a structural `<if>` inside an unknown tag, labelled", () => {
    expect(
      list("<foo>\n  <if=x>t</if>\n</foo>\n<bar/>\n", {
        structural: "reject",
      }),
    ).toEqual([
      `1:0 ${UNKNOWN("foo")}`,
      `2:2 the data tree is static; this file's consumer does not evaluate \`<if>\`${inside("foo")}`,
      `4:0 ${UNKNOWN("bar")}`,
    ]);
  });

  it("keeps an unknown attribute on a declared tag inside an unknown tag, labelled", () => {
    expect(
      list("<foo>\n  <open bogus=1/>\n</foo>\n", {
        customTags: { open: { attributes: { label: { type: "string" } } } },
      }),
    ).toEqual([
      `1:0 ${UNKNOWN("foo")}`,
      `2:8 \`<open>\`: unknown attribute \`bogus\`${inside("foo")}`,
    ]);
  });

  it("names the innermost unknown tag", () => {
    expect(list("<foo>\n  <bar>\n    <baz/>\n  </bar>\n</foo>\n")).toEqual([
      `1:0 ${UNKNOWN("foo")}`,
      `2:2 ${UNKNOWN("bar")}${inside("foo")}`,
      `3:4 ${UNKNOWN("baz")}${inside("bar")}`,
    ]);
  });

  it("reappears unlabelled once the tag is declared", () => {
    expect(
      list("<foo>\n  <open/z/>\n</foo>\n", {
        customTags: { ...open, foo: {} },
      }),
    ).toEqual([`2:2 ${VAR}`]);
  });

  it("does not label an error outside the element", () => {
    expect(list("<foo/>\n<open/z/>\n")[1]).not.toContain("inside the unknown");
  });
});

describe("only an identical error is deduplicated", () => {
  it("keeps two different errors at one position, in discovery order", () => {
    const { diagnostics } = lowerSource("<$bad/>", "/t.mx", {
      unknownTags: "reject",
      customTags,
    });
    expect(diagnostics.map((d) => [d.line, d.column])).toEqual([
      [1, 0],
      [1, 0],
    ]);
    expect(diagnostics[0]?.message).toContain("not a tag name");
    expect(diagnostics[1]?.message).toContain("is not a known tag");
  });

  it("reports an identical error once", () => {
    const { diagnostics } = lowerSource("<foo/>", "/t.mx", {
      unknownTags: "reject",
      customTags,
    });
    expect(diagnostics).toHaveLength(1);
  });
});

describe("checkIr lists the errors lowerSource reports", () => {
  const rules = tagRulesPreset("none", WEB_ELEMENTS);
  const declarations = entryDeclarations(rules.nativeTags);
  const targets = createTargetLookup([
    {
      descriptorVersion: 0,
      name: "ir",
      packageName: "@mxlang/core",
      defaultTag: DEFAULT_TAG,
      declarations: { default: declarations },
    },
  ]);
  const SOURCE = "<$bad/>\n<foo/>\n";
  const lowered = (source: string): Ir => {
    let captured: Ir | undefined;
    compileSource(source, "/t.mx", declarations, {
      targets,
      taglibs: taglibsOfRules(rules),
      statementTags: false,
      emitIr: (lowered) => {
        captured = lowered;
        return "";
      },
    });
    if (!captured) throw new Error("no IR captured");
    return captured;
  };
  const options = {
    structural: "pass",
    unknownTags: "reject",
    declaredTags: new Set<string>(),
  } as const;

  it("lists first the error lowerSource lists first", () => {
    const first = lowerSource(SOURCE, "/t.mx", {
      unknownTags: "reject",
      customTags: {},
    }).diagnostics[0];
    const errors = checkIr(lowered(SOURCE), SOURCE, options);
    expect((errors[0] as Error).message).toBe(first?.message);
  });

  it("keeps the problems already collected when a throw escapes every recovery point", () => {
    // An import with no span records one problem; a `body` that throws then
    // escapes `attempt`. Both must be returned, none lost behind the throw.
    const source = 'import x from "./x"\n<a/>\n';
    const ir = lowered(source);
    const imported = ir.imports[0];
    if (!imported) throw new Error("no import");
    (imported as { span: unknown }).span = undefined;
    Object.defineProperty(ir, "body", {
      get() {
        throw new Error("injected");
      },
    });
    const errors = checkIr(ir, source, {
      structural: "pass",
      unknownTags: "allow",
      declaredTags: new Set(),
    });
    expect(errors.map((error) => (error as Error).message)).toEqual([
      expect.stringContaining("`import` statement carries no span"),
      "injected",
    ]);
  });
});
