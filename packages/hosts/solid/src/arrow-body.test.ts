import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

/**
 * An arrow function body is a **block** the moment it starts with `{`, so a
 * `<for>`/render-prop body whose sole child is an expression rather than a
 * JSX element must still be emitted as an *expression* body — otherwise the
 * row callback returns `undefined` and the list renders nothing. That was a
 * silent defect (it compiled cleanly, so only executing the output could see
 * it), so every test here RENDERS through the real Solid 2 SSR pipeline:
 * `compileSolidUnit` -> this host's emitted Solid JSX -> `@solidjs/babel-plugin`
 * SSR codegen -> `@solidjs/web`'s `renderToString`, in a Bun subprocess. The
 * emitted text is asserted too, but only as a cheap second signal next to the
 * rendered output, never on its own.
 */
const packageRoot = new URL("..", import.meta.url).pathname;
const SUBPROCESS_TIMEOUT_MS = 30_000;

const BADGE_TSX = `export default function Badge(props: { label: string }) {
  return <b>{props.label}</b>;
}`;

const THROWER_TSX = `export default function Thrower(): never {
  throw new Error("MX: boom");
}`;

/** `<Row>` in the render-prop case: a component called with tag params. */
const ROW_TSX = `export default function Row(props: {
  children: (item: string) => unknown;
}) {
  return <ul>{(["a", "b"] as string[]).map(props.children)}</ul>;
}`;

interface Case {
  /** Fixture name, also the emitted unit's file name. */
  name: string;
  /** The whole-file MX source (its own imports are authored verbatim). */
  mx: string;
  /** The `input` object the entry calls the unit with. */
  input: string;
}

const PREAMBLE = `import Badge from "./badge.mjs";\nimport Row from "./row.mjs";\n`;

const CASES: Case[] = [
  {
    name: "ForOfSoleComponent",
    input: `{ items: ["a", "b"] }`,
    mx: `${PREAMBLE}export interface Input { items: string[] }
<for|item| of=input.items><Badge label=item/></for>
`,
  },
  {
    name: "ForInSoleComponent",
    input: `{ obj: { a: "x", b: "y" } }`,
    mx: `${PREAMBLE}export interface Input { obj: Record<string, string> }
<for|key| in=input.obj><Badge label=key/></for>
`,
  },
  {
    name: "ForToSoleComponent",
    input: `{ to: 3 }`,
    mx: `${PREAMBLE}export interface Input { to: number }
<for|i| to=input.to><Badge label=String(i)/></for>
`,
  },
  {
    name: "ForToStepSoleComponent",
    input: `{ to: 3 }`,
    mx: `${PREAMBLE}export interface Input { to: number }
<for|i| from=0 to=input.to step=1><Badge label=String(i)/></for>
`,
  },
  {
    name: "ForOfSolePlaceholder",
    input: `{ items: ["a", "b"] }`,
    mx: `export interface Input { items: string[] }
<for|item| of=input.items>\${item}</for>
`,
  },
  {
    name: "ForOfSoleDynamicTag",
    input: `{ items: ["a", "b"] }`,
    mx: `export interface Input { items: string[] }
<for|item| of=input.items><\${item} label=item/></for>
`,
  },
  {
    name: "ForOfSoleIf",
    input: `{ items: ["a", "b"] }`,
    mx: `${PREAMBLE}export interface Input { items: string[] }
<for|item| of=input.items><if=item><Badge label=item/></if></for>
`,
  },
  {
    name: "ForOfTwoChildren",
    input: `{ items: ["a", "b"] }`,
    mx: `${PREAMBLE}export interface Input { items: string[] }
<for|item| of=input.items><li>\${item}</li><Badge label=item/></for>
`,
  },
  {
    name: "RenderPropSoleComponent",
    input: `{}`,
    mx: `${PREAMBLE}export interface Input {}
<Row|item|><Badge label=item/></Row>
`,
  },
  {
    name: "RenderPropRawWrapper",
    input: `{}`,
    mx: `${PREAMBLE}export interface Input {}
<Row|item|><div innerHTML=item/></Row>
`,
  },
  {
    name: "TryFallbackSoleComponent",
    input: `{}`,
    mx: `${PREAMBLE}import Thrower from "./thrower.mjs";
export interface Input {}
<try><Thrower label="x"/><@catch|e|><Badge label="caught"/></@catch></try>
`,
  },
];

