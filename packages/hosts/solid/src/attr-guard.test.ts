import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import {
  parse as parseMxFile,
  sourceBindings,
  unknownSourceBindings,
} from "@mxlang/parser";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { beforeAll, describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

interface Case {
  fragment: string;
  setup: string;
}

const PLAIN =
  "The `data-x` attribute cannot be a plain object (it would render as `[object Object]`).";

const CASES: Record<string, Case> = {
  direct: {
    fragment: "<div data-x=input.o/>",
    setup: "const input = { o: { a: 1 } };",
  },
  nullProto: {
    fragment: "<div data-x=input.o/>",
    setup: "const input = { o: Object.assign(Object.create(null), { a: 1 }) };",
  },
  spread: {
    fragment: "<div ...input.attrs/>",
    setup: 'const input = { attrs: { "data-x": { a: 1 } } };',
  },
  spreadOverwritten: {
    fragment: "<div ...input.a ...input.b/>",
    setup:
      'const input = { a: { "data-x": { a: 1 } }, b: { "data-x": "ok" } };',
  },
  spreadSafe: {
    fragment: "<div ...input.attrs/>",
    setup:
      'const input = { attrs: { "data-x": "s", "data-n": 0, "data-z": null, id: "i" } };',
  },
  array: {
    fragment: "<div data-x=input.v/>",
    setup: "const input = { v: [1, 2] };",
  },
  zero: {
    fragment: "<div data-x=input.v/>",
    setup: "const input = { v: 0 };",
  },
  nullValue: {
    fragment: "<div data-x=input.v/>",
    setup: "const input = { v: null };",
  },
  string: {
    fragment: "<div data-x=input.v/>",
    setup: 'const input = { v: "s" };',
  },
  classStyle: {
    fragment: "<div class={a: true, b: false} style={color: 'red'}/>",
    setup: "const input = {};",
  },
  component: {
    fragment: "<Box data=input.o/>",
    setup:
      "const input = { o: { a: 1 } }; function Box(props: { data: object }) { return <p>{typeof props.data}</p>; }",
  },
  innerHtml: {
    fragment: "<div innerHTML=input.o/>",
    setup: "const input = { o: { a: 1 } };",
  },
  textContent: {
    fragment: "<div textContent=input.o/>",
    setup: "const input = { o: { a: 1 } };",
  },
  classList: {
    fragment: "<div classList=input.o/>",
    setup: "const input = { o: { x: true } };",
  },
  attrNamespace: {
    fragment: "<div attr:x=input.o/>",
    setup: "const input = { o: { a: 1 } };",
  },
  boolNamespace: {
    fragment: "<div bool:x=input.o/>",
    setup: "const input = { o: { a: 1 } };",
  },
  useNamespace: {
    fragment: "<div use:x=input.o/>",
    setup: "const input = { o: { a: 1 } };",
  },
  attrNamespaceSpread: {
    fragment: "<div ...input.a/>",
    setup: 'const input = { a: { "attr:x": { a: 1 }, "bool:y": { a: 1 } } };',
  },
  propNamespace: {
    fragment: "<div prop:x=input.o/>",
    setup: "const input = { o: { a: 1 } };",
  },
  eventSpread: {
    fragment: "<div ...input.a/>",
    setup:
      '(globalThis as any).__mxHit = 0; const input = { a: { "on-myevent": () => { (globalThis as any).__mxHit++; }, onClick: () => {} } };',
  },
  classListSpread: {
    fragment: "<div ...input.a/>",
    setup: "const input = { a: { classList: { x: true } } };",
  },
  colonName: {
    fragment: "<div :foo=input.o/>",
    setup: "const input = { o: { a: 1 } };",
  },
  attributeBeforeSpread: {
    fragment: "<div data-x=input.o ...input.a/>",
    setup: 'const input = { o: { a: 1 }, a: { "data-x": "ok" } };',
  },
  dynamicTagString: {
    fragment: "<${input.tag} data-x=input.o/>",
    setup: 'const input = { tag: "div", o: { a: 1 } };',
  },
  dynamicTagSpread: {
    fragment: "<${input.tag} ...input.s/>",
    setup: 'const input = { tag: "div", s: { "data-x": { a: 1 } } };',
  },
  dynamicTagComponent: {
    fragment: "<${input.tag} data-x=input.o/>",
    setup:
      "const input = { o: { a: 1 }, tag: function Box(props: { 'data-x': object }) { return <p>{typeof props['data-x']}</p>; } };",
  },
  functionValue: {
    fragment: "<div data-x=input.f/>",
    setup: "const input = { f: () => 1 };",
  },
};

type Outcome = { html?: string; error?: string; hit?: number };
const outcomes: Record<"ssr" | "dom", Record<string, Outcome>> = {
  ssr: {},
  dom: {},
};

function compileCase(
  generate: "ssr" | "dom",
  { fragment, setup }: Case,
): { code: string; source: string } {
  const { code, hoistedImports, hoistedDefines } = compileSolidMx(fragment, {
    filename: "fixture.solid.mx",
    moduleBindings: sourceBindings(setup).bindings,
    unknownModuleBindings: unknownSourceBindings(setup),
  });
  const source = `${hoistedImports.map((e) => e.code).join("\n")}\n${hoistedDefines.map((e) => e.code).join("\n")}\nexport function App() {\n  ${setup}\n  return <ul>${code}</ul>;\n}\n`;
  const out = transformSync(source, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate, hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!out?.code) throw new Error("no output");
  return { code: out.code, source };
}

// A render that throws leaves Solid's global scheduler half-flushed, so every
// DOM case gets its own process; SSR cases share one.
function runAll(generate: "ssr" | "dom"): Record<string, Outcome> {
  if (generate === "dom") {
    return Object.fromEntries(
      Object.keys(CASES).flatMap((name) =>
        Object.entries(runNames(generate, [name])),
      ),
    );
  }
  return runNames(generate, Object.keys(CASES));
}

function runNames(
  generate: "ssr" | "dom",
  names: string[],
): Record<string, Outcome> {
  const dir = mkdtempSync(join(packageRoot, ".attr-guard-tmp-"));
  try {
    names.forEach((name, index) => {
      const entry = CASES[name] as Case;
      writeFileSync(
        join(dir, `app${index}.mjs`),
        compileCase(generate, entry).code,
      );
    });
    const runner =
      generate === "ssr"
        ? [
            'import { renderToString } from "@solidjs/web";',
            "const out = {};",
            `const names = ${JSON.stringify(names)};`,
            "for (let i = 0; i < names.length; i++) {",
            "  try {",
            "    const { App } = await import(`./app${i}.mjs`);",
            "    out[names[i]] = { html: renderToString(() => App()) };",
            "  } catch (e) { out[names[i]] = { error: String(e && e.message) }; }",
            "}",
            "process.stdout.write(JSON.stringify(out));",
          ]
        : [
            'import { JSDOM } from "jsdom";',
            'const dom = new JSDOM("<!DOCTYPE html><body></body>");',
            "for (const k of ['window','document','HTMLElement','Node','Text','Comment','DocumentFragment']) globalThis[k] = dom.window[k];",
            'const { render } = await import("@solidjs/web");',
            "const out = {};",
            `const names = ${JSON.stringify(names)};`,
            "for (let i = 0; i < names.length; i++) {",
            "  try {",
            "    const { App } = await import(`./app${i}.mjs`);",
            '    const c = document.createElement("div");',
            "    document.body.appendChild(c);",
            "    render(() => App(), c);",
            "    await new Promise((r) => setTimeout(r, 0));",
            '    for (const el of c.querySelectorAll("*")) for (const n of ["myevent", "-myevent"]) el.dispatchEvent(new dom.window.CustomEvent(n));',
            "    out[names[i]] = { html: c.innerHTML, hit: globalThis.__mxHit ?? 0 };",
            "  } catch (e) { out[names[i]] = { error: String(e && e.message) }; }",
            "}",
            "process.stdout.write(JSON.stringify(out));",
          ];
    writeFileSync(join(dir, "run.mjs"), runner.join("\n"));
    const stdout = execFileSync(
      "bun",
      [
        "run",
        ...(generate === "dom" ? ["--conditions=browser"] : []),
        join(dir, "run.mjs"),
      ],
      { cwd: packageRoot, encoding: "utf8", timeout: 30_000 },
    );
    return JSON.parse(stdout) as Record<string, Outcome>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(() => {
  outcomes.ssr = runAll("ssr");
  outcomes.dom = runAll("dom");
}, 60_000);

describe.each(["ssr", "dom"] as const)(
  "native attribute guard (%s)",
  (mode) => {
    const get = (name: string): Outcome =>
      outcomes[mode][name] ?? { error: `missing ${name}` };

    it("throws Marko's message for a plain object", () => {
      expect(get("direct").error).toBe(PLAIN);
    });
    it("throws for a null-prototype object", () => {
      expect(get("nullProto").error).toBe(PLAIN);
    });
    it("throws for a plain object arriving through a spread", () => {
      expect(get("spread").error).toBe(PLAIN);
    });
    it("does not validate a spread value a later spread overwrites", () => {
      expect(get("spreadOverwritten").error).toBeUndefined();
      expect(get("spreadOverwritten").html).toContain('data-x="ok"');
    });
    it("matches Marko for an attribute a later spread overwrites", () => {
      expect(get("attributeBeforeSpread").error).toBeUndefined();
      expect(get("attributeBeforeSpread").html).toContain('data-x="ok"');
    });
    it("validates innerHTML, textContent, classList and colon names", () => {
      for (const name of [
        "innerHtml",
        "textContent",
        "classList",
        "classListSpread",
        "colonName",
      ]) {
        const error = get(name).error;
        expect(error ?? `${name} did not throw`).toMatch(
          /^The `[^`]+` attribute cannot be a plain object \(it would render as `\[object Object\]`\)\.$/,
        );
      }
      expect(get("colonName").error).toContain("`value:foo`");
    });
    it("validates attr:, bool: and use:, which are attribute writes on Solid", () => {
      for (const name of [
        "attrNamespace",
        "boolNamespace",
        "useNamespace",
        "attrNamespaceSpread",
      ]) {
        expect(get(name).error ?? `${name} did not throw`, name).toMatch(
          /^The `(?:attr:x|bool:x|use:x|attr:x)` attribute cannot be a plain object/,
        );
      }
    });
    it("leaves prop: (a property write) and event handler keys alone", () => {
      expect(get("propNamespace").error).toBeUndefined();
      expect(get("eventSpread").error).toBeUndefined();
      if (mode === "dom") expect(get("eventSpread").hit).toBe(1);
    });
    it("guards a string-target dynamic tag but not a component target", () => {
      expect(get("dynamicTagString").error).toBe(PLAIN);
      expect(get("dynamicTagSpread").error).toBe(PLAIN);
      expect(get("dynamicTagComponent").error).toBeUndefined();
      expect(get("dynamicTagComponent").html).toContain("object");
    });
    it("renders ordinary spread values", () => {
      expect(get("spreadSafe").error).toBeUndefined();
      expect(get("spreadSafe").html).toContain('data-x="s"');
      expect(get("spreadSafe").html).toContain('data-n="0"');
    });
    it("leaves arrays, 0, null and strings as they render", () => {
      expect(get("array").error).toBeUndefined();
      expect(get("array").html).toContain('data-x="1,2"');
      expect(get("zero").error).toBeUndefined();
      expect(get("zero").html).toContain('data-x="0"');
      expect(get("nullValue").error).toBeUndefined();
      expect(get("nullValue").html).not.toContain("data-x");
      expect(get("string").error).toBeUndefined();
      expect(get("string").html).toContain('data-x="s"');
    });
    it("leaves class and style objects alone", () => {
      expect(get("classStyle").error).toBeUndefined();
      expect(get("classStyle").html).toContain("a");
      expect(get("classStyle").html).toContain("color");
    });
    it("leaves component props alone", () => {
      expect(get("component").error).toBeUndefined();
      expect(get("component").html).toContain("object");
    });
    it("rejects a function like Marko", () => {
      expect(get("functionValue").error).toBe(
        "The `data-x` attribute cannot be a function.",
      );
    });
  },
);

describe("emitted code", () => {
  it("leaves string and static attributes byte-identical", () => {
    const { code, hoistedDefines } = compileSolidMx(
      '<div id="a" data-x="b" title="${input.t}" class=input.c/>',
      { filename: "fixture.solid.mx" },
    );
    expect(code).not.toContain("__mxAttrValue");
    expect(hoistedDefines).toEqual([]);
  });
  it("wraps a dynamic native attribute and hoists one helper", () => {
    const { code, hoistedDefines } = compileSolidMx(
      "<div data-x=input.o/><p ...input.s/>",
      { filename: "fixture.solid.mx" },
    );
    expect(code).toContain('data-x={__mxAttrValue("data-x", input.o, "div")}');
    expect(code).toContain('{...__mxAttrSpread(input.s, "p")}');
    expect(hoistedDefines.map((d) => d.binding).sort()).toEqual([
      "__mxAttrSpread",
      "__mxAttrValue",
    ]);
  });
  it("does not wrap component attributes", () => {
    const { code } = compileSolidMx("<Box data=input.o ...input.s/>", {
      filename: "fixture.solid.mx",
      moduleBindings: new Set(["Box"]),
    });
    expect(code).not.toContain("__mxAttr");
  });
});

describe("module assembly", () => {
  it("declares each helper once across regions of one file", () => {
    const source = [
      "export function A(input: { o: unknown; s: object }) {",
      "  return (<div data-x=input.o ...input.s/>);",
      "}",
      "export function B(input: { o: unknown }) {",
      "  return (<p data-y=input.o/>);",
      "}",
    ].join("\n");
    const file = parseMxFile(source, "two-regions.solid.mx", {
      // biome-ignore lint/suspicious/noExplicitAny: MxRegionCompile shape, avoiding a parser<->solid type cycle in a test
      mxRegionCompile: ((input: any) =>
        compileSolidMx(input.source, input)) as any,
    });
    const names = (
      file.program as unknown as {
        body: Array<{ type?: string; id?: { name?: string } }>;
      }
    ).body
      .filter((node) => node.type === "FunctionDeclaration")
      .map((node) => node.id?.name);
    expect(names.filter((name) => name === "__mxAttrValue")).toHaveLength(1);
    expect(names.filter((name) => name === "__mxAttrSpread")).toHaveLength(1);
  });
  it("declares the helpers in a whole-file tag unit", () => {
    const { code } = compileSolidUnit("<div data-x=input.o ...input.s/>", {
      filename: "unit.mx",
    });
    expect(code).toContain("function __mxAttrValue");
    expect(code).toContain("function __mxAttrSpread");
  });
});
