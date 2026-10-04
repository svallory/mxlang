import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

const dir = mkdtempSync(join(tmpdir(), "mx-astro-conditional-slots-"));
const require = createRequire(import.meta.url);
const astroRequire = createRequire(
  realpathSync(require.resolve("astro/package.json")),
);
const compilerEntry = astroRequire.resolve("@astrojs/compiler-rs");

interface AstroCompiler {
  transform(
    source: string,
    options: { filename: string },
  ): Promise<{ code: string; diagnostics?: unknown[] }>;
}

let compiler: AstroCompiler;
let container: AstroContainer;

/**
 * compiler-rs 0.4 emits build metadata that Astro 7's public runtime does not
 * export yet. Astro's Vite build consumes that metadata separately; the
 * container needs only the component factory, so remove the unrelated export
 * from these directly imported probe modules.
 */
function containerModule(code: string): string {
  return code
    .replace(", createMetadata as $$createMetadata", "")
    .replace(
      /export const \$\$metadata = \$\$createMetadata\([\s\S]*?\n\}\);\n/,
      "",
    );
}

beforeAll(async () => {
  compiler = (await import(pathToFileURL(compilerEntry).href)) as AstroCompiler;
  container = await AstroContainer.create();

  const filename = join(dir, "Card.astro");
  const result = await compiler.transform(
    '<section><slot name="header">fallback</slot></section>',
    { filename },
  );
  expect(result.diagnostics ?? []).toEqual([]);
  writeFileSync(join(dir, "Card.mjs"), containerModule(result.code));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function renderConditional(
  name: string,
  declarations: string,
  template: string,
): Promise<string> {
  const amxFile = join(dir, `${name}.astro.mx`);
  const source = `---
import Card from "./Card.mjs";
${declarations}
---
${template}`;
  const lowered = lowerAstroMx(source, amxFile).code;
  const result = await compiler.transform(lowered, {
    filename: join(dir, `${name}.astro`),
  });
  expect(result.diagnostics ?? []).toEqual([]);

  const moduleFile = join(dir, `${name}.mjs`);
  writeFileSync(moduleFile, containerModule(result.code));
  const component = (
    (await import(
      /* @vite-ignore */ `${pathToFileURL(moduleFile).href}?case=${name}`
    )) as { default: Parameters<AstroContainer["renderToString"]>[0] }
  ).default;
  return container.renderToString(component);
}

async function renderPlain(name: string, template: string): Promise<string> {
  const amxFile = join(dir, `${name}.astro.mx`);
  const lowered = lowerAstroMx(`---\n---\n${template}`, amxFile).code;
  const result = await compiler.transform(lowered, {
    filename: join(dir, `${name}.astro`),
  });
  expect(result.diagnostics ?? []).toEqual([]);

  const moduleFile = join(dir, `${name}.mjs`);
  writeFileSync(moduleFile, containerModule(result.code));
  const component = (
    (await import(
      /* @vite-ignore */ `${pathToFileURL(moduleFile).href}?case=${name}`
    )) as { default: Parameters<AstroContainer["renderToString"]>[0] }
  ).default;
  return container.renderToString(component);
}

describe("<for> with a nullish of=/in=", () => {
  it("renders nothing, matching Marko, rather than throwing", async () => {
    const html = await renderPlain(
      "for-nullish",
      "<for|x| of=undefined><b>${x}</b></for><for|k, v| in=null><b>${k}</b></for>",
    );
    expect(html).not.toContain("<b>");
  });

  it("renders nothing for a falsy (non-nullish) of=, matching Marko", async () => {
    const html = await renderPlain(
      "for-falsy",
      [
        "<for|x| of=0><b>${x}</b></for>",
        "<for|x| of=false><b>${x}</b></for>",
        "<for|x| of=NaN><b>${x}</b></for>",
        '<for|x| of=""><b>${x}</b></for>',
      ].join("\n"),
    );
    expect(html).not.toContain("<b>");
  });
});

/**
 * `<div :foo="y"/>` is Marko's attribute literally named `value:foo` (its
 * parser fills the empty head of `name:modifier` with `value`), which Marko
 * renders as `<div value:foo=y>`. An `.astro.mx` template body is HTML, so
 * Astro's own compiler has to accept the name too — rendered here through the
 * real compiler and the Astro container, not just the lowering.
 */
describe("`:modifier` renders as the attribute `value:modifier` (astro)", () => {
  it("renders Marko's attribute for the static and valueless forms", async () => {
    const html = await renderPlain(
      "value-modifier-plain",
      ['<div :foo="lit"/>', "<div :bar/>"].join("\n"),
    );
    expect(html).toContain(`value:foo="lit"`);
    expect(html).toContain(`value:bar=""`);
  });

  it("renders the empty and multi-colon names without dropping a colon", async () => {
    const html = await renderPlain(
      "value-modifier-colons",
      ["<div :/>", '<div value:foo:bar="y"/>'].join("\n"),
    );
    expect(html).toContain('value:=""');
    expect(html).toContain('value:foo:bar="y"');
  });

  it("renders the interpolated form", async () => {
    const html = await renderConditional(
      "value-modifier-dynamic",
      'const y = "hello";',
      // In `.astro.mx` the braces would be an MX object expression, so the
      // dynamic attribute is written without them.
      "<div :foo=y/>",
    );
    expect(html).toContain(`value:foo="hello"`);
  });
});

describe("Astro directive-shaped names retain plain Marko meaning", () => {
  it.each([
    "set:unknown",
    "set:html:extra",
    "define:vars",
    "define:x:y",
    "is:raw",
    "is:inline",
    "is:global",
    "is:raw:extra",
    "transition:name",
    "transition:animate",
    "transition:persist",
    "transition:persist-props",
    "client:load",
    "client:only",
    "client:load:extra",
    "server:defer",
    "slot",
    "slot:foo",
    "SET:html",
  ])(
    "renders %s as an escaped plain native attribute, not a directive",
    async (name) => {
      const html = await renderConditional(
        `plain-directive-${name.replace(":", "-")}`,
        "const value = '<b>unsafe</b>&\"quote\"';",
        `<div ${name}=value>body</div>`,
      );
      expect(html).toBe(
        `<div ${name}="<b>unsafe</b>&amp;&quot;quote&quot;">body</div>`,
      );
    },
  );

  it("plain escaped names do not acquire Astro's directive-specific JSX types", () => {
    const filename = join(dir, "plain-directive-types.tsx");
    const declarations = 'const value = "text"; const rest = {"data-x": "y"};';
    const astroJsx = join(
      dirname(realpathSync(require.resolve("astro/package.json"))),
      "astro-jsx.d.ts",
    );
    const diagnostics = (template: string) => {
      const lowered = lowerAstroMx(
        `---\n${declarations}\n---\n${template}`,
        "Test.astro.mx",
      ).code;
      const body = lowered.slice(lowered.indexOf("\n---\n") + 5);
      writeFileSync(
        filename,
        `/// <reference path=${JSON.stringify(astroJsx)} />\nnamespace JSX { export type IntrinsicElements = astroHTML.JSX.IntrinsicElements; }\n${declarations}\nconst view = <>${body}</>;\n`,
      );
      return ts
        .getPreEmitDiagnostics(
          ts.createProgram([filename], {
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            jsx: ts.JsxEmit.Preserve,
            skipLibCheck: true,
            noEmit: true,
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            types: [],
          }),
        )
        .map((diagnostic) => ({
          code: diagnostic.code,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        }));
    };
    expect(
      diagnostics("<div is:raw=value/><div is:raw=value ...rest/>"),
    ).toEqual([]);
    // Escaping the name must not hide errors in the authored value expression.
    expect(diagnostics("<div is:raw=missing/>")).toEqual([
      { code: 2304, message: "Cannot find name 'missing'." },
    ]);
  });

  it("preserves static and valueless directive-shaped native names", async () => {
    const html = await renderPlain(
      "static-plain-directives",
      '<div is:raw/><div transition:name="a"/><div client:load/><span slot="header">body</span>',
    );
    expect(html).toBe(
      '<div is:raw></div><div transition:name="a"></div><div client:load></div><span slot="header">body</span>',
    );
  });

  it.each(["define:vars", "is:raw", "transition:name", "client:load", "slot"])(
    "matches Marko's plain value serialization for %s, including true",
    async (name) => {
      const values = [
        ["true", name],
        ["false", ""],
        ["1", `${name}="1"`],
        ["null", ""],
        ["undefined", ""],
        ['({foo: "x"})', "object-error"],
        ['["a", "b"]', `${name}="a,b"`],
      ] as const;
      for (const [index, [value, attribute]] of values.entries()) {
        const rendered = renderConditional(
          `plain-value-${name.replace(":", "-")}-${index}`,
          `const value = ${value}; const rest = {"data-x": "y"};`,
          `<div ${name}=value/><div ...rest ${name}=value/>`,
        );
        if (attribute === "object-error") {
          await expect(rendered).rejects.toThrow(
            `The \`${name}\` attribute cannot be a plain object (it would render as \`[object Object]\`).`,
          );
          continue;
        }
        const html = await rendered;
        const suffix = attribute ? ` ${attribute}` : "";
        expect(html).toBe(
          `<div${suffix}></div><div data-x="y"${suffix}></div>`,
        );
      }
    },
  );

  it("evaluates a plain directive-shaped value expression exactly once", async () => {
    const html = await renderConditional(
      "plain-directive-evaluate-once",
      "let calls = 0; const read = () => { calls += 1; return true; };",
      "<div is:raw=read()/><b>${calls}</b>",
    );
    expect(html).toBe("<div is:raw></div><b>1</b>");
  });

  it("preserves a bare slot when explicit attrs merge with a spread", async () => {
    const html = await renderConditional(
      "plain-bare-slot-with-spread",
      'const rest = {"data-x": "y"};',
      "<span slot ...rest>body</span>",
    );
    expect(html).toBe('<span slot data-x="y">body</span>');
  });

  it("does not turn an authored slot attribute into an implicit named projection", async () => {
    const html = await renderConditional(
      "plain-slot-not-projected",
      "",
      '<Card><span slot="header">body</span></Card>',
    );
    expect(html).toBe("<section>fallback</section>");
  });

  it("keeps plain directive-shaped names when explicit attrs merge with a spread", async () => {
    const html = await renderConditional(
      "plain-directive-with-spread",
      'const value = "text"; const rest = {"data-x": "y"};',
      '<div is:raw=value ...rest transition:name="n">body</div>',
    );
    expect(html).toBe(
      '<div is:raw="text" data-x="y" transition:name="n">body</div>',
    );
  });
});

describe("conditional Astro named slots", () => {
  it("renders only the taken simple branch", async () => {
    const html = await renderConditional(
      "simple",
      "const takeFirst = true;",
      "<Card><if=takeFirst><@header><b>simple-taken</b></@header></if><else><@header><b>simple-not-taken</b></@header></else></Card>",
    );
    expect(html).toContain("simple-taken");
    expect(html).not.toContain("simple-not-taken");
  });

  it("renders a taken nested branch", async () => {
    const html = await renderConditional(
      "nested",
      "const outer = true; const inner = true;",
      "<Card><if=outer><if=inner><@header><b>nested-taken</b></@header></if></if></Card>",
    );
    expect(html).toContain("nested-taken");
    expect(html).not.toContain("fallback");
  });

  it("renders an if nested inside the taken else branch", async () => {
    const html = await renderConditional(
      "else-nested",
      "const first = false; const second = true;",
      "<Card><if=first><@header><b>else-not-taken</b></@header></if><else><if=second><@header><b>else-taken</b></@header></if></else></Card>",
    );
    expect(html).toContain("else-taken");
    expect(html).not.toContain("else-not-taken");
  });
});

// The local extension of decision 116 (firstmate's ruling under decision 116
// in `notes/decisions-2026-09-10.md`): a fence-declared `const`/`function`/
// `class` used as a tag classifies by whether its value is statically a
// function/arrow/class. A fence import already routes through decision 116
// proper (`isComponent`/`ctx.imports`); this covers the non-import fence
// binding decision 114's own fix (`unresolved-tag-jsx-astro-angular`)
// introduced but never classified.
describe("local-value-as-tag-parity: non-import fence binding used as a tag", () => {
  // Astro's own emitter rejects every non-"name" Component target
  // unconditionally (`component()`'s own `if (node.target.kind !== "name")`
  // guard, pre-existing, unrelated to this task): Astro resolves component
  // names statically and has no dynamic-tag construct at all, unlike the
  // other five hosts. So an "unknown" fence binding cannot render the way it
  // does on html/preact/react/hono/solid — it fails at MX compile time
  // instead, with its own wording naming the tag (lead's ruling: distinct
  // from the generic `<${expr}>` message, since the author wrote `<Tag/>`,
  // not a dynamic-tag expression). This is strictly better than the
  // pre-existing behavior, which silently compiled to a literal `<Tag>` JSX
  // reference that failed at Astro's own render time with an opaque
  // `NoMatchingRenderer`-class error instead.
  it("a fence const string is unknown and fails with a named compile error, not a silent misroute", () => {
    expect(() =>
      lowerAstroMx(
        '---\nconst Tag = "section";\n---\n<Tag data-x="1">body</Tag>',
        "Test.astro.mx",
      ),
    ).toThrow(
      "`<Tag>` is bound in the frontmatter to a value MX can't prove is a component, and @mxlang/astro can't render a tag name decided at runtime. Bind it to a component (an import, function or class), or use a lowercase element.",
    );
  });

  it("a conditional string-or-component fence binding is unknown and fails the same named error", () => {
    expect(() =>
      lowerAstroMx(
        [
          "---",
          'function A() { return "<span>a</span>"; }',
          'function B() { return "<span>b</span>"; }',
          "const useA = true;",
          "const Tag = useA ? A : B;",
          "---",
          "<Tag/>",
        ].join("\n"),
        "Test.astro.mx",
      ),
    ).toThrow(
      "`<Tag>` is bound in the frontmatter to a value MX can't prove is a component",
    );
  });

  it("a fence const bound to a call result (unknown) fails the same named error", () => {
    expect(() =>
      lowerAstroMx(
        [
          "---",
          'function make() { return "section"; }',
          "const Tag = make();",
          "---",
          '<Tag data-x="1">body</Tag>',
        ].join("\n"),
        "Test.astro.mx",
      ),
    ).toThrow(
      "`<Tag>` is bound in the frontmatter to a value MX can't prove is a component",
    );
  });

  it("a fence const string with no name it can bind still names the tag it was called as", () => {
    // Same case as above, different tag name, proving the error is derived
    // from the actual authored tag rather than hardcoded.
    expect(() =>
      lowerAstroMx(
        '---\nconst Widget = "div";\n---\n<Widget/>',
        "Test.astro.mx",
      ),
    ).toThrow("`<Widget>` is bound in the frontmatter");
  });

  it("a fence arrow-function const stays a direct component call, unaffected", () => {
    const { code } = lowerAstroMx(
      "---\nconst Comp = (props: { n: number }) => `<em>${props.n}</em>`;\n---\n<Comp n=1/>",
      "Test.astro.mx",
    );
    expect(code).toContain("<Comp n={1} />");
    expect(code).not.toContain("bound in the frontmatter");
  });

  it("a fence function declaration stays a direct component call, unaffected", () => {
    const { code } = lowerAstroMx(
      [
        "---",
        "function Comp(props: { n: number }) {",
        "  return `<em>${props.n}</em>`;",
        "}",
        "---",
        "<Comp n=1/>",
      ].join("\n"),
      "Test.astro.mx",
    );
    expect(code).toContain("<Comp n={1} />");
  });

  it("a fence import stays a direct component call, unaffected (decision 116 proper, not the local extension)", () => {
    const { code } = lowerAstroMx(
      '---\nimport Card from "./Card.astro";\n---\n<Card title="t"/>',
      "Test.astro.mx",
    );
    expect(code).toContain('<Card title="t" />');
  });
});
