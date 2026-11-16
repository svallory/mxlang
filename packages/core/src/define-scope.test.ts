// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
/**
 * A `<define>` is in scope only inside the body that declares it, as in Marko
 * 6.4.4 (the lead's stock probe, 2026-10-13): a `<define/Foo>` inside an
 * `<if>`, a `<for>`, an element or a component body binds `Foo` there and
 * nowhere after it. Before this, the name stayed in `ctx.defines` for the rest
 * of the file, so a later `<Foo/>` outside the block called the define even
 * when `Foo` was an import (the define was never in scope there), and with no
 * import it compiled instead of reporting an unresolved tag.
 */
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { newCtx } from "./core.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import type { IrNode } from "./ir.ts";
import { lower } from "./lower.ts";
import { stripAngleAssertions, stripMxTypes } from "./mx-parse.ts";
import { tagTable } from "./tag-table.ts";
import { lookup as targets } from "./test-targets.ts";

const bare = () => ({ taglibs: [], tagDiscoveryDirs: [], translate: {} });

/** What a host's `isComponent` answers: a name the file binds. */
const policy = (): Policy => ({
  tags: {},
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name) || ctx.imports.has(name),
  resolveDefaultTag: () => "input",
  isBuiltinTag: (name) => name === "let",
  isDelegatedTag: (name) => name === "let",
  resolveDelegatedTag: () => ({}),
});

function lowerSource(
  source: string,
  strip?: typeof stripMxTypes | typeof stripAngleAssertions,
  host: Partial<Policy> = {},
) {
  const { ast, body } = parseFragment(source, { filename: "/f/t.mx" });
  strip?.(ast);
  const ctx = newCtx(
    source,
    printExpression,
    { ...policy(), ...host },
    tagTable(bare(), undefined),
    "/f/t.mx",
    targets,
  );
  return lower(ctx, body);
}

interface Call {
  /** `define` when the call reaches a `<define>`, else the target's own kind. */
  kind: string;
  params?: string[];
}

/** Every component call in source order, whatever it is nested in. */
function callsOf(nodes: readonly IrNode[], out: Call[] = []): Call[] {
  for (const node of nodes) {
    if (node.kind === "Component") {
      const target = node.target as { kind: string; params?: string[] };
      out.push({
        kind: target.kind,
        ...(target.params ? { params: target.params } : {}),
      });
    }
    walk(node, out);
  }
  return out;
}

function walk(node: unknown, out: Call[]): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const key of [
    "children",
    "branches",
    "content",
    "else",
    "attributeTags",
    "block",
  ]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && "kind" in item) {
          callsOf([item as IrNode], out);
        } else {
          walk(item, out);
        }
      }
    } else if (value && typeof value === "object") {
      walk(value, out);
    }
  }
}

const IMPORT = 'import Foo from "./foo.js"\n';
const FOO = "<define/Foo><p>inner</p></define>";

/** The one call `source` makes after the block, in source order. */
function lastCall(source: string, host: Partial<Policy> = {}): Call {
  const calls = callsOf(lowerSource(source, undefined, host).body);
  const last = calls.at(-1);
  if (!last) throw new Error("no component call lowered");
  return last;
}

