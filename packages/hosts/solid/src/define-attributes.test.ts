// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * Marko makes a `<define>` tag's attributes properties of its value
 * (`<define/D a=1/>`, then `${D.a}` reads `1`). Solid hoists a define to a
 * module-level function under a generated name, so `D` is no value a template
 * expression can read: the attributes used to be refused at the first one.
 * They are lowered now: each read of `D` after the define is the object of its
 * attributes at the read (`({ "a": 1 }).a`).
 *
 * Every case EXECUTES the output (Solid SSR in a Bun subprocess, one case on
 * the client through jsdom), and the expected HTML is what stock Marko 6.4.4
 * and `@mxlang/target-html` render for the same source (probed with
 * `bun run --cwd packages/stock-marko probe` and a stock render).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import { sourceBindings, unknownSourceBindings } from "@mxlang/tsx-bridge";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

function compile(region: string, setup: string) {
  return compileSolidMx(region, {
    filename: "fixture.solid.mx",
    moduleBindings: sourceBindings(setup).bindings,
    unknownModuleBindings: unknownSourceBindings(setup),
  });
}

/** Compiles the region and the surrounding module through Solid's own babel plugin. */
function solidModule(
  region: string,
  setup: string,
  generate: "ssr" | "dom",
): string {
  const { code, hoistedImports, hoistedDefines } = compile(region, setup);
  const imports = [...hoistedImports, ...hoistedDefines]
    .map((entry) => entry.code)
    .join("\n");
  const source = `${imports}\nimport { createSignal } from "solid-js";\n${setup}\nexport function App() {\n  return <ul>${code}</ul>;\n}\n`;
  const out = transformSync(source, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate, hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!out?.code) throw new Error("Solid babel plugin produced no code");
  return out.code;
}

