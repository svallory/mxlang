import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import {
  parse as parseMxFile,
  sourceBindings,
  unknownSourceBindings,
} from "@mxlang/tsx-bridge";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ATTR_SPREAD_HELPER,
  ATTR_VALUE_HELPER,
  TEXTAREA_DYN_SPREAD_HELPER,
  TEXTAREA_OMIT_HELPER,
} from "./attr-guard.ts";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

const execFileAsync = promisify(execFile);

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
    fragment: "<div value:foo=input.o/>",
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
  rawHtmlSpread: {
    fragment: "<div ...input.a/>",
    setup:
      'const input = { a: { innerHTML: "<b>x</b>", outerHTML: "<i>y</i>", id: "k" } };',
  },
  rawHtmlSpreadBody: {
    fragment: "<div ...input.a>body</div>",
    setup: 'const input = { a: { innerHTML: "<b>x</b>" } };',
  },
  rawHtmlSpreadFrozen: {
    fragment: "<div ...input.a/>",
    setup:
      'const input = { a: Object.freeze({ innerHTML: "<b>x</b>", class: false, id: "k" }) };',
  },
  rawHtmlSpreadOverwritten: {
    fragment: "<div ...input.a ...input.b/>",
    setup:
      'const input = { a: { innerHTML: "<b>x</b>" }, b: { innerHTML: "plain" } };',
  },
  propInnerHtmlSpread: {
    fragment: "<div ...input.a/>",
    setup: 'const input = { a: { "prop:innerHTML": "<b>x</b>", id: "k" } };',
  },
  propOuterHtmlSpread: {
    fragment: "<section><span ...input.a/></section>",
    setup: 'const input = { a: { "prop:outerHTML": "<b>x</b>" } };',
  },
  textContentSpread: {
    fragment: "<div ...input.a/>",
    setup:
      'const input = { a: { textContent: "<b>x</b>", innerText: "<i>y</i>" } };',
  },
  scriptTextSpread: {
    fragment: "<html-script ...input.a/>",
    setup:
      'const input = { a: { textContent: "</script><b>x</b>", innerText: "</script><i>y</i>", children: "</script><u>z</u>" } };',
  },
  scriptTextSpreadBody: {
    fragment: "<html-script ...input.a>var a = 1;</html-script>",
    setup:
      'const input = { a: { textContent: "</script><b>x</b>", children: "</script><u>z</u>" } };',
  },
  styleDynamicTag: {
    fragment: "<${input.tag} ...input.a/>",
    setup:
      'const input = { tag: "style", a: { textContent: "</style><b>x</b>", children: "</style><u>z</u>" } };',
  },
  childrenObjectSpread: {
    fragment: "<div ...input.a/>",
    setup: 'const input = { a: { children: { t: "<b>x</b>" } } };',
  },
  childrenArraySpread: {
    fragment: "<div ...input.a/>",
    setup: 'const input = { a: { children: [{ t: "<b>x</b>" }] } };',
  },
  childrenTextSpread: {
    fragment: "<div ...input.a/>",
    setup: 'const input = { a: { children: "hello <i>" } };',
  },
  dynamicLiteralInnerHtml: {
    fragment: "<${input.tag} innerHTML=input.x/>",
    setup: 'const input = { tag: "div", x: "<b>x</b>" };',
  },
  dynamicLiteralStyleText: {
    fragment: "<${input.tag} textContent=input.x/>",
    setup: 'const input = { tag: "style", x: "</style><b>x</b>" };',
  },
  literalChildrenObject: {
    fragment: "<div children=input.x/>",
    setup: 'const input = { x: { t: "<b>x</b>" } };',
  },
  literalChildrenArray: {
    fragment: "<div children=input.x/>",
    setup: 'const input = { x: [{ t: "<b>x</b>" }] };',
  },
  literalChildrenText: {
    fragment: "<div children=input.x/>",
    setup: 'const input = { x: "hello <i>" };',
  },
  dynamicLiteralChildrenObject: {
    fragment: "<${input.tag} children=input.x/>",
    setup: 'const input = { tag: "div", x: { t: "<b>x</b>" } };',
  },
  literalOuterHtml: {
    fragment: "<section><div outerHTML=input.h/></section>",
    setup: 'const input = { h: "<b>x</b>" };',
  },
  upperScriptTagSpread: {
    fragment: "<${input.tag} ...input.a/>",
    setup:
      'const input = { tag: "SCRIPT", a: { children: "alert(1)", id: "k" } };',
  },
  scriptPropTextSpread: {
    fragment: "<${input.tag} ...input.a/>",
    setup:
      'const input = { tag: "script", a: { "prop:textContent": "alert(1)", "prop:innerText": "alert(2)", "prop:text": "alert(3)", id: "k" } };',
  },
  scriptPropTextLiteralDynamicTag: {
    fragment: "<${input.tag} prop:textContent=input.x/>",
    setup: 'const input = { tag: "script", x: "alert(1)" };',
  },
  divPropTextSpread: {
    fragment: "<div ...input.a/>",
    setup: 'const input = { a: { "prop:textContent": "plain" } };',
  },
  rawHtmlSpreadObject: {
    fragment: "<div ...input.a/>",
    setup: "const input = { a: { innerHTML: { a: 1 } } };",
  },
  rawHtmlSpreadFalsy: {
    fragment: "<div ...input.a/>",
    setup: "const input = { a: { innerHTML: null, outerHTML: false } };",
  },
  rawHtmlSpreadDynamicTag: {
    fragment: "<${input.tag} ...input.a/>",
    setup: 'const input = { tag: "p", a: { innerHTML: "<b>x</b>" } };',
  },
  rawHtmlSpreadComponent: {
    fragment: "<${input.tag} ...input.a/>",
    setup:
      'const input = { a: { innerHTML: "<b>x</b>" }, tag: function Box(props: { innerHTML: string }) { return <p>{props.innerHTML}</p>; } };',
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
async function runAll(
  generate: "ssr" | "dom",
): Promise<Record<string, Outcome>> {
  if (generate === "dom") {
    const out: Record<string, Outcome> = {};
    for (const name of Object.keys(CASES)) {
      Object.assign(out, await runNames(generate, [name]));
    }
    return out;
  }
  return runNames(generate, Object.keys(CASES));
}

// The runner processes are awaited, never `execFileSync`: the hook runs 67-162 s
// in a full gate, and a synchronous wait held the worker's event loop for all of
// it, so vitest's `onTaskUpdate` RPC reply (birpc's fixed 60 s limit) could not
// be read and the run failed with `Timeout calling "onTaskUpdate"` (#390).
async function runNames(
  generate: "ssr" | "dom",
  names: string[],
): Promise<Record<string, Outcome>> {
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
    const { stdout } = await execFileAsync(
      "bun",
      [
        "run",
        ...(generate === "dom" ? ["--conditions=browser"] : []),
        join(dir, "run.mjs"),
      ],
      { cwd: packageRoot, encoding: "utf8", timeout: 120_000 },
    );
    return JSON.parse(stdout) as Record<string, Outcome>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Measured in 27 full-gate runs since 2026-10-15 (82 tests): attr-guard.test.ts
// takes 67-162 s, nearly all of it this hook. At 37-74 tests the old 60 s limit
// failed 5 of 143 gate runs that include this file. 240 s is 1.5x the worst
// measured file time; a hang still fails.
beforeAll(async () => {
  outcomes.ssr = await runAll("ssr");
  outcomes.dom = await runAll("dom");
}, 240_000);

/** The markup outside attribute values: the DOM serializer leaves `<` raw inside a quoted attribute, so only an element would show here. */
const markup = (html = ""): string => html.replace(/="[^"]*"/g, '=""');

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
    it("validates textContent, classList and colon names", () => {
      for (const name of [
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
    it("writes a spread's innerHTML and outerHTML as escaped attributes, as Marko does", () => {
      const { error, html } = get("rawHtmlSpread");
      expect(error).toBeUndefined();
      expect(markup(html)).not.toContain("<b>");
      expect(markup(html)).not.toContain("<i>");
      expect(html).toContain('innerhtml="');
      expect(html).toContain('outerhtml="');
      expect(html).toContain('id="k"');
    });
    it("keeps the body beside a spread that carries innerHTML", () => {
      const { error, html } = get("rawHtmlSpreadBody");
      expect(error).toBeUndefined();
      expect(html).toContain("body");
      expect(markup(html)).not.toContain("<b>");
    });
    it("hides the camel-case key of a frozen spread without a Proxy error", () => {
      const { error, html } = get("rawHtmlSpreadFrozen");
      expect(error).toBeUndefined();
      expect(markup(html)).not.toContain("<b>");
      expect(html).toContain('id="k"');
    });
    it("does not read a raw key a later spread overwrites", () => {
      const { error, html } = get("rawHtmlSpreadOverwritten");
      expect(error).toBeUndefined();
      expect(html).toContain('innerhtml="plain"');
      expect(markup(html)).not.toContain("<b>");
    });
    it("validates a raw key like any attribute, and says how to write raw HTML", () => {
      expect(get("rawHtmlSpreadObject").error).toBe(
        "The `innerHTML` attribute cannot be a plain object (it would render as `[object Object]`). To write raw HTML, make `$!{html}` the element's only child.",
      );
    });
    it("does not let a spread's prop:innerHTML or prop:outerHTML assign markup", () => {
      const inner = get("propInnerHtmlSpread");
      expect(inner.error).toBeUndefined();
      expect(markup(inner.html)).not.toContain("<b>");
      expect(inner.html).toContain('id="k"');
      const outer = get("propOuterHtmlSpread");
      expect(outer.error).toBeUndefined();
      expect(markup(outer.html)).not.toContain("<b>");
      expect(outer.html).toContain("<span");
    });
    it("writes a spread's textContent and innerText as escaped lowercase attributes", () => {
      const { error, html } = get("textContentSpread");
      expect(error).toBeUndefined();
      expect(markup(html)).not.toContain("<b>");
      expect(markup(html)).not.toContain("<i>");
      expect(html).toContain('textcontent="');
      expect(html).toContain('innertext="');
    });
    it("cannot be broken out of by a spread on <html-script> or <style>", () => {
      for (const name of [
        "scriptTextSpread",
        "scriptTextSpreadBody",
        "styleDynamicTag",
      ]) {
        const { error, html } = get(name);
        expect(error).toBeUndefined();
        const outside = markup(html);
        expect(outside).not.toMatch(/<[biu]>/);
        expect(outside.match(/<\/(?:script|style)>/g)).toHaveLength(1);
      }
    });
    it("writes a literal markup prop on a dynamic string tag as an escaped attribute", () => {
      const inner = get("dynamicLiteralInnerHtml");
      expect(inner.error).toBeUndefined();
      expect(markup(inner.html)).not.toContain("<b>");
      expect(inner.html).toContain('innerhtml="');
      const style = get("dynamicLiteralStyleText");
      expect(style.error).toBeUndefined();
      expect(markup(style.html)).not.toContain("<b>");
      expect(style.html).toContain('textcontent="');
      expect(markup(style.html).match(/<\/style>/g)).toHaveLength(1);
    });
    it("keeps the <html-script> body over a spread's text keys", () => {
      expect(get("scriptTextSpreadBody").html).toContain("var a = 1;");
    });
    it("never lets a spread's object children reach Solid's node path", () => {
      for (const name of ["childrenObjectSpread", "childrenArraySpread"]) {
        const { error, html } = get(name);
        expect(error).toBeUndefined();
        expect(markup(html)).not.toContain("<b>");
      }
    });
    it("never lets a literal children= reach Solid's node path", () => {
      for (const name of [
        "literalChildrenObject",
        "literalChildrenArray",
        "dynamicLiteralChildrenObject",
      ]) {
        const { error, html } = get(name);
        expect(error, name).toBeUndefined();
        expect(markup(html), name).not.toContain("<b>");
      }
    });
    it("keeps a literal text children= as escaped text", () => {
      const { error, html } = get("literalChildrenText");
      expect(error).toBeUndefined();
      expect(html).toContain("hello &lt;i");
    });
    it("does not write a literal outerHTML= as markup", () => {
      const { error, html } = get("literalOuterHtml");
      expect(error).toBeUndefined();
      expect(markup(html)).not.toContain("<b>");
    });
    it("matches a dynamic script tag by its lowercase name", () => {
      const { error, html } = get("upperScriptTagSpread");
      expect(error).toBeUndefined();
      expect(html).not.toContain("alert(1)");
      expect(html).toContain('id="k"');
    });
    it("hides prop: text props on a dynamic script tag, as a spread or a literal", () => {
      for (const name of [
        "scriptPropTextSpread",
        "scriptPropTextLiteralDynamicTag",
      ]) {
        const { error, html } = get(name);
        expect(error, name).toBeUndefined();
        expect(html ?? "", name).not.toContain("alert(");
      }
      if (mode === "dom") {
        expect(get("scriptPropTextSpread").html).toContain('id="k"');
      }
    });
    it("leaves a spread's prop:textContent on other elements", () => {
      expect(get("divPropTextSpread").error).toBeUndefined();
    });
    it("keeps a spread's text children as escaped text", () => {
      const { error, html } = get("childrenTextSpread");
      expect(error).toBeUndefined();
      expect(html).toContain("hello &lt;i");
    });
    it("drops a null or false raw key", () => {
      const { error, html } = get("rawHtmlSpreadFalsy");
      expect(error).toBeUndefined();
      expect(html).not.toMatch(/innerhtml|outerhtml/i);
    });
    it("guards a dynamic tag's element target, not its component target", () => {
      const element = get("rawHtmlSpreadDynamicTag");
      expect(element.error).toBeUndefined();
      expect(markup(element.html)).not.toContain("<b>");
      expect(element.html).toContain('innerhtml="');
      const component = get("rawHtmlSpreadComponent");
      expect(component.error).toBeUndefined();
      expect(component.html).toMatch(/<p>&lt;b(&gt;|>)x&lt;\/b(&gt;|>)<\/p>/);
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
      '<div id="a" data-x="b" title="${input.t}" class="c"/>',
      { filename: "fixture.solid.mx" },
    );
    expect(code).not.toContain("__mxAttrValue");
    expect(hoistedDefines).toEqual([]);
  });
  it("routes a dynamic native class through the omit-when-falsy prop helper", () => {
    const { code, hoistedDefines } = compileSolidMx("<div class=input.c/>", {
      filename: "fixture.solid.mx",
    });
    expect(code).toContain('{...__mxClassProp(input.c, "div")}');
    expect(hoistedDefines.map((entry) => entry.binding)).toEqual([
      "__mxClassProp",
    ]);
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

// Solid asks the view for lowercase names only, so the camel-case guard is
// exercised against the helper itself.
describe("the spread view", () => {
  const view = (source: object, tag: string | null = "div") => {
    const js = transformSync(
      `function run(source: any, tag: any) {\n${ATTR_VALUE_HELPER}\n${ATTR_SPREAD_HELPER}\nreturn __mxAttrSpread(source, tag);\n}`,
      {
        filename: "view.ts",
        presets: [[typescriptPreset, {}]],
        babelrc: false,
        configFile: false,
      },
    )?.code;
    return new Function(`${js}\nreturn run;`)()(source, tag) as Record<
      string | symbol,
      unknown
    >;
  };

  it("hides the camel-case markup keys everywhere and lists the lowercase ones", () => {
    const v = view({
      innerHTML: "<b>",
      outerHTML: "<i>",
      textContent: "t",
      innerText: "u",
      "prop:innerHTML": "<b>",
      id: "k",
    });
    for (const key of [
      "innerHTML",
      "outerHTML",
      "textContent",
      "innerText",
      "prop:innerHTML",
    ]) {
      expect(v[key]).toBeUndefined();
      expect(key in v).toBe(false);
      expect(Object.getOwnPropertyDescriptor(v, key)).toBeUndefined();
    }
    expect(Object.keys(v).sort()).toEqual([
      "id",
      "innerhtml",
      "innertext",
      "outerhtml",
      "textcontent",
    ]);
    expect(v.innerhtml).toBe("<b>");
    expect({ ...v }).toMatchObject({ innerhtml: "<b>", id: "k" });
  });

  it("hides children unless it is a primitive on a tag that escapes it", () => {
    expect(view({ children: "t" }).children).toBe("t");
    expect(view({ children: { t: "<b>" } }).children).toBeUndefined();
    expect(view({ children: [1] }).children).toBeUndefined();
    expect(view({ children: "t" }, "script").children).toBeUndefined();
    expect("children" in view({ children: "t" }, "style")).toBe(false);
  });

  it("compares the tag by its lowercase name", () => {
    for (const tag of ["SCRIPT", "Style", "sCrIpT"]) {
      expect(view({ children: "t" }, tag).children).toBeUndefined();
      for (const key of ["prop:textContent", "prop:innerText", "prop:text"]) {
        const v = view({ [key]: "t", id: "k" }, tag);
        expect(v[key]).toBeUndefined();
        expect(key in v).toBe(false);
        expect(Object.keys(v)).toEqual(["id"]);
      }
    }
  });

  it("keeps prop: text props on other tags", () => {
    const v = view({ "prop:textContent": "t" }, "div");
    expect(v["prop:textContent"]).toBe("t");
  });

  it("is the source itself for a component target", () => {
    const source = { innerHTML: "<b>" };
    expect(view(source, null)).toBe(source);
  });
});

// TypeScript cannot spread `unknown`, string, number or boolean. The guards'
// declared result is what a native element's `{...guard(x)}` is checked
// against, so it must be an object type for every input (mx-tsc
// `attr-guard-solid.test.ts` runs the real check).
describe("spread guard result type", () => {
  it.each([
    ["__mxAttrSpread", ATTR_SPREAD_HELPER],
    ["__mxTextareaOmit", TEXTAREA_OMIT_HELPER],
    ["__mxTextareaDynSpread", TEXTAREA_DYN_SPREAD_HELPER],
  ])("%s returns T for an object and {} otherwise", (name, helper) => {
    expect(helper).toMatch(
      new RegExp(
        `function ${name}<T,>\\([^)]*\\): T extends object \\? T : \\{\\} \\{`,
      ),
    );
  });
});
