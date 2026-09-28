import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  return lowerAstroMx(source, "Test.amx").code.replace(FIXTURE_FENCE, "");
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
    const { code } = lowerAstroMx(source, "Test.amx");

    expect(
      code.startsWith(
        '---\nimport Card from "./Card.astro";\nconst n = 1;\n---\n',
      ),
    ).toBe(true);
  });

  it("lowers a file with no fence at all", () => {
    const { code } = lowerAstroMx("<p>hi</p>", "Test.amx");
    expect(code).toBe("<p>hi</p>");
  });

  it("hoists a template static into the Astro fence", () => {
    const source = `---\nconst x = 1;\n---\nstatic const y = 2;\n<p>${"${x + y}"}</p>`;
    expect(lowerAstroMx(source, "Test.amx").code).toBe(
      `---\nconst x = 1;\nconst y = 2;\n---\n<p>{x + y}</p>`,
    );
  });

  it("keeps comments and multiple roots", () => {
    expect(lower("<!--first--><p>a</p><p>b</p>")).toBe(
      "<!--first--><p>a</p><p>b</p>",
    );
  });

  it("lowers registered custom tags before Astro emission", () => {
    const result = lowerAstroMx("<icon/>", "Test.amx", {
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
    const result = lowerAstroMx(source, "Test.amx");
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
      const result = lowerAstroMx(template, "Test.amx");
      const sourceStart = template.indexOf(expression);
      const mapping = result.mappings.find(
        (candidate) => candidate.sourceStart === sourceStart,
      );

      expect(mapping).toBeDefined();
      expect(template.slice(mapping?.sourceStart, mapping?.sourceEnd)).toBe(
        expression,
      );
      expect(
        result.code.slice(mapping?.generatedStart, mapping?.generatedEnd),
      ).toBe(expression);
    },
  );

  it("maps a hoisted statement as a whole source block", () => {
    const source = "static const answer: number = 42;\n<p>${answer}</p>";
    const result = lowerAstroMx(source, "Test.amx");
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
    const result = lowerAstroMx(source, "Test.amx");
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
      "{Array.from({ length: Math.max(0, (3) - (1) + 1) }, (_, $i) => (1) + $i).map((n) => (<Fragment><li>{n}</li></Fragment>))}",
    );
  });

  it("lowers the exclusive `until=` range to valid, balanced JavaScript", () => {
    const code = lower("<for|n| from=1 until=3><li>${n}</li></for>");
    expect(code).toBe(
      "{Array.from({ length: Math.max(0, (3) - (1)) }, (_, $i) => (1) + $i).map((n) => (<Fragment><li>{n}</li></Fragment>))}",
    );
  });

  it("lowers a range with no `from=` (defaults to 0)", () => {
    const code = lower("<for|n| to=3><li>${n}</li></for>");
    expect(code).toBe(
      "{Array.from({ length: Math.max(0, (3) - (0) + 1) }, (_, $i) => (0) + $i).map((n) => (<Fragment><li>{n}</li></Fragment>))}",
    );
  });

  it("lowers a descending (from > to) range without throwing invalid JS", () => {
    const code = lower("<for|n| from=5 to=1><li>${n}</li></for>");
    expect(code).toBe(
      "{Array.from({ length: Math.max(0, (1) - (5) + 1) }, (_, $i) => (5) + $i).map((n) => (<Fragment><li>{n}</li></Fragment>))}",
    );
  });

  it("lowers expression bounds", () => {
    const code = lower("<for|n| from=start() to=count - 1><li>${n}</li></for>");
    expect(code).toBe(
      "{Array.from({ length: Math.max(0, (count - 1) - (start()) + 1) }, (_, $i) => (start()) + $i).map((n) => (<Fragment><li>{n}</li></Fragment>))}",
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
      const { code } = lowerAstroMx(source, "Test.amx");
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
    expect(lower("<p title=name>x</p>")).toBe("<p title={name}>x</p>");
  });

  it("emits a bare attribute as HTML's spelling of true", () => {
    expect(lower("<input disabled>")).toBe("<input disabled />");
  });

  it("lowers a spread", () => {
    expect(lower("<p ...rest>x</p>")).toBe("<p {...rest}>x</p>");
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
      '<input value={v} type="text" />',
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
      lowerAstroMx(source, "Test.amx");
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
      "Test.amx",
    );
    expect(code).toBe("<Fragment><p>x</p></Fragment>");
    expect(await astroDiagnostics(code)).toEqual([]);
  });

  it("resolves a fence import beside Astro.props destructuring and export interface Props", () => {
    // A real .amx component's fence shape (see examples/astro-static's
    // Panel.amx/Roster.amx): `sourceBindings` must not choke on
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
    const { code } = lowerAstroMx(source, "Test.amx");
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
      lowerAstroMx(source, "Test.amx");
      throw new Error("expected the template to fail lowering");
    } catch (error) {
      if (!(error instanceof AstroTemplateError)) throw error;
      expect(error.message).toContain(
        "Unable to find entry point for custom tag `<Widget>`.",
      );
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
        "Test.amx",
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
    const dir = mkdtempSync(join(tmpdir(), "mx-astro-attr-tags-"));
    const card = join(dir, "Card.mx");
    const caller = join(dir, "Caller.amx");
    writeFileSync(
      card,
      "export interface Input { item?: AttrTag[] }\n<section/>\n",
    );
    const source = 'import Card from "./Card.mx";\n<Card/>\n';

    expect(() => lowerAstroMx(source, caller)).toThrow(
      "array attribute tag `<@item>` isn't supported by @mxlang/astro",
    );
  });
});