describe("a <define> is scoped to the body that declares it", () => {
  describe("an import of the same name is called after the block", () => {
    const BLOCKS: Array<[string, string]> = [
      ["<if>", `<if=input.a>${FOO}</if>`],
      ["<else>", `<if=input.a><p>a</p></if><else>${FOO}</else>`],
      ["<else if>", `<if=input.a><p>a</p></if><else if=input.b>${FOO}</else>`],
      ["<for>", `<for|i| of=[1]>${FOO}</for>`],
      ["a native element", `<div>${FOO}</div>`],
      ["a nested native element", `<section><div>${FOO}</div></section>`],
      ["another <define>", `<define/Bar>${FOO}</define>`],
    ];
    for (const [label, block] of BLOCKS) {
      it(`${label}: the outer <Foo/> is the import, not the define`, () => {
        const call = lastCall(`${IMPORT}${block}\n<Foo/>\n`);
        // A value import of a `.js` module is a dynamic tag, never a define.
        expect(call.kind).toBe("dynamic");
      });
    }

    it("an attribute tag body", () => {
      const call = lastCall(
        `${IMPORT}<define/Box><div/></define>\n<Box><@head>${FOO}</@head></Box>\n<Foo/>\n`,
      );
      expect(call.kind).toBe("dynamic");
    });

    it("a component body", () => {
      const call = lastCall(
        `${IMPORT}<define/Box><div><${"$"}{input.content}/></div></define>\n<Box>${FOO}</Box>\n<Foo/>\n`,
      );
      expect(call.kind).toBe("dynamic");
    });

    it("a <Foo/> inside a later sibling block is the import too", () => {
      const calls = callsOf(
        lowerSource(
          `${IMPORT}<if=input.a>${FOO}</if>\n<if=input.b><Foo/></if>\n`,
        ).body,
      );
      expect(calls.map((c) => c.kind)).toEqual(["dynamic"]);
    });
  });

  describe("inside the block the define still wins over the import", () => {
    it("a call inside the <if> reaches the define; the one after reaches the import", () => {
      const calls = callsOf(
        lowerSource(`${IMPORT}<if=input.a>${FOO}<Foo/></if>\n<Foo/>\n`).body,
      );
      expect(calls.map((c) => c.kind)).toEqual(["define", "dynamic"]);
    });

    it("a call inside a nested block of the declaring one still reaches the define", () => {
      const calls = callsOf(
        lowerSource(
          `${IMPORT}<if=input.a>${FOO}<div><for|i| of=[1]><Foo/></for></div></if>\n<Foo/>\n`,
        ).body,
      );
      expect(calls.map((c) => c.kind)).toEqual(["define", "dynamic"]);
    });

    it("a call before the block is the import", () => {
      const calls = callsOf(
        lowerSource(`${IMPORT}<Foo/>\n<if=input.a>${FOO}</if>\n`).body,
      );
      expect(calls.map((c) => c.kind)).toEqual(["dynamic"]);
    });
  });

  describe("with no import the outer <Foo/> is an unresolved tag", () => {
    const BLOCKS: Array<[string, string]> = [
      ["<if>", `<if=input.a>${FOO}</if>`],
      ["<else>", `<if=input.a><p>a</p></if><else>${FOO}</else>`],
      ["<for>", `<for|i| of=[1]>${FOO}</for>`],
      ["a native element", `<div>${FOO}</div>`],
      ["another <define>", `<define/Bar>${FOO}</define>`],
    ];
    for (const [label, block] of BLOCKS) {
      it(`${label}: <Foo/> after it is reported, at the call`, () => {
        const source = `${block}\n<Foo/>\n`;
        let error: { message: string; line: number } | undefined;
        try {
          lowerSource(source);
        } catch (e) {
          error = e as { message: string; line: number };
        }
        expect(error?.message).toMatch(
          /`<Foo>` has no matching import or `<define>` in scope/,
        );
        expect(error?.line).toBe(2);
      });
    }

    it("the same block with the call inside it compiles", () => {
      expect(() =>
        lowerSource(`<if=input.a>${FOO}<Foo/></if>\n`),
      ).not.toThrow();
    });
  });

  describe("a define of the same name at the top level survives a nested one", () => {
    it("the call after the block reaches the outer define, not the inner one", () => {
      const calls = callsOf(
        lowerSource(
          "<define/Foo|a|><p>${a}</p></define>\n<if=input.x><define/Foo|b, c|><p>${b}</p></define><Foo/></if>\n<Foo/>\n",
        ).body,
      );
      expect(calls).toEqual([
        { kind: "define", params: ["b", "c"] },
        { kind: "define", params: ["a"] },
      ]);
    });

    it("two sibling blocks each bind their own, neither leaks into the other", () => {
      expect(() =>
        lowerSource(`<if=input.a>${FOO}<Foo/></if>\n<if=input.b><Foo/></if>\n`),
      ).toThrow(/`<Foo>` has no matching import or `<define>` in scope/);
    });

    it("a top-level define is visible in every later block", () => {
      const calls = callsOf(
        lowerSource(
          `${FOO}\n<if=input.a><Foo/></if>\n<div><Foo/></div>\n<Foo/>\n`,
        ).body,
      );
      expect(calls.map((c) => c.kind)).toEqual(["define", "define", "define"]);
    });
  });
});

