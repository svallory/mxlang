import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ATTR = "__mxAttrValue";
/** A dynamic native attribute is the guard inside the primitive normalization. */
const OUT = (guarded: string, name: string): string =>
  `__mxAttrOut(${JSON.stringify(name)}, ${guarded})`;
const SPREAD = "__mxAttrSpread";

import { describe, expect, it } from "vitest";
import { AstroTemplateError, lowerAstroMx } from "./astro-template.ts";

const require = createRequire(import.meta.url);
const astroRequire = createRequire(
  realpathSync(require.resolve("astro/package.json")),
);
const compilerEntry = astroRequire.resolve("@astrojs/compiler-rs");

async function astroDiagnostics(source: string): Promise<unknown[]> {
  const compiler = (await import(pathToFileURL(compilerEntry).href)) as {
    transform(
      source: string,
      options: { filename: string },
    ): Promise<{ diagnostics?: unknown[] }>;
  };
  const result = await compiler.transform(source, { filename: "Test.astro" });
  return result.diagnostics ?? [];
}

const FIXTURE_FENCE =
  '---\nimport Card from "./Card.astro";\nconst x = 1;\n---\n';

/** Lowers a template with a fixture fence, returning just the template half. */
function lower(template: string): string {
  const source = `${FIXTURE_FENCE}${template}`;
  return lowerAstroMx(source, "Test.astro.mx").code.replace(
    /^---[\s\S]*?\n---\n/,
    "",
  );
}

/** The error a template raises, for the error-path tests. */
function errorFor(template: string): AstroTemplateError {
  try {
    lower(template);
  } catch (error) {
    if (error instanceof AstroTemplateError) return error;
    throw error;
  }
  throw new Error("expected the template to fail lowering");
}

describe("lowerAstroMx", () => {
  it("copies the fence through byte for byte", () => {
    const source = `---\nimport Card from "./Card.astro";\nconst n = 1;\n---\n<p>hi</p>`;
    const { code } = lowerAstroMx(source, "Test.astro.mx");

    expect(
      code.startsWith(
        '---\nimport Card from "./Card.astro";\nconst n = 1;\n---\n',
      ),
    ).toBe(true);
  });

  it("lowers a file with no fence at all", () => {
    const { code } = lowerAstroMx("<p>hi</p>", "Test.astro.mx");
    expect(code).toBe("<p>hi</p>");
  });

  it("hoists a template static into the Astro fence", () => {
    const source = `---\nconst x = 1;\n---\nstatic const y = 2;\n<p>${"${x + y}"}</p>`;
    expect(lowerAstroMx(source, "Test.astro.mx").code).toBe(
      `---\nconst x = 1;\nconst y = 2;\n---\n<p>{x + y}</p>`,
    );
  });

  it("keeps comments and multiple roots", () => {
    expect(lower("<!--first--><p>a</p><p>b</p>")).toBe(
      "<!--first--><p>a</p><p>b</p>",
    );
  });

  it("lowers registered custom tags before Astro emission", () => {
    const result = lowerAstroMx("<icon/>", "Test.astro.mx", {
      customTags: {
        icon: {
          transform: (_call, ctx) => [ctx.build.element("svg")],
        },
      },
    });

    expect(result.code).toBe("<svg></svg>");
  });
});

