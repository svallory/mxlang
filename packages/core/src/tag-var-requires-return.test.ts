// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * `/var` binds what the called unit returns with `<return>`; a unit that
 * declares none leaves the binding `undefined` forever. Marko 6.4 refuses the
 * call at compile time, at the tag variable, and so does MX: on a discovered
 * tag, on an imported `.mx` unit, and on a contract-only tag in the `ir-entry` data path.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { Policy } from "./declarations.ts";
import { lowerSource as lowerData } from "./ir-entry/index.ts";
import type { TemplateBackedTag } from "./template-tag.ts";
import { lookup } from "./test-targets.ts";

const dir = mkdtempSync(join(tmpdir(), "mx-tag-var-return-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PAGE = join(dir, "page.mx");
writeFileSync(join(dir, "plain.mx"), "<b>x</b>\n");
writeFileSync(join(dir, "returns.mx"), "<b>x</b>\n<return value=1/>\n");
writeFileSync(join(dir, "empty.mx"), "");

const plainTag: TemplateBackedTag = {
  template: { filename: join(dir, "tags", "plain.mx"), source: "<b>x</b>\n" },
};
const returnsTag: TemplateBackedTag = {
  template: {
    filename: join(dir, "tags", "returns.mx"),
    source: "<b>x</b>\n<return value=1/>\n",
  },
};
const emptyTag: TemplateBackedTag = {
  template: { filename: join(dir, "tags", "empty.mx"), source: "" },
};

const policy: Policy = {
  tags: {},
  // Exercise declaration rules on hosts that implement dynamic return binding.
  bindsDynamicTagVar: true,
  isElement: () => true,
  isComponent: (name) => /^[A-Z]/.test(name) || name === "plain",
};

interface Failure {
  message: string;
  code: string | undefined;
  line: number;
  column: number;
  end: { line: number; column: number } | undefined;
}

function compile(
  source: string,
  customTags: Record<string, TemplateBackedTag> = {},
): Failure | undefined {
  try {
    compileSource(source, PAGE, policy, {
      targets: lookup,
      tagDiscoveryDirs: [],
      customTags,
      emitIr: () => "",
    });
  } catch (caught) {
    const error = caught as {
      message: string;
      diagnosticCode?: string;
      line: number;
      column: number;
      end?: { line: number; column: number };
    };
    return {
      message: error.message,
      code: error.diagnosticCode,
      line: error.line,
      column: error.column,
      end: error.end,
    };
  }
  return undefined;
}

const DISCOVERED = (name: string, file: string) =>
  `\`<${name}>\` does not return a value; add \`<return value=…/>\` to ${file} to bind it with \`/var\``;
const IMPORTED = (name: string) =>
  `\`<${name}>\` does not return a value; add \`<return value=…/>\` to the imported file to bind it with \`/var\``;

describe("returning imports and dynamic calls follow declaration rules", () => {
  it.each([
    "<returns/x a=x/>",
    'import R from "./returns.mx"\n<R/x a=x/>',
    'import R from "./returns.mx"\n<${R}/x a=x/>',
  ])("refuses self-reads in %s", (source) => {
    expect(compile(source, { returns: returnsTag })?.code).toBe(
      "MX_TAG_VAR_SELF_READ",
    );
  });

  it.each([
    "<returns/x a=() => x/>",
    'import R from "./returns.mx"\n<R/x a=() => x/>',
    'import R from "./returns.mx"\n<${R}/x a=() => x/>',
  ])("keeps deferred self-reads in %s", (source) => {
    expect(compile(source, { returns: returnsTag })).toBeUndefined();
  });

  it.each([
    'import R from "./returns.mx"\n<R/x/><R/x/>',
    'import R from "./returns.mx"\n<R/x/><const/x=1/>',
    'import R from "./returns.mx"\n<${R}/x/><${R}/x/>',
    'import R from "./returns.mx"\n<${R}/x/><const/x=1/>',
  ])("refuses repeated declarations in %s", (source) => {
    expect(compile(source)?.code).toBe("MX_DUPLICATE_DECLARATION");
  });
});

describe("/var on a discovered tag whose template declares no <return>", () => {
  it("is MX_INVALID_TAG_VAR, at the tag variable with its end", () => {
    expect(
      compile("<plain/x/>\n<div>${x}</div>\n", { plain: plainTag }),
    ).toEqual({
      message: DISCOVERED("plain", plainTag.template.filename),
      code: "MX_INVALID_TAG_VAR",
      line: 1,
      column: 7,
      end: { line: 1, column: 8 },
    });
  });

  it("points at the variable of a nested, multi-line call, not the tag start", () => {
    expect(
      compile("<div>\n  <plain/n a=1\n    b=2/>\n</div>\n", {
        plain: plainTag,
      }),
    ).toMatchObject({
      code: "MX_INVALID_TAG_VAR",
      line: 2,
      column: 9,
      end: { line: 2, column: 10 },
    });
  });

  it("covers a destructuring pattern whole", () => {
    expect(compile("<plain/{ a, b }/>\n", { plain: plainTag })).toMatchObject({
      code: "MX_INVALID_TAG_VAR",
      line: 1,
      column: 7,
      end: { line: 1, column: 15 },
    });
  });

  it("refuses an unused variable too, and a template with no content at all", () => {
    expect(compile("<plain/x/>\n", { plain: plainTag })?.code).toBe(
      "MX_INVALID_TAG_VAR",
    );
    expect(compile("<empty/x/>\n", { empty: emptyTag })).toMatchObject({
      message: DISCOVERED("empty", emptyTag.template.filename),
      line: 1,
      column: 7,
      end: { line: 1, column: 8 },
    });
  });

  it("refuses a call with a body and attributes the same way", () => {
    expect(
      compile("<plain/x a=1>hi</plain>\n", { plain: plainTag }),
    ).toMatchObject({
      code: "MX_INVALID_TAG_VAR",
      line: 1,
      column: 7,
      end: { line: 1, column: 8 },
    });
  });

  it("compiles the same call when the template declares <return> (control)", () => {
    expect(
      compile("<returns/x/>\n<div>${x}</div>\n", { returns: returnsTag }),
    ).toBeUndefined();
  });

  it("compiles a call with no tag variable (control)", () => {
    expect(compile("<plain/>\n", { plain: plainTag })).toBeUndefined();
  });
});

describe("/var on an imported .mx unit that declares no <return>", () => {
  it("is MX_INVALID_TAG_VAR, at the tag variable with its end", () => {
    expect(
      compile('import P from "./plain.mx"\n<P/x/>\n<div>${x}</div>\n'),
    ).toEqual({
      message: IMPORTED("P"),
      code: "MX_INVALID_TAG_VAR",
      line: 2,
      column: 3,
      end: { line: 2, column: 4 },
    });
  });

  it("covers a destructuring pattern whole", () => {
    expect(compile('import P from "./plain.mx"\n<P/{ a }/>\n')).toMatchObject({
      code: "MX_INVALID_TAG_VAR",
      line: 2,
      column: 3,
      end: { line: 2, column: 8 },
    });
  });

  it("refuses an empty unit", () => {
    expect(compile('import E from "./empty.mx"\n<E/x/>\n')).toMatchObject({
      message: IMPORTED("E"),
      line: 2,
      column: 3,
    });
  });

  it("compiles the same call when the unit declares <return> (control)", () => {
    expect(
      compile('import R from "./returns.mx"\n<R/x/>\n<div>${x}</div>\n'),
    ).toBeUndefined();
  });

  it("compiles a call with no tag variable (control)", () => {
    expect(compile('import P from "./plain.mx"\n<P/>\n')).toBeUndefined();
  });
});

describe("/var on a bare-identifier dynamic tag", () => {
  it("refuses a default import of a unit that declares no <return>, at the variable", () => {
    expect(
      compile('import P from "./plain.mx"\n<${P}/x/>\n<div>${x}</div>\n'),
    ).toEqual({
      message: IMPORTED("P"),
      code: "MX_INVALID_TAG_VAR",
      line: 2,
      column: 6,
      end: { line: 2, column: 7 },
    });
  });

  it("covers a destructuring pattern whole", () => {
    expect(
      compile('import P from "./plain.mx"\n<${P}/{ a }/>\n'),
    ).toMatchObject({
      code: "MX_INVALID_TAG_VAR",
      line: 2,
      column: 6,
      end: { line: 2, column: 11 },
    });
  });

  it("refuses a <define> callee at the variable, as it does a named call", () => {
    const named = compile("<define/Foo><b>x</b></define>\n<Foo/x/>\n");
    const dynamic = compile("<define/Foo><b>x</b></define>\n<${Foo}/x/>\n");
    expect(named).toMatchObject({ line: 2, column: 5 });
    expect(dynamic).toMatchObject({
      line: 2,
      column: 8,
      end: { line: 2, column: 9 },
    });
    expect(dynamic?.code).toBe(named?.code);
  });

  it("compiles a call with no tag variable (control)", () => {
    expect(compile('import P from "./plain.mx"\n<${P}/>\n')).toBeUndefined();
  });
});

describe("the data path (`none` preset) blames the variable too", () => {
  it("refuses a tag variable on a contract-only tag, with its own wording, at the variable", () => {
    const { diagnostics } = lowerData("<panel/v/>\n", "/t.mx", {
      customTags: { panel: {} },
      tagRules: "none",
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "MX_INVALID_TAG_VAR",
      message:
        "`/var` on `<panel>` is not supported: it has no template, so it has no `<return>` to bind",
      line: 1,
      column: 7,
      end: { line: 1, column: 8 },
    });
  });
});