/** The first error `lowerSource` raises for `source`, or `undefined`. */
function refusal(source: string) {
  try {
    lowerSource(source);
  } catch (e) {
    return e as { message: string; line: number; column: number } & {
      diagnosticCode?: string;
    };
  }
  return undefined;
}

describe("a <define> name is not readable outside the body that declares it", () => {
  const IF_BLOCK = `<if=input.a>${FOO}</if>`;
  const CASES: Array<[string, string, string]> = [
    ["a placeholder after an <if>", IF_BLOCK, "<div>${typeof Foo}</div>"],
    ["a script after an <if>", IF_BLOCK, "<script>console.log(Foo)</script>"],
    ["an attribute after an <if>", IF_BLOCK, "<div attr=Foo/>"],
    [
      "a placeholder after a native element",
      `<div>${FOO}</div>`,
      "<div>${typeof Foo}</div>",
    ],
  ];
  for (const [label, declared, use] of CASES) {
    it(`${label} is refused at the read`, () => {
      const error = refusal(`${declared}\n${use}\n`);
      expect(error?.diagnosticCode).toBe("MX_DEFINE_READ_BEFORE_DECLARATION");
      expect(error?.message).toMatch(/not readable outside it/);
      expect(error?.line).toBe(2);
    });
  }

  it("a read inside the declaring body, below the define, still compiles", () => {
    expect(() =>
      lowerSource(`<if=input.a>${FOO}<div>\${typeof Foo}</div></if>\n`),
    ).not.toThrow();
  });

  it("an import of the same name is the one a read after the body reaches", () => {
    expect(() =>
      lowerSource(
        `${IMPORT}<if=input.a>${FOO}</if>\n<div>\${typeof Foo}</div>\n`,
      ),
    ).not.toThrow();
  });

  it("a <const> of the same name declared after the body is the one it reaches", () => {
    expect(() =>
      lowerSource(
        `<if=input.a>${FOO}</if>\n<const/Foo=1/>\n<div>\${typeof Foo}</div>\n`,
      ),
    ).not.toThrow();
  });

  it("a second body that declares it again reads its own", () => {
    expect(() =>
      lowerSource(
        `<if=input.a>${FOO}</if>\n<if=input.b>${FOO}<div>\${typeof Foo}</div></if>\n`,
      ),
    ).not.toThrow();
  });
});