describe("source mappings", () => {
  it("maps the unchanged frontmatter fence as one identity span", () => {
    const source = `---\nconst title = "Hello";\n---\n<h1>${"${title}"}</h1>`;
    const result = lowerAstroMx(source, "Test.astro.mx");
    const fenceEnd = source.indexOf("<h1>");

    expect(result.mappings[0]).toEqual({
      sourceStart: 0,
      sourceEnd: fenceEnd,
      generatedStart: 0,
      generatedEnd: fenceEnd,
    });
  });

  it.each([
    ["interpolation", "<p>before ${value} after</p>", "value"],
    ["attribute value", "<p title=value>x</p>", "value"],
    ["if condition", "<if=visible><p>x</p></if>", "visible"],
    ["for iterable", "<for|item| of=items><p>${item}</p></for>", "items"],
    ["for tag param", "<for|item| of=items><p>x</p></for>", "item"],
  ])(
    "maps an emitted %s at its write offset",
    (_kind, template, expression) => {
      const result = lowerAstroMx(template, "Test.astro.mx");
      const sourceStart = template.indexOf(expression);
      const candidates = result.mappings.filter(
        (candidate) => candidate.sourceStart === sourceStart,
      );

      expect(candidates.length).toBeGreaterThan(0);
      for (const mapping of candidates) {
        expect(template.slice(mapping.sourceStart, mapping.sourceEnd)).toBe(
          expression,
        );
      }
      // One of them is the expression itself, at its write offset.
      expect(
        candidates.some(
          (mapping) =>
            result.code.slice(mapping.generatedStart, mapping.generatedEnd) ===
            expression,
        ),
      ).toBe(true);
    },
  );

  it("maps the spread operand of a for iterable onto the authored value", () => {
    // TypeScript reports a non-iterable value (TS2488) on this operand.
    const template = "<for|item| of=items><p>${item}</p></for>";
    const result = lowerAstroMx(template, "Test.astro.mx");
    const at = template.indexOf("items");
    const operand = result.mappings.find(
      (mapping) =>
        mapping.sourceStart === at &&
        result.code.slice(mapping.generatedStart, mapping.generatedEnd) ===
          "mxList" &&
        result.code.slice(
          mapping.generatedStart - 3,
          mapping.generatedStart,
        ) === "...",
    );

    expect(operand).toBeDefined();
  });

  it("maps a hoisted statement as a whole source block", () => {
    const source = "static const answer: number = 42;\n<p>${answer}</p>";
    const result = lowerAstroMx(source, "Test.astro.mx");
    const generatedStatement = "const answer: number = 42;";
    const mapping = result.mappings.find(
      (candidate) =>
        result.code.slice(candidate.generatedStart, candidate.generatedEnd) ===
        generatedStatement,
    );

    expect(mapping).toBeDefined();
    expect(source.slice(mapping?.sourceStart, mapping?.sourceEnd)).toBe(
      "static const answer: number = 42;",
    );
  });

  it("maps an attribute name where TypeScript anchors prop diagnostics", () => {
    const source = `${FIXTURE_FENCE}<Card title=1/>`;
    const result = lowerAstroMx(source, "Test.astro.mx");
    const sourceStart = source.indexOf("title");
    const mapping = result.mappings.find(
      (candidate) => candidate.sourceStart === sourceStart,
    );

    expect(mapping).toBeDefined();
    expect(
      result.code.slice(mapping?.generatedStart, mapping?.generatedEnd),
    ).toBe("title");
  });
});

describe("placeholders", () => {
  it("lowers `${expr}` to an Astro expression", () => {
    expect(lower("<h1>${title}</h1>")).toBe("<h1>{title}</h1>");
  });

  it("lowers `$!{expr}` to set:html, since Astro escapes by default", () => {
    expect(lower("<div>$!{input.content}</div>")).toBe(
      "<div><Fragment set:html={input.content} /></div>",
    );
  });

  it("escapes literal braces in text, which would otherwise open an expression", () => {
    expect(lower("<p>a {b} c</p>")).toBe("<p>a &#123;b&#125; c</p>");
  });
});

describe("<if>", () => {
  it("lowers to a ternary with a null arm when there is no else", () => {
    expect(lower("<if=on><p>yes</p></if>")).toBe(
      "{on ? (<Fragment><p>yes</p></Fragment>) : null}",
    );
  });

  it("lowers an else branch", () => {
    expect(lower("<if=on><p>y</p></if><else><p>n</p></else>")).toBe(
      "{on ? (<Fragment><p>y</p></Fragment>) : (<Fragment><p>n</p></Fragment>)}",
    );
  });

  it("chains else-if", () => {
    const out = lower(
      "<if=a><p>1</p></if><else if=b><p>2</p></else><else><p>3</p></else>",
    );
    expect(out).toBe(
      "{a ? (<Fragment><p>1</p></Fragment>) : b ? (<Fragment><p>2</p></Fragment>) : (<Fragment><p>3</p></Fragment>)}",
    );
  });

  it("rejects a condition-less <if>", () => {
    expect(errorFor("<if><p>x</p></if>").message).toMatch(
      /`<if>` without a condition/,
    );
  });

  it("rejects a stray <else>", () => {
    expect(errorFor("<else><p>x</p></else>").message).toMatch(
      /must follow an `<if>`/,
    );
  });
});