function runInTempDir(
  files: Record<string, string>,
  entry: string,
  flags: string[] = [],
): string {
  const dir = mkdtempSync(join(packageRoot, ".define-attrs-tmp-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
    }
    return execFileSync("bun", ["run", ...flags, join(dir, entry)], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 20_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function render(region: string, setup = ""): string {
  return runInTempDir(
    {
      "app.mjs": solidModule(region, setup, "ssr"),
      "run.mjs": `import { renderToString } from "@solidjs/web";\nimport { App } from "./app.mjs";\nprocess.stdout.write(renderToString(() => App()));\n`,
    },
    "run.mjs",
  );
}

// biome-ignore lint/suspicious/noExplicitAny: a caught TranslateError, read by field
function thrown(region: string, setup = ""): any {
  try {
    compile(region, setup);
  } catch (error) {
    return error;
  }
  return undefined;
}

const INPUT = "const input = { x: 7, rest: { a: 1, b: 2 } };";

// [label, region, setup, expected]. Expected is stock Marko 6.4.4's render.
const CASES: Array<[string, string, string, string]> = [
  ["a static attribute", "<define/D a=1/>${D.a}", "", "<ul>1</ul>"],
  [
    "a dynamic attribute",
    "<define/D a=input.x/><p>${D.a}</p>",
    INPUT,
    "<ul><p>7</p></ul>",
  ],
  [
    "a string and a number",
    '<define/D s="x" n=4/><p>${D.s}${D.n}</p>',
    "",
    "<ul><p>x4</p></ul>",
  ],
  [
    "attributes with params, read",
    "<define/D|v| a=1><b>${v}</b></define><p>${D.a}</p>",
    "",
    "<ul><p>1</p></ul>",
  ],
  [
    "attributes with params, called",
    "<define/D|v| a=1><b>${v}</b></define><p>${D.a}</p><D(5)/>",
    "",
    "<ul><p>1</p><b>5</b></ul>",
  ],
  [
    "a spread",
    "<define/D ...input.rest/><p>${D.a}-${D.b}</p>",
    INPUT,
    "<ul><p>1-2</p></ul>",
  ],
  [
    "a spread beside an attribute",
    "<define/D z=0 ...input.rest/><p>${D.z}${D.a}${D.b}</p>",
    INPUT,
    "<ul><p>012</p></ul>",
  ],
  [
    "two defines",
    "<define/A a=1/><define/B b=2/><p>${A.a}${B.b}</p>",
    "",
    "<ul><p>12</p></ul>",
  ],
  [
    "a later define reads an earlier one",
    "<define/A a=1/><define/B b=A.a/><p>${A.a}${B.b}</p>",
    "",
    "<ul><p>11</p></ul>",
  ],
  ["concise mode", "define/D a=1\np -- ${D.a}", "", "<ul><p>1</p></ul>"],
  [
    "in an element body",
    "<div><define/D a=1/><p>${D.a}</p></div>",
    "",
    "<ul><div><p>1</p></div></ul>",
  ],
  [
    "an attribute that is a method",
    "<define/D f() { return 3 }/><p>${D.f()}</p>",
    "",
    "<ul><p>3</p></ul>",
  ],
  [
    "a content attribute with no body",
    "<define/D content=1/><p>${D.content}</p>",
    "",
    "<ul><p>1</p></ul>",
  ],
  [
    "a hoisted define reads a literal attribute",
    "<define/D a=1/><define/E><i>${D.a}</i></define><E/>",
    "",
    "<ul><i>1</i></ul>",
  ],
  [
    "a param that shares the define's name shadows it",
    "<define/D a=1/><define/E|D|>${D}</define><E(5)/>",
    "",
    "<ul>5</ul>",
  ],
  [
    "an attribute that is never read",
    "<define/D a=input.x/><p>hi</p>",
    INPUT,
    "<ul><p>hi</p></ul>",
  ],
];

describe("solid: a <define>'s attributes are properties of its value", () => {
  it.each(CASES)("%s", (_label, region, setup, expected) => {
    expect(render(region, setup)).toBe(expected);
  });

  it("stays reactive: a signal an attribute reads updates the DOM", () => {
    const setup =
      "const [count, setCount] = createSignal(1); (globalThis as any).setCount = setCount;";
    const out = runInTempDir(
      {
        "app.mjs": solidModule(
          "<define/D a=count()/><p>${D.a}</p>",
          setup,
          "dom",
        ),
        "run.mjs": [
          'import { JSDOM } from "jsdom";',
          'const dom = new JSDOM("<!DOCTYPE html><body></body>");',
          "for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Text', 'Comment', 'DocumentFragment']) {",
          "  globalThis[k] = k === 'window' ? dom.window : k === 'document' ? dom.window.document : dom.window[k];",
          "}",
          'const { render } = await import("@solidjs/web");',
          'const { App } = await import("./app.mjs");',
          'const container = document.createElement("div");',
          "document.body.appendChild(container);",
          "render(() => App(), container);",
          "const snapshots = [container.innerHTML];",
          "globalThis.setCount(2);",
          "await new Promise((r) => setTimeout(r, 0));",
          "snapshots.push(container.innerHTML);",
          "process.stdout.write(JSON.stringify(snapshots));",
        ].join("\n"),
      },
      "run.mjs",
      ["--conditions=browser"],
    );
    expect(JSON.parse(out)).toEqual(["<ul><p>1</p></ul>", "<ul><p>2</p></ul>"]);
  });

  it("reads a loop row through a define in the same body", () => {
    // The define itself is hoisted, so one nested in a body is refused below;
    // a read of the region-level define's attributes inside a row is fine.
    expect(
      render(
        "<define/D a=input.x/><for|n| of=[1, 2]><p>${D.a}${n}</p></for>",
        INPUT,
      ),
    ).toBe("<ul><p>71</p><p>72</p></ul>");
  });
});

describe("solid: what stays refused", () => {
  it("a define nested in a <for> or an <if> keeps its hoisting error", () => {
    for (const region of [
      "<for|n| of=input.items><define/D a=n/><p>${D.a}</p></for>",
      "<if=input.show><define/D a=input.x/><p>${D.a}</p></if>",
    ]) {
      expect(thrown(region, INPUT).message).toContain(
        "`<define>` inside `<for>`/`<if>`/another construct's body is not hoisted to module scope; write `<define/D>` at the top level of the region",
      );
    }
  });

  it("a hoisted define that reads a dynamic attribute cannot close over the region", () => {
    expect(
      thrown("<define/D a=input.x/><define/E><i>${D.a}</i></define><E/>", INPUT)
        .message,
    ).toBe(
      "`<define/E>` is hoisted to module scope and cannot close over `input`, a value local to this region; pass it as a param instead",
    );
  });

  it("assigning the define's name is refused", () => {
    const source =
      "<define/D a=1/><button onClick() { D = 2 }>x</button><p>${D.a}</p>";
    const error = thrown(source);
    expect(error.message).toBe(
      "`D` is a `<define>`'s value and cannot be assigned; read its attributes as `D.name`",
    );
    expect(error.line).toBe(1);
  });

  it("a bound attribute (a:=x) is refused at the attribute", () => {
    const source = "<define/D a:=input.x/><p>${D.a}</p>";
    const error = thrown(source, INPUT);
    expect(error.message).toBe(
      "bound attribute (`:=`) is Marko reactive state; use Solid state and an explicit event handler",
    );
    expect([error.line, error.column]).toEqual([1, source.indexOf("a:=")]);
  });

  it("D.content of a define that has attributes and a body is refused, at the first attribute", () => {
    const source = "<define/D a=1><i>b</i></define><p>${typeof D.content}</p>";
    const error = thrown(source);
    expect(error.message).toBe(
      "`D.content` is the body of `<define/D>`, which a define with attributes cannot expose on Solid: the define is hoisted to a function. Call it as `<D/>`, or move the attributes to a second `<define>`",
    );
    expect([error.line, error.column]).toEqual([1, source.indexOf("a=1")]);
  });

  it("a define with a body and attributes is fine when nothing reads D.content", () => {
    expect(thrown("<define/D a=1><i>b</i></define><D/><p>${D.a}</p>")).toBe(
      undefined,
    );
  });

  it("a define with no attributes still compiles", () => {
    expect(thrown("<define/D><p>x</p></define><D/>")).toBeUndefined();
  });
});