describe("a <define> in a nested body is not readable before the walk reaches it", () => {
  const CASES: Array<[string, string, number]> = [
    [
      "a script above a define in an element body",
      `<script>console.log(Foo)</script><div>${FOO}</div>`,
      1,
    ],
    [
      "an <if> branch above a define in its <else>",
      `<if=true>\${typeof Foo}</if><else>${FOO}</else>`,
      1,
    ],
    [
      "a placeholder above a define two bodies down",
      `<p>\${typeof Foo}</p><div><if=input.a>${FOO}</if></div>`,
      1,
    ],
    [
      "a read in a <define> body above a define in a later element",
      `<define/Box>\${typeof Foo}</define><div>${FOO}</div>`,
      1,
    ],
  ];
  for (const [label, source, line] of CASES) {
    it(`${label} is refused at the read`, () => {
      const error = refusal(source);
      expect(error?.diagnosticCode).toBe("MX_DEFINE_READ_BEFORE_DECLARATION");
      expect(error?.message).toMatch(
        /inside a nested body and is not readable here/,
      );
      expect(error?.line).toBe(line);
    });
  }

  it("a read after the body that declares it is the exited-body refusal", () => {
    expect(
      refusal(`<div>${FOO}</div>\n<p>\${typeof Foo}</p>\n`)?.message,
    ).toMatch(/not readable outside it/);
  });

  it.each([
    [
      "a <let> in an <if> body",
      `<if=input.a><let/Foo=1/>\${Foo}</if><div>${FOO}</div>`,
    ],
    [
      "a <let> in an element body",
      `<div><let/Foo=1/>\${Foo}</div><section>${FOO}</section>`,
    ],
    [
      "a <let> in the body above the nested define",
      `<let/Foo=1/>\${Foo}<div>${FOO}</div>`,
    ],
  ])(
    "%s of the same name is the binding its read reaches",
    (_label, source) => {
      expect(() => lowerSource(`${source}\n`)).not.toThrow();
    },
  );

  it("an import of the same name is the one an earlier read reaches", () => {
    expect(() =>
      lowerSource(`${IMPORT}<p>\${typeof Foo}</p><div>${FOO}</div>\n`),
    ).not.toThrow();
  });

  it("a read below the define in its own body still compiles", () => {
    expect(() =>
      lowerSource(`<div>${FOO}<p>\${typeof Foo}</p></div>\n`),
    ).not.toThrow();
  });

  it("an outer define of the same name keeps the reads above the nested one", () => {
    expect(() =>
      lowerSource(`${FOO}<p>\${typeof Foo}</p><if=input.a>${FOO}</if>\n`),
    ).not.toThrow();
  });
});

describe("a <define>'s type parameters", () => {
  // mx-szxv: the strip walks cleared the tag's `<T>` while the params kept
  // their annotations, so the emitted head read an undefined `T`.
  const REPRO = "<define/Foo<T>|{ v }: { v: T }|><p>${v}</p></define>\n";
  const BOUNDED =
    '<define/Foo<T extends string = "a">|{ v }: { v: T }|><p>${v}</p></define>\n';
  const defineOf = (nodes: readonly IrNode[]) =>
    nodes.find((n) => n.kind === "Define") as Extract<
      IrNode,
      { kind: "Define" }
    >;

  it.each([
    ["the build strip", stripMxTypes],
    ["the type-check strip", stripAngleAssertions],
  ])("reach the IR through %s, with their authored span", (_, strip) => {
    const define = defineOf(lowerSource(REPRO, strip).body);
    expect(define.typeParams).toEqual({
      code: "T",
      span: { sourceStart: 12, sourceEnd: 13 },
    });
    expect(define.params).toEqual(["{ v }: { v: T }"]);
  });

  it("keep a constraint and a default as written", () => {
    const define = defineOf(lowerSource(BOUNDED, stripMxTypes).body);
    expect(define.typeParams).toEqual({
      code: 'T extends string = "a"',
      span: { sourceStart: 12, sourceEnd: 34 },
    });
  });

  it("are absent when none were written", () => {
    const define = defineOf(
      lowerSource("<define/Foo|{ v }|><p>${v}</p></define>\n", stripMxTypes)
        .body,
    );
    expect(define).not.toHaveProperty("typeParams");
  });
});