describe("<for>", () => {
  it("lowers `of=` to .map()", () => {
    expect(lower("<for|item| of=items><li>${item}</li></for>")).toBe(
      "{((mxList) => mxList ? [...mxList] : [])(items).map((item) => (<Fragment><li>{item}</li></Fragment>))}",
    );
  });

  it("passes the index as the second param", () => {
    expect(lower("<for|item, i| of=items><li>${i}</li></for>")).toBe(
      "{((mxList) => mxList ? [...mxList] : [])(items).map((item, i) => (<Fragment><li>{i}</li></Fragment>))}",
    );
  });

  it("lowers `in=` through Object.entries", () => {
    expect(lower("<for|k, v| in=obj><li>${k}</li></for>")).toBe(
      "{Object.entries(obj ?? {}).map(([k, v]) => (<Fragment><li>{k}</li></Fragment>))}",
    );
  });

  it("lowers the inclusive `to=` range to valid, balanced JavaScript", () => {
    const code = lower("<for|n| from=1 to=3><li>${n}</li></for>");
    expect(code).toBe(
      "{Array.from({ length: Math.max(0, (3) - (1) + 1) }, (__mxUnused, __mxIndex) => (1) + __mxIndex).map((n) => (<Fragment><li>{n}</li></Fragment>))}",
    );
  });

  it("lowers the exclusive `until=` range to valid, balanced JavaScript", () => {
    const code = lower("<for|n| from=1 until=3><li>${n}</li></for>");
    expect(code).toBe(
      "{Array.from({ length: Math.max(0, (3) - (1)) }, (__mxUnused, __mxIndex) => (1) + __mxIndex).map((n) => (<Fragment><li>{n}</li></Fragment>))}",
    );
  });

  it("lowers a range with no `from=` (defaults to 0)", () => {
    const code = lower("<for|n| to=3><li>${n}</li></for>");
    expect(code).toBe(
      "{Array.from({ length: Math.max(0, (3) - (0) + 1) }, (__mxUnused, __mxIndex) => (0) + __mxIndex).map((n) => (<Fragment><li>{n}</li></Fragment>))}",
    );
  });

  it("lowers a descending (from > to) range without throwing invalid JS", () => {
    const code = lower("<for|n| from=5 to=1><li>${n}</li></for>");
    expect(code).toBe(
      "{Array.from({ length: Math.max(0, (1) - (5) + 1) }, (__mxUnused, __mxIndex) => (5) + __mxIndex).map((n) => (<Fragment><li>{n}</li></Fragment>))}",
    );
  });

  it("lowers expression bounds", () => {
    const code = lower("<for|n| from=start() to=count - 1><li>${n}</li></for>");
    expect(code).toBe(
      "{Array.from({ length: Math.max(0, (count - 1) - (start()) + 1) }, (__mxUnused, __mxIndex) => (start()) + __mxIndex).map((n) => (<Fragment><li>{n}</li></Fragment>))}",
    );
  });

  it.each([
    ["from/to", "<for|n| from=1 to=3><li>${n}</li></for>"],
    ["from/until", "<for|n| from=1 until=3><li>${n}</li></for>"],
    ["no from", "<for|n| to=3><li>${n}</li></for>"],
    ["descending", "<for|n| from=5 to=1><li>${n}</li></for>"],
    [
      "expression bounds",
      "<for|n| from=start() to=count - 1><li>${n}</li></for>",
    ],
  ])(
    "emits JavaScript the real Astro compiler accepts (%s)",
    async (_name, template) => {
      const source = `---\nconst x = 1;\n---\n${template}`;
      const { code } = lowerAstroMx(source, "Test.astro.mx");
      const diagnostics = await astroDiagnostics(code);
      expect(diagnostics).toEqual([]);
    },
  );

  it("rejects `step=`, as the core does", () => {
    expect(
      errorFor("<for|n| from=1 to=9 step=2><li>${n}</li></for>").message,
    ).toMatch(/step is not supported/);
  });

  it("rejects a <for> with no params", () => {
    expect(errorFor("<for of=items><li>x</li></for>").message).toMatch(
      /needs tag params/,
    );
  });

  it("rejects a <for> with no iterable", () => {
    expect(errorFor("<for|n|><li>x</li></for>").message).toMatch(
      /requires `of=`, `in=`, or/,
    );
  });
});

describe("attributes", () => {
  it("passes a static attribute through", () => {
    expect(lower('<p class="card">x</p>')).toBe('<p class="card">x</p>');
  });

  it("wraps a dynamic attribute in braces", () => {
    expect(lower("<p title=name>x</p>")).toBe(
      `<p title={${OUT(`${ATTR}("title", (name), "p")`, "title")}}>x</p>`,
    );
  });

  it("emits a bare attribute as HTML's spelling of true", () => {
    expect(lower("<input disabled>")).toBe("<input disabled />");
  });

  it("lowers a spread", () => {
    expect(lower("<p ...rest>x</p>")).toBe(
      `<p {...${SPREAD}(rest, "p")}>x</p>`,
    );
  });

  it("lowers a structured class to Astro's class:list", () => {
    expect(lower("<p class={on: true}>x</p>")).toBe(
      "<p class:list={{on: true}}>x</p>",
    );
  });

  it("lowers an array class to class:list", () => {
    expect(lower('<p class=["a", {b: true}]>x</p>')).toBe(
      '<p class:list={["a", {b: true}]}>x</p>',
    );
  });

  it("hoists value ahead of type on an input, as Marko does", () => {
    expect(lower('<input type="text" value=v>')).toBe(
      `<input value={${OUT(`${ATTR}("value", (v), "input")`, "value")}} type="text" />`,
    );
  });

  it("leaves a bare or string-valued `onClick` alone", () => {
    // Phase A of `dom-events`: core derives the `event` kind only for an
    // expression value, so neither form reaches the event path and both emit
    // exactly as they did before the kind existed.
    expect(lower("<div onClick>x</div>")).toBe("<div onClick>x</div>");
    expect(lower('<div onClick="alert(1)">x</div>')).toBe(
      '<div onClick="alert(1)">x</div>',
    );
  });

  it("rejects an event-handler attribute method", () => {
    expect(errorFor("<button onClick() { go() }>x</button>").message).toMatch(
      /event handler and requires a runtime/,
    );
  });
});