describe("AttrTag type import", () => {
  it("auto-imports the Astro-specialized type into the frontmatter fence", () => {
    const result = lowerAstroMx(
      "export interface Input { header?: AttrTag }\n<p>x</p>",
      "Test.amx",
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
      /extract it into its own `\.amx` file/,
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
      lowerAstroMx(source, "Test.amx");
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AstroTemplateError);
      expect((error as AstroTemplateError).line).toBe(4);
    }
  });
});

/**
 * Calling a returning tag from `.amx` (round 1, finding 5).
 *
 * The `<return>` error disposition used to live in this host's table, which
 * refused a `.amx` file that merely *called* a returning `.mx` tag — the
 * table is consulted while compiling whichever file holds the tag. The call
 * is legal: the unit is a separate module, and Astro's renderer unwraps the
 * `{ value, output }` pair (`server.ts`). Only `/var` is refused, because an
 * `.amx` template has no statement position to bind a value in.
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

  it("can be called from .amx without /var", () => {
    const { code } = lowerAstroMx(
      "---\n---\n<div><counter start=1/></div>\n",
      "/fixtures/page.amx",
      { customTags: { counter } },
    );

    expect(code).toContain("start={1}");
    expect(code).toContain('import $mx_Counter1 from "./tags/counter.mx"');
  });

  it("rejects the .amx file's own <return>", () => {
    // Removing the stale error disposition (round 1, finding 5) let the core
    // parse `<return>` here, and this emitter never reads `ir.returnValue` —
    // so the tag compiled clean with the value silently gone, which is worse
    // than the rejection it replaced.
    expect(() =>
      lowerAstroMx(
        "---\n---\n<div>x</div>\n<return value=41 + 1/>\n",
        "Test.amx",
      ),
    ).toThrow(/`<return>` hands a value to whoever called this unit/);
  });

  it("rejects /var on it, naming the tag as written", () => {
    expect(() =>
      lowerAstroMx(
        "---\n---\n<div><counter/n start=1/></div>\n",
        "/fixtures/page.amx",
        { customTags: { counter } },
      ),
    ).toThrow(/`\/var` on `<counter>` is not supported in `\.amx` yet/);
  });
});

describe("event attributes (decision 101, phase B of dom-events)", () => {
  it("rejects an expression-valued event handler: .amx has no runtime", () => {
    expect(errorFor("<button onClick=handler>x</button>").message).toBe(
      "`onClick` is an event handler and requires a runtime; .amx renders static markup at build time",
    );
  });

  it("rejects a custom event name the same way", () => {
    expect(errorFor("<div on-my-event=fn>x</div>").message).toBe(
      "`on-my-event` is an event handler and requires a runtime; .amx renders static markup at build time",
    );
  });

  it("passes a static inline handler string through verbatim", () => {
    // Spec §4: a string-valued `onClick` stays an ordinary static attribute;
    // MX does not invent a policy against inline handler strings.
    expect(
      lowerAstroMx('<button onClick="alert(1)">x</button>', "T.amx").code,
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