describe("a local binding of a <define>'s name makes the tag a dynamic call", () => {
  // mx-nh8x: stock Marko 6.4.4 reads a PascalCase tag name with a binding in
  // scope as an identifier tag, and Babel's innermost binding is the local, so
  // `<T/>` under `<for|T|>` is `_dynamic_tag(…, T, …)` over the loop value.
  const T = "<define/T|{n}|><b>${n}</b></define>";
  const SHADOWED: Array<[string, string]> = [
    ["a <for> loop variable", "<for|T| of=[1]><T n=1/></for>"],
    ["a <for> second param", "<for|i, T| of=[1]><T n=1/></for>"],
    ["a destructured <for> param", "<for|{T}| of=[{T:1}]><T n=1/></for>"],
    ["a <define> param", "<define/U|{T}|><T n=2/></define>"],
    [
      "a call's content param",
      "<define/W|{content}|><${content}(1)/></define><W|T|><T n=1/></W>",
    ],
    [
      "an attribute tag param",
      "<define/W|{item}|><${item.content}(1)/></define><W><@item|T|><T n=1/></@item></W>",
    ],
    ["a <const> in a <for> body", "<for|i| of=[1]><const/T=i/><T n=3/></for>"],
  ];
  for (const [label, source] of SHADOWED) {
    it(`${label}: <T> calls the local, not the define`, () => {
      expect(lastCall(`${T}${source}`).kind).toBe("dynamic");
    });
  }

  it("a call after the shadowing body still reaches the define", () => {
    expect(lastCall(`${T}<for|T| of=[1]></for><T n=1/>`)).toEqual({
      kind: "define",
      params: ["{n}"],
    });
  });

  it("a define's own param of its name is the param", () => {
    expect(lastCall("<define/T|{T}|><T n=2/></define>").kind).toBe("dynamic");
  });

  it("an inner define in the shadowing body is the innermost binding", () => {
    expect(
      lastCall(
        "<for|T| of=[1]><if=true><define/T|{n}|><b/></define><T n=1/></if></for>",
      ),
    ).toEqual({ kind: "define", params: ["{n}"] });
  });

  // A host that binds a dynamic tag's `/var` (the JSX hosts do); without it
  // core refuses `/var` on any dynamic tag, as on html.
  it("/var on a shadowed call is not a define call", () => {
    expect(
      lastCall(
        "<define/T|{n}|><return=n/></define><define/W|{content}|><${content}(1)/></define><W|T|><T/x n=1/>${x}</W>",
        { bindsDynamicTagVar: true },
      ).kind,
    ).toBe("dynamic");
  });
});