function transform(source: string, filename: string): string {
  const result = transformSync(source, {
    filename,
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!result?.code) throw new Error(`Solid transform produced no ${filename}`);
  return result.code;
}

const rendered = renderAll();

/**
 * Compiles and renders every case in one subprocess: one `bun` spawn for the
 * whole matrix, each case's rendered HTML keyed by fixture name.
 *
 * Each unit is loaded with a DYNAMIC import inside its own try/catch, so a
 * case whose emitted text does not even parse (the stepped `<for>` emitted
 * `return {(() => …`, which reads as an object literal rather than a returned
 * expression) fails its own assertions instead of taking the whole file's
 * collection down with a module-load SyntaxError.
 */
function renderAll(): Record<string, string> {
  const dir = mkdtempSync(join(packageRoot, ".arrow-body-"));
  try {
    for (const [name, source] of [
      ["badge", BADGE_TSX],
      ["thrower", THROWER_TSX],
      ["row", ROW_TSX],
    ] as const) {
      writeFileSync(join(dir, `${name}.mjs`), transform(source, `${name}.tsx`));
    }
    for (const testCase of CASES) {
      // Emitted text that does not even parse (the stepped `<for>`'s
      // `return {(() => …`) fails here, in the parent, before any render.
      // Stub it with a unit that throws the compiler's own message so the
      // case's assertion shows that error instead of the whole file failing
      // to collect.
      let code: string;
      try {
        code = transform(
          compileSolidUnit(testCase.mx, {
            filename: join(dir, `${testCase.name}.mx`),
          }).code,
          `${testCase.name}.tsx`,
        );
      } catch (error) {
        code = `export default function Unit(): never { throw new Error(${JSON.stringify(String((error as Error).message).slice(0, 200))}); }`;
      }
      writeFileSync(join(dir, `${testCase.name}.mjs`), code);
    }
    const entry = transform(
      `import { renderToString } from "@solidjs/web";
const out: Record<string, string> = {};
for (const [name, load] of Object.entries({
${CASES.map(
  (c) =>
    `  ${JSON.stringify(c.name)}: async () => { const m = await import("./${c.name}.mjs"); return renderToString(() => m.default(${c.input})); },`,
).join("\n")}
})) {
  try {
    out[name] = await (load as () => Promise<string>)();
  } catch (error) {
    out[name] = "RENDER ERROR: " + String((error as Error).message);
  }
}
console.log(JSON.stringify(out));`,
      "entry.tsx",
    );
    const runner = join(dir, "entry.mjs");
    writeFileSync(runner, entry);
    const output = execFileSync("bun", ["run", runner], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
    }).trim();
    const result = JSON.parse(output) as Record<string, string>;
    for (const testCase of CASES) {
      if (result[testCase.name] === undefined) {
        throw new Error(`no rendered output for ${testCase.name}`);
      }
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Solid's SSR output brackets each top-level node with `<!--…-->` markers. */
const html = (name: string) =>
  (rendered[name] ?? "")
    .replace(/<!--[^>]*-->/g, "")
    .replace(/ _hk=\S+/g, "")
    .replace(/<script>.*?<\/script>/gs, "");

const shape = (name: string) => {
  const testCase = CASES.find((c) => c.name === name);
  if (!testCase) throw new Error(`unknown fixture ${name}`);
  return compileSolidUnit(testCase.mx, { filename: `${name}.mx` }).code;
};

describe("Solid: a tag-params body is an arrow EXPRESSION body", () => {
  it("renders a sole component in a `<for of>` body per item", () => {
    expect(html("ForOfSoleComponent")).toBe("<b>a</b><b>b</b>");
  });

  it("renders a sole component in a `<for in>` body per entry key", () => {
    expect(html("ForInSoleComponent")).toBe("<b>a</b><b>b</b>");
  });

  it("renders a sole component in a `<for to>` body per index", () => {
    expect(html("ForToSoleComponent")).toBe("<b>0</b><b>1</b><b>2</b><b>3</b>");
  });

  it("renders a sole component in a stepped `<for to>` body per index", () => {
    expect(html("ForToStepSoleComponent")).toBe(
      "<b>0</b><b>1</b><b>2</b><b>3</b>",
    );
  });

  it("renders a sole placeholder in a `<for of>` body per item", () => {
    expect(html("ForOfSolePlaceholder")).toBe("ab");
  });

  it("renders a sole dynamic tag in a `<for of>` body per item", () => {
    expect(html("ForOfSoleDynamicTag")).toBe(
      '<a label="a"></a><b label="b"></b>',
    );
  });

  it("renders a sole `<if>` in a `<for of>` body per item", () => {
    expect(html("ForOfSoleIf")).toBe("<b>a</b><b>b</b>");
  });

  it("renders every child of a multi-child `<for of>` body", () => {
    expect(html("ForOfTwoChildren")).toBe(
      "<li>a</li><b>a</b><li>b</li><b>b</b>",
    );
  });

  it("renders the `<div innerHTML=item/>` wrapper a rejected `$!{item}` body suggests", () => {
    expect(html("RenderPropRawWrapper")).toBe(
      "<ul><div>a</div><div>b</div></ul>",
    );
  });

  it("renders a sole component in a render-prop body", () => {
    expect(html("RenderPropSoleComponent")).toBe("<ul><b>a</b><b>b</b></ul>");
  });

  it("renders a sole component in a `<try>` `<@catch>` fallback", () => {
    expect(html("TryFallbackSoleComponent")).toBe("<b>caught</b>");
  });
});

describe("Solid: the emitted arrow body is never a bare block", () => {
  it("wraps a `<for of>` row body in a fragment rather than a block", () => {
    expect(shape("ForOfSoleComponent")).toContain("{(item) => <>");
  });

  it("wraps a `<for in>` row body in a fragment rather than a block", () => {
    expect(shape("ForInSoleComponent")).toContain("{(mxEntry) => <>");
  });

  it("wraps a stepped `<for to>` row body in a fragment rather than a block", () => {
    const code = shape("ForToStepSoleComponent");
    expect(code).toContain("return <>");
    expect(code).not.toContain("return {(() =>");
  });

  it("wraps a render-prop body in a fragment rather than a block", () => {
    expect(shape("RenderPropSoleComponent")).toContain("{(item) => <>");
  });

  it("wraps a `<try>` fallback body in a fragment rather than a nested block", () => {
    // The fallback arrow is itself a block (it binds the catch param to the
    // unwrapped error first), but the *body* it returns is a fragment, not
    // an IIFE block like the pre-fragment lowering used.
    expect(shape("TryFallbackSoleComponent")).toContain(
      "fallback={(__mxErr) => { const e = __mxErr(); return <>",
    );
  });
});

/** Throws on a syntax error; the emitted module need not RUN to be checked. */
const parses = (code: string) => transform(code, "parses.tsx");

describe("Solid: a `{`-led body is a JSX value in every splice position", () => {
  it("emits a `<try>` `<@placeholder>` sole dynamic tag as a fragment, not `fallback={{`", () => {
    const code = compileSolidUnit(
      `${PREAMBLE}export interface Input {}
<try><@placeholder><\${Badge} label="p"/></@placeholder><Badge label="x"/></try>
`,
      { filename: "Placeholder.mx" },
    ).code;
    expect(code).not.toContain("fallback={{");
    expect(code).toContain("fallback={<>");
    expect(() => parses(code)).not.toThrow();
  });

  it("emits a sole `<define>` call in a `<define>` call's body as a fragment argument", () => {
    const result = compileSolidMx(
      `<define/A|n|>\${n}</define><define/R|content|>\${content}</define><R><A(1)/></R>`,
      { filename: "fixture.solid.mx" },
    );
    const region = result.code;
    expect(region).not.toMatch(/\({__mx_Define/);
    const module = [
      ...result.hoistedDefines.map((d) => d.code),
      `export const view = <div>${region}</div>;`,
    ].join("\n");
    expect(() => parses(module)).not.toThrow();
  });
});