describe("unresolved components (decision 114 parity)", () => {
  it.each([
    ["self-closing", "<TotallyUndefined/>"],
    ["with a body", "<TotallyUndefined>body</TotallyUndefined>"],
    ["with an attribute", "<TotallyUndefined a=1/>"],
  ])(
    "rejects a capitalized tag with no fence import, binding, or taglib entry, %s",
    (_label, template) => {
      expect(errorFor(template).message).toContain(
        "Unable to find entry point for custom tag `<TotallyUndefined>`.",
      );
    },
  );

  it("a type-only fence import does not resolve a capitalized tag (#151)", () => {
    const source = `---\nimport type Widget from "./widget.mx";\n---\n<Widget/>`;
    try {
      lowerAstroMx(source, "Test.astro.mx");
      throw new Error("expected the template to fail lowering");
    } catch (error) {
      if (!(error instanceof AstroTemplateError)) throw error;
      expect(error.message).toContain(
        "Unable to find entry point for custom tag `<Widget>`.",
      );
    }
  });

  it("resolves an authored <Fragment> with no fence import (Astro's own built-in)", async () => {
    // Measured against @astrojs/compiler-rs (astro@7.3.2): the compiler
    // auto-imports `Fragment` from "astro/runtime/server/index.js" for any
    // <Fragment> reference, whether or not the author imported it -- the
    // only capitalized name it does this for. This is a real MX-level
    // component call, distinct from the emitter's own internal
    // `<Fragment set:html=...>` for `$!{expr}` (a text-emission detail,
    // never a lowered Component -- see `interpolation` in this file).
    const { code } = lowerAstroMx(
      "---\n---\n<Fragment><p>x</p></Fragment>",
      "Test.astro.mx",
    );
    expect(code).toBe("<Fragment><p>x</p></Fragment>");
    expect(await astroDiagnostics(code)).toEqual([]);
  });

  it("resolves a fence import beside Astro.props destructuring and export interface Props", () => {
    // A real .astro.mx component's fence shape (see examples/astro-static's
    // Panel.astro.mx/Roster.astro.mx): `sourceBindings` must not choke on
    // `export interface Props` (a type, correctly not collected -- only
    // VariableDeclaration/FunctionDeclaration/ClassDeclaration are) or a
    // destructured `const { ... } = Astro.props as Props` (an
    // ObjectPattern, collected by `collectPatternNames`), and `Card`'s own
    // import must still resolve alongside them.
    const source = [
      "---",
      'import Card from "./Card.astro";',
      "export interface Props {",
      "  title: string;",
      "}",
      "const { title } = Astro.props as Props;",
      "---",
      "<Card title=title/>",
    ].join("\n");
    const { code } = lowerAstroMx(source, "Test.astro.mx");
    expect(code).toContain("<Card title={title} />");
  });

  it("a type-only fence import beside a value one does not resolve its own tag (#151)", () => {
    const source = [
      "---",
      'import Card from "./Card.astro";',
      'import type Widget from "./widget.mx";',
      "---",
      "<Card><Widget/></Card>",
    ].join("\n");
    try {
      lowerAstroMx(source, "Test.astro.mx");
      throw new Error("expected the template to fail lowering");
    } catch (error) {
      if (!(error instanceof AstroTemplateError)) throw error;
      expect(error.message).toContain(
        "Unable to find entry point for custom tag `<Widget>`.",
      );
    }
  });

  it("surfaces the fence's own syntax error, not a misleading unresolved-tag error (source-bindings-silent-parse-failure)", () => {
    // Before the fix, a fence sourceBindings could not parse silently
    // treated the fence as binding nothing, so Card -- genuinely imported
    // one line above the broken statement -- misreported as
    // "Unable to find entry point for custom tag `<Card>`." instead of the
    // real problem.
    const source = [
      "---",
      'import Card from "./Card.astro";',
      "const x = ;",
      "---",
      "<Card/>",
    ].join("\n");
    try {
      lowerAstroMx(source, "Test.astro.mx");
      throw new Error("expected the template to fail lowering");
    } catch (error) {
      if (!(error instanceof AstroTemplateError)) throw error;
      expect(error.message).not.toContain("Unable to find entry point");
      expect(error.message).toContain("syntax error in the `---` fence");
      // Line 3 of the file: line 1 is `---`, line 2 the import, line 3 the
      // broken `const x = ;`.
      expect(error.line).toBe(3);
      // The message text carries the position too, and it must be the FILE's,
      // 1-based line and column (#227) -- never Babel's fence-relative
      // `(2:…)`, which points an author at their own `---`.
      expect(error.message).toContain("(3:");
      expect(error.message).not.toContain("(2:");
    }
  });

  it("prints the file position for a fence syntax error on fence line 3", () => {
    // Before, Babel's own fence-relative `(2:9)` was appended to the message
    // text, so the reported position pointed at the opening `---` instead of
    // the author's line 3 (`const y = ;`). The structured line was already
    // file-relative; the text now matches it.
    const source = [
      "---",
      'import Card from "./Card.astro";',
      "const y = ;",
      "---",
      "<Card/>",
    ].join("\n");
    try {
      lowerAstroMx(source, "Test.astro.mx");
      throw new Error("expected the template to fail lowering");
    } catch (error) {
      if (!(error instanceof AstroTemplateError)) throw error;
      expect(error.line).toBe(3);
      // Text position is 1-based line AND column (#227): `;` is the 11th
      // character of line 3 (`const y = ;`).
      expect(error.message).toContain("(3:11)");
      // Must NOT carry Babel's fence-relative line 2.
      expect(error.message).not.toContain("(2:");
    }
  });

  it("prints (4:…) for a break on the fence's third content line", () => {
    // The fence's own content lines are file lines 2, 3, 4, so a break on
    // fence content line 3 is file line 4 — the case the earlier test (whose
    // break sat on file line 3) did not actually cover.
    const source = [
      "---",
      'import Card from "./Card.astro";',
      "const x = 1;",
      "const y = ;",
      "---",
      "<Card/>",
    ].join("\n");
    try {
      lowerAstroMx(source, "Test.astro.mx");
      throw new Error("expected the template to fail lowering");
    } catch (error) {
      if (!(error instanceof AstroTemplateError)) throw error;
      expect(error.line).toBe(4);
      expect(error.message).toContain("(4:");
      // Babel would have stamped the fence-relative line 3.
      expect(error.message).not.toContain("(3:");
    }
  });
});