describe("a tag call's /var of a <define>'s name makes the tag a dynamic call", () => {
  // mx-bk8r: stock Marko 6.4.4 reads `<T/>` through Babel's innermost binding,
  // and a tag call's `/T` is one, so `<Make/T/><T n=1/>` is
  // `_dynamic_tag(…, T, …)` over the call's value, not the outer define.
  const D =
    "<define/T|{n}|><b>${n}</b></define><define/U|{n}|><i>${n}</i></define><define/Make><return=U/></define>";
  const HIDDEN: Array<[string, string]> = [
    ["a <define> body", "<define/W><Make/T/><T n=1/></define>"],
    ["a <for> body", "<for|i| of=[1]><Make/T/><T n=1/></for>"],
    ["an <if> body", "<if=true><Make/T/><T n=1/></if>"],
    ["an element body", "<div><Make/T/><T n=1/></div>"],
    [
      "a body nested under the /T",
      "<define/W><Make/T/><div><T n=1/></div></define>",
    ],
  ];
  for (const [label, source] of HIDDEN) {
    it(`${label}: <T> calls the /T, not the define`, () => {
      expect(lastCall(`${D}${source}`).kind).toBe("dynamic");
    });
  }

  it("a call after the hiding body still reaches the define", () => {
    expect(lastCall(`${D}<define/W><Make/T/></define><T n=1/>`)).toEqual({
      kind: "define",
      params: ["{n}"],
    });
  });

  it("an inner define under the /T is the innermost binding", () => {
    expect(
      lastCall(
        `${D}<define/W><Make/T/><if=true><define/T|{n}|><b/></define><T n=1/></if></define>`,
      ),
    ).toEqual({ kind: "define", params: ["{n}"] });
  });

  it("a <const> keeps its route", () => {
    expect(
      lastCall(`${D}<for|i| of=[1]><const/T=(() => 1)/><T n=3/></for>`).kind,
    ).toBe("name");
  });

  it("/var on the hidden call is not a define call", () => {
    expect(
      lastCall(`${D}<define/W><Make/T/><T/x n=1/>\${x}</define>`, {
        bindsDynamicTagVar: true,
      }).kind,
    ).toBe("dynamic");
  });

  it("an authored <${T}/x/> under the /T is not refused as a define /var", () => {
    expect(() =>
      lowerSource(
        `${D}<define/W><Make/T/><\${T}/x n=1/>\${x}</define>`,
        undefined,
        { bindsDynamicTagVar: true },
      ),
    ).not.toThrow();
  });

  // mx-vgbp: the same holds with no `<define/T>` at all. Stock 6.4.4 emits
  // `let T = Make.content({})` and `_dynamic_tag(…, T, …)` for each of these.
  const NO_T =
    "<define/U|{n}|><i>${n}</i></define><define/Make><return=U/></define>";
  const REACHED: Array<[string, string]> = [
    ["the same body", "<Make/T/><T n=1/>"],
    ["a body nested under the /T", "<Make/T/><div><T n=1/></div>"],
    [
      "a nested body below its own /T",
      "<Make/T/><if=true><Make/T/><T n=1/></if>",
    ],
  ];
  for (const [label, source] of REACHED) {
    it(`with no <define/T>, ${label}: <T> calls the /T`, () => {
      expect(lastCall(`${NO_T}${source}`).kind).toBe("dynamic");
    });
  }

  it("with no <define/T>, a <T> the /T is not in scope for is unbound", () => {
    expect(() =>
      lowerSource(`${NO_T}<define/W><Make/T/></define><T n=1/>`),
    ).toThrow(/`<T>` has no matching import or `<define>` in scope/);
  });

  // Not reached yet: the tag keeps today's unknown-tag error rather than
  // reading the value in its temporal dead zone (stock hoists it instead;
  // that design question is mx-edza's).
  // A `<define>` body is lowered where the define is written, so a body above
  // the `/T` is not reached either, even when the define is called after it.
  it.each([
    ["a <T> above its /T", "<T n=1/><Make/T/>"],
    [
      "a define body above the /T, called after it",
      "<define/W><T n=1/></define><Make/T/><W/>",
    ],
    // An outer /T is reached, but the body declares its own /T below the
    // <T>, and the emitted <T> reads that body's `let T`.
    [
      "a define body's <T> above its own /T",
      "<Make/T/><define/W><T n=1/><Make/T/></define><W/>",
    ],
    [
      "an <if> body's <T> above its own /T",
      "<Make/T/><if=true><T n=1/><Make/T/></if>",
    ],
    [
      "an <if> in a body whose own /T is below it",
      "<Make/T/><if=true><if=true><T n=1/></if><Make/T/></if>",
    ],
    // A /T in a sibling block is reached but not in scope here.
    [
      "a <T> after a sibling block's /T, above its own",
      "<if=true><Make/T/></if><T n=1/><Make/T/>",
    ],
    // Any binding of T in the body, not only a call's /T, makes the outer
    // reached /T not this body's: the <T> would read the body's own T.
    [
      "a body's <T> above its own <let/T>",
      "<Make/T/><if=true><T n=1/><let/T=U/></if>",
    ],
    [
      "a body's <T> above its own <const/T>",
      "<Make/T/><if=true><T n=1/><const/T=U/></if>",
    ],
    [
      "a body's <T> above its own element ref /T",
      "<Make/T/><if=true><T n=1/><div/T/></if>",
    ],
    [
      "a body's <T> above its own <id/T>",
      "<Make/T/><if=true><T n=1/><id/T/></if>",
    ],
    // A nested <define/V> unhides V in its body; T's innermost rebinding
    // body (the <if>) must survive that copy of the hidden set.
    [
      "a <T> beside a define that unhides another name, above its body's /T",
      "<Make/V/><Make/T/><if=true><span><define/V><b/></define><T n=1/></span><Make/T/></if>",
    ],
  ])("with no <define/T>, %s is unbound", (_what, source) => {
    expect(() => lowerSource(`${NO_T}${source}`)).toThrow(
      /`<T>` has no matching import or `<define>` in scope/,
    );
  });

  // An import call's /T is registered pending before the walk, so it is not
  // reached at a <T> above it either.
  it("with no <define/T>, a <T> above an import call's /T is unbound", () => {
    expect(() =>
      lowerSource('import Lib from "./lib.js"\n<T n=1/><Lib/T/>'),
    ).toThrow(/`<T>` has no matching import or `<define>` in scope/);
  });
});