describe("components and slots", () => {
  it("self-closes a childless component", () => {
    expect(lower("<Card title=t/>")).toBe("<Card title={t} />");
  });

  it("passes children through as the default slot", () => {
    expect(lower("<Card><p>x</p></Card>")).toBe("<Card><p>x</p></Card>");
  });

  it("lowers an attribute tag to an Astro named slot", () => {
    expect(lower("<Card><@header><h2>t</h2></@header></Card>")).toBe(
      '<Card><Fragment slot="header"><h2>t</h2></Fragment></Card>',
    );
  });

  it("lowers mutually exclusive conditional tags to a conditional named slot", () => {
    expect(
      lower(
        "<Card><if=primary><@header>A</@header></if><else if=secondary><@header>B</@header></else><else><@header>C</@header></else></Card>",
      ),
    ).toBe(
      '<Card>{(primary ? (<Fragment slot="header">A</Fragment>) : secondary ? (<Fragment slot="header">B</Fragment>) : (<Fragment slot="header">C</Fragment>))}</Card>',
    );
  });

  it.each([
    ["a nested if", "<Card><if=a><if=b><@header>A</@header></if></if></Card>"],
    [
      "an if inside else",
      "<Card><if=a><@header>A</@header></if><else><if=b><@header>B</@header></if></else></Card>",
    ],
    [
      "an empty else",
      "<Card><if=a><@header>A</@header></if><else></else></Card>",
    ],
    [
      "an empty else-if",
      "<Card><if=a><@header>A</@header></if><else if=b></else></Card>",
    ],
  ])(
    "emits Astro syntax accepted by the compiler for %s",
    async (_name, template) => {
      const code = lowerAstroMx(
        `---\nimport Card from "./Card.astro";\nconst a = true;\nconst b = false;\n---\n${template}`,
        "Test.astro.mx",
      ).code;
      expect(await astroDiagnostics(code)).toEqual([]);
    },
  );

  it("rejects an attribute tag on an HTML element, which has no slots", () => {
    expect(errorFor("<div><@header>x</@header></div>").message).toMatch(
      /only a component accepts/,
    );
  });

  // attribute-tag-silent-drops round 2: a repeated `<@item>` used to compile
  // clean to two `<Fragment slot="item">` siblings, which Astro's own
  // slot-by-name renderer would silently collapse to one — measured, a real
  // drop, not merely undocumented.
  it("rejects a repeated attribute tag, since an Astro slot is keyed by name", () => {
    const error = errorFor(
      "<Card>\n  <@item>a</@item>\n  <@item>b</@item>\n</Card>",
    );
    expect(error.message).toBe(
      "array attribute tag `<@item>` isn't supported by @mxlang/astro: a slot is keyed by name",
    );
    expect(error.line).toBe(7);
  });

  it("rejects tag params, which Astro has no render-prop form for", () => {
    const error = errorFor("<Card>\n<@header|item|>${item}</@header>\n</Card>");
    expect(error.message).toContain("params on `<@header>` aren't supported");
    expect(error.message).toContain("@mxlang/astro");
    expect(error.line).toBe(6);
  });

  it("rejects attributes on an attribute tag with a positioned host error", () => {
    const error = errorFor('<Card>\n<@header tone="loud">H</@header>\n</Card>');
    expect(error.message).toContain(
      "attributes on `<@header>` aren't supported by @mxlang/astro",
    );
    expect(error.line).toBe(6);
  });

  it("rejects nested attribute tags with a positioned host error", () => {
    const error = errorFor(
      "<Card>\n<@header><@icon>I</@icon></@header>\n</Card>",
    );
    expect(error.message).toContain(
      "nested attribute tags inside `<@header>` aren't supported by @mxlang/astro",
    );
    expect(error.line).toBe(6);
  });

  it("rejects an attribute tag inside <for> as an array slot", () => {
    const error = errorFor(
      "<Card>\n<for|item| of=items>\n<@row>${item}</@row>\n</for>\n</Card>",
    );
    expect(error.message).toContain("@mxlang/astro");
    expect(error.line).toBe(7);
  });

  it("rejects a bodiless attribute tag", () => {
    const error = errorFor("<Card>\n<@header/>\n</Card>");
    expect(error.message).toBe(
      "<@header/> has no body; @mxlang/astro projects attribute-tag bodies by name",
    );
    expect(error.line).toBe(6);
  });

  it("rejects a declared AttrTag[] even when no occurrence is passed", () => {
    // TODO `test-tmpdir-leak`: the temp project is removed here, not left in
    // the OS temp directory.
    const dir = mkdtempSync(join(tmpdir(), "mx-astro-attr-tags-"));
    try {
      const card = join(dir, "Card.mx");
      const caller = join(dir, "Caller.astro.mx");
      writeFileSync(
        card,
        "export interface Input { item?: AttrTag[] }\n<section/>\n",
      );
      const source = 'import Card from "./Card.mx";\n<Card/>\n';

      expect(() => lowerAstroMx(source, caller)).toThrow(
        "array attribute tag `<@item>` isn't supported by @mxlang/astro",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AttrTag type import", () => {
  it("auto-imports the Astro-specialized type into the frontmatter fence", () => {
    const result = lowerAstroMx(
      "export interface Input { header?: AttrTag }\n<p>x</p>",
      "Test.astro.mx",
    );

    expect(result.code).toContain(
      'import type { AttrTag } from "@mxlang/astro";',
    );
  });
});

describe("unsupported constructs", () => {
  it.each([
    ["let", "<let/count=1/>", /reactive state and requires a runtime/],
    ["effect", "<effect() { go() }/>", /reactive effect/],
    ["lifecycle", "<lifecycle onMount=f/>", /reactive lifecycle hook/],
    ["id", "<id/x/>", /allocates an identifier/],
    ["await", "<await=p><p>x</p></await>", /suspense-capable renderer/],
  ])("rejects <%s>", (_name, template, pattern) => {
    expect(errorFor(template).message).toMatch(pattern);
  });

  it("rejects <const>, which a template expression cannot declare", () => {
    expect(errorFor("<const/n=1/>").message).toMatch(
      /declare it in the `---` fence instead/,
    );
  });

  it("rejects <define>, pointing at a separate file", () => {
    expect(errorFor("<define/Row><p>x</p></define>").message).toMatch(
      /extract it into its own `\.astro.mx` file/,
    );
  });

  it("rejects <try>, which Astro has no error boundary for", () => {
    expect(errorFor("<try><p>x</p></try>").message).toMatch(
      /needs an error boundary/,
    );
  });

  it("rejects a dynamic tag name", () => {
    const message = errorFor("<${Tag}><p>x</p></${Tag}>").message;
    expect(message).toContain("isn't supported by @mxlang/astro");
    expect(message).toContain("resolves component names statically");
  });

  it("rejects a bare `${expr}` concise-position line the same way, not as a silent interpolation", () => {
    // A bare line and the tagged form parse to the same dynamic-tag shape
    // (see AGENTS.md's "four Marko facts"); Astro cannot express either, so
    // both are the same error rather than the bare shape silently rendering
    // as an interpolation of the tag-name expression.
    const message = errorFor("${Tag}\n").message;
    expect(message).toContain("isn't supported by @mxlang/astro");
    expect(message).toContain("resolves component names statically");
  });
});

describe("error positions", () => {
  it("reports the line in the enclosing file, past the fence", () => {
    // The fence is three lines, so the `<let>` on the template's first line is
    // line 4 of the file. That shift is `parseFragment`'s base-offset work,
    // which is the whole reason this host uses that front door.
    const source = `---\nconst x = 1;\n---\n<let/count=1/>`;
    try {
      lowerAstroMx(source, "Test.astro.mx");
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AstroTemplateError);
      expect((error as AstroTemplateError).line).toBe(4);
    }
  });
});

/**
 * The fence relaxation that admits a top-level `return` is scoped to the
 * `---` fence — the one region the host compiles inside a function body. An
 * MX template expression is emitted into the rendered output as authored, so
 * a `return` written there is still the syntax error it always was.
 */
describe("the fence's top-level return does not leak into the template", () => {
  it("still rejects a bare return in a placeholder", () => {
    expect(() =>
      lowerAstroMx(
        ["---", "const x = 1;", "---", "<p>${return x}</p>"].join("\n"),
        "Test.astro.mx",
      ),
    ).toThrow();
  });

  it("still rejects a bare return in an attribute expression", () => {
    expect(() =>
      lowerAstroMx(
        ["---", "const x = 1;", "---", "<p a={return x}/>"].join("\n"),
        "Test.astro.mx",
      ),
    ).toThrow();
  });

  it("still accepts a function-bodied return in a placeholder", () => {
    // Not over-rejected: the fence option must not make every `return` in
    // the file a syntax error.
    expect(
      lowerAstroMx(
        ["---", "const x = 1;", "---", "<p>${(() => x)()}</p>"].join("\n"),
        "Test.astro.mx",
      ).code,
    ).toContain("<p>");
  });
});

/**
 * Calling a returning tag from `.astro.mx` (round 1, finding 5).
 *
 * The `<return>` error disposition used to live in this host's table, which
 * refused a `.astro.mx` file that merely *called* a returning `.mx` tag — the
 * table is consulted while compiling whichever file holds the tag. The call
 * is legal: the unit is a separate module, and Astro's renderer calls its
 * default export, which returns the markup alone (`server.ts`; the value is
 * what `render(input, out)` returns, decision 155). Only `/var` is refused: it is a
 * structural host limit (ruled 2026-09-28, decision-65-style host-cannot),
 * since Astro runs the `---` fence to completion before the template's tags
 * are ever called, leaving no statement position, in either the fence or the
 * template, to bind a value into. The message explains why and points at the
 * one route that does work — calling the unit directly from the fence.
 */
describe("a tag that returns a value", () => {
  const counter = {
    template: {
      filename: "/fixtures/tags/counter.mx",
      source: [
        "export interface Input { start: number }",
        "<span>${input.start}</span>",
        "<return value=input.start + 1/>",
      ].join("\n"),
    },
  } as never;

  it("can be called from .astro.mx without /var", () => {
    const { code } = lowerAstroMx(
      "---\n---\n<div><counter start=1/></div>\n",
      "/fixtures/page.astro.mx",
      { customTags: { counter } },
    );

    expect(code).toContain("start={1}");
    expect(code).toContain('import Mx_Counter1 from "./tags/counter.mx"');
    expect(code).toContain("<Mx_Counter1 start={1} />");
  });

  it("rejects the .astro.mx file's own <return>", () => {
    // Removing the stale error disposition (round 1, finding 5) let the core
    // parse `<return>` here, and this emitter never reads `ir.returnValue` —
    // so the tag compiled clean with the value silently gone, which is worse
    // than the rejection it replaced.
    expect(() =>
      lowerAstroMx(
        "---\n---\n<div>x</div>\n<return value=41 + 1/>\n",
        "Test.astro.mx",
      ),
    ).toThrow(/`<return>` hands a value to whoever called this unit/);
  });

  it("rejects /var on it, naming the tag as written", () => {
    expect(() =>
      lowerAstroMx(
        "---\n---\n<div><counter/n start=1/></div>\n",
        "/fixtures/page.astro.mx",
        { customTags: { counter } },
      ),
    ).toThrow(/`\/var` on `<counter>` can't bind in `\.astro.mx`/);
  });

  it("explains why /var can't bind (fence-before-template ordering) and shows the fence-call workaround", () => {
    // Ruling 2026-09-28 (TODO amx-tag-var): this is a structural host limit
    // (decision-65-style host-cannot), not a missing feature, so the message
    // says why rather than reading like a TODO — and points at the one route
    // that already works: calling the unit directly from the `---` fence's
    // own TypeScript, where it is an ordinary function call.
    expect(() =>
      lowerAstroMx(
        "---\n---\n<div><counter/n start=1/></div>\n",
        "/fixtures/page.astro.mx",
        { customTags: { counter } },
      ),
    ).toThrow(
      // The route it names must be one that works since decision 155: the
      // default export returns markup only, so the value comes from `render`.
      /Astro runs the `---` fence before the template renders.*Call the unit directly from the fence instead.*import \{ createOut \} from "@mxlang\/astro\/runtime"; const value = Mx_Counter\d*\.render\(\{ \.\.\. \}, createOut\(\)\)/s,
    );
  });
});

describe("event attributes (decision 101, phase B of dom-events)", () => {
  it("rejects an expression-valued event handler: .astro.mx has no runtime", () => {
    expect(errorFor("<button onClick=handler>x</button>").message).toBe(
      "`onClick` is an event handler and requires a runtime; .astro.mx renders static markup at build time",
    );
  });

  it("rejects a custom event name the same way", () => {
    expect(errorFor("<div on-my-event=fn>x</div>").message).toBe(
      "`on-my-event` is an event handler and requires a runtime; .astro.mx renders static markup at build time",
    );
  });

  it("passes a static inline handler string through verbatim", () => {
    // Spec §4: a string-valued `onClick` stays an ordinary static attribute;
    // MX does not invent a policy against inline handler strings.
    expect(
      lowerAstroMx('<button onClick="alert(1)">x</button>', "T.astro.mx").code,
    ).toBe('<button onClick="alert(1)">x</button>');
  });

  it("rejects on: with a fix-it naming on-<exact>", () => {
    expect(errorFor("<div on:click=fn>x</div>").message).toContain(
      "write `onClick=fn` for a DOM event or `on-click=fn` for a custom event name",
    );
  });
});

describe("event error positions", () => {
  it("positions the event error at the attribute name", () => {
    // The helper lowers under a four-line fence, so the template's
    // first line is source line 5; the column is still the name's.
    const error = errorFor("<div   onClick=fn>x</div>");
    expect(error).toMatchObject({ line: 5, column: 7 });
  });
});

describe("<html-comment> (Marko 6.3.51 parity)", () => {
  it("lowers a static comment to a real comment, escaping only `>`", () => {
    expect(lower("<html-comment>a > b &amp; c</html-comment>")).toBe(
      "<!--a &gt; b &amp; c-->",
    );
    expect(lower("<html-comment></html-comment>")).toBe("<!---->");
  });

  it("lowers a placeholder to one set:html string through the comment helper", () => {
    expect(lower("<html-comment>a ${x} b</html-comment>")).toBe(
      '<Fragment set:html={"<!--" + "a " + __mxCommentValue(x, true) + " b" + "-->"} />',
    );
    expect(lower("<html-comment>$!{x}</html-comment>")).toBe(
      '<Fragment set:html={"<!--" + (__mxCommentValue(x, false) || " ") + "-->"} />',
    );
  });

  it("declares the helper only when a placeholder uses it", () => {
    const helper = "const __mxCommentValue =";
    expect(
      lowerAstroMx(
        "---\n---\n<html-comment>${x}</html-comment>",
        "Test.astro.mx",
      ).code,
    ).toContain(helper);
    expect(
      lowerAstroMx("---\n---\n<html-comment>x</html-comment>", "Test.astro.mx")
        .code,
    ).not.toContain(helper);
  });

  it("refuses a /var and tag arguments, as the html target does", () => {
    expect(() => lower("<html-comment/v>x</html-comment>")).toThrow(
      "tag variable",
    );
    expect(() => lower("<html-comment(1)>x</html-comment>")).toThrow(
      "tag arguments",
    );
  });
});

describe("<textarea value> (Marko 6.3.51 parity)", () => {
  it("lifts a static value into escaped content", () => {
    expect(lower('<textarea value="a<b" class="c"/>')).toBe(
      '<textarea class="c">a&lt;b</textarea>',
    );
  });

  it("lifts a dynamic value into content through the helper, keeping other attributes", () => {
    expect(lower('<textarea value=x class="c"/>')).toBe(
      '<textarea class="c">{__mxTextareaContent(x)}</textarea>',
    );
  });

  it("splits a spread's value out at render time", () => {
    expect(lower("<textarea ...x value=y/>")).toBe(
      `{(($mxTa: Record<string, any>) => (<textarea {...${SPREAD}((({ value: __mxValue, ...$mxRest }) => $mxRest)($mxTa), "textarea")}>{__mxTextareaContent($mxTa.value)}</textarea>))({ ...x, "value": (y) })}`,
    );
  });

  it("keeps a body when a spread is present", () => {
    expect(lower("<textarea ...x>b</textarea>")).toContain(
      '"textarea")}>b</textarea>))({ ...x })}',
    );
  });

  it("escapes a body's `<` as raw text", () => {
    expect(lower("<textarea>a &amp; <b></textarea>")).toBe(
      "<textarea>a &amp; &lt;b></textarea>",
    );
  });

  it("refuses a value together with a body", () => {
    expect(errorFor("<textarea value=x>b</textarea>").message).toContain(
      "A textarea cannot have both a value attribute and body content.",
    );
  });

  it("refuses a directive-named attribute next to a spread, as on every element", () => {
    for (const template of [
      '<textarea ...x set:html="<b>x</b>"/>',
      '<textarea set:html="<b>x</b>"/>',
      '<div ...x set:html="<b>x</b>"/>',
    ]) {
      expect(errorFor(template).message, template).toContain(
        "attribute `set:html` cannot be preserved as a plain Marko attribute",
      );
    }
  });

  it("leaves a plain textarea alone", () => {
    expect(lower("<textarea>hi</textarea>")).toBe("<textarea>hi</textarea>");
  });
});
