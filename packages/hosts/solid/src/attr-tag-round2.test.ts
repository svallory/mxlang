import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import { sourceBindings } from "@mxlang/parser";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
const prelude =
  'import { For, Show, Switch, Match, Repeat, Errored, Loading, createSignal, flush } from "solid-js"; import { Dynamic, render, renderToString } from "@solidjs/web";\n';

const domShim = String.raw`
class N {
  constructor(type) { this.nodeType = type; this.parentNode = null; }
  get nextSibling() { if (!this.parentNode) return null; const i = this.parentNode.childNodes.indexOf(this); return this.parentNode.childNodes[i + 1] || null; }
  get previousSibling() { if (!this.parentNode) return null; const i = this.parentNode.childNodes.indexOf(this); return this.parentNode.childNodes[i - 1] || null; }
  remove() { if (!this.parentNode) return; const i = this.parentNode.childNodes.indexOf(this); if (i >= 0) this.parentNode.childNodes.splice(i, 1); this.parentNode = null; }
}
class P extends N {
  constructor(name, type = 1) { super(type); this.localName = name; this.childNodes = []; }
  get nodeName() { return this.localName.toUpperCase(); }
  get tagName() { return this.nodeName; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get textContent() { return this.childNodes.map(n => n.textContent).join(""); }
  set textContent(v) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = v === "" ? [] : [new T(v)]; if (this.childNodes[0]) this.childNodes[0].parentNode = this; }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, marker) { n.remove(); const i = marker ? this.childNodes.indexOf(marker) : this.childNodes.length; this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n); n.parentNode = this; return n; }
  replaceChild(next, prev) { const i = this.childNodes.indexOf(prev); if (i < 0) return this.appendChild(next); next.remove(); this.childNodes[i] = next; next.parentNode = this; prev.parentNode = null; return prev; }
  cloneNode(deep = false) { const copy = new P(this.localName, this.nodeType); if (deep) for (const n of this.childNodes) copy.appendChild(n.cloneNode(true)); return copy; }
  addEventListener() {}
  removeEventListener() {}
}
class T extends N {
  constructor(data, type = 3) { super(type); this.data = String(data); }
  get nodeValue() { return this.data; }
  get textContent() { return this.nodeType === 8 ? "" : this.data; }
  set textContent(v) { this.data = String(v); }
  cloneNode() { return new T(this.data, this.nodeType); }
}
class F extends P { constructor() { super("#fragment", 11); } cloneNode(deep = false) { const copy = new F(); if (deep) for (const n of this.childNodes) copy.appendChild(n.cloneNode(true)); return copy; } }
class Template extends P {
  constructor() { super("template"); this.content = new F(); }
  set innerHTML(html) {
    this.content.textContent = "";
    const stack = [this.content];
    for (const token of html.match(/<!>|<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|[^<]+/g) || []) {
      const parent = stack[stack.length - 1];
      if (token === "<!>") parent.appendChild(new T("", 8));
      else if (token.startsWith("<!--")) parent.appendChild(new T(token.slice(4, -3), 8));
      else if (token.startsWith("</")) stack.pop();
      else if (token.startsWith("<")) { const name = token.match(/^<([A-Za-z][\w-]*)/)[1]; const el = new P(name.toLowerCase()); parent.appendChild(el); if (!token.endsWith("/>")) stack.push(el); }
      else parent.appendChild(new T(token));
    }
  }
  get innerHTML() { return ""; }
}
const document = {
  createElement(name) { return name === "template" ? new Template() : new P(name); },
  createTextNode(value) { return new T(value); },
  createComment(value) { return new T(value, 8); }
};
globalThis.document = document;
`;

interface Fixture {
  callee?: string;
  region: string;
  setup?: string;
  steps?: string;
}

function transform(source: string, filename: string, mode: "dom" | "ssr") {
  const result = transformSync(source, {
    filename,
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate: mode, hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!result?.code) throw new Error(`Solid transform produced no ${filename}`);
  return result.code;
}

function runFixture(fixture: Fixture, mode: "dom" | "ssr"): unknown {
  const dir = mkdtempSync(join(packageRoot, ".attr-round2-"));
  try {
    const importSpecifiers = new Map<string, string>();
    let rowImport = "";
    if (fixture.callee !== undefined) {
      const calleePath = join(dir, "Row.mx");
      writeFileSync(calleePath, fixture.callee);
      const callee = compileSolidUnit(fixture.callee, {
        filename: calleePath,
      }).code;
      writeFileSync(
        join(dir, "Row.mjs"),
        transform(`${prelude}${callee}`, "Row.tsx", mode),
      );
      importSpecifiers.set("Row", "./Row.mx");
      rowImport = 'import Row from "./Row.tsx";\n';
    }
    const compiled = compileSolidMx(fixture.region, {
      filename: join(dir, "caller.solid.mx"),
      importSpecifiers,
      // The real pipeline compiles a region in the context of its whole
      // surrounding module (`@mxlang/parser`'s `parse()`); this test compiles
      // the region standalone and splices `fixture.setup` in only afterward,
      // at runtime, so the two steps must agree on what that setup binds.
      moduleBindings: sourceBindings(fixture.setup ?? ""),
    });
    const imports = compiled.hoistedImports
      .map((entry) => entry.code)
      .join("\n");

    const execute =
      mode === "dom"
        ? `const root = document.createElement("root"); const values = []; render(() => ${compiled.code}, root); values.push(root.textContent); ${fixture.steps ?? ""} console.log(JSON.stringify(values));`
        : `console.log(JSON.stringify(renderToString(() => ${compiled.code})));`;
    const entry = transform(
      `${prelude}${imports}\n${rowImport}${fixture.setup ?? ""}\n${execute}`,
      "entry.tsx",
      mode,
    ).replace('from "./Row.tsx"', 'from "./Row.mjs"');
    const runner = join(dir, "entry.mjs");
    writeFileSync(runner, `${mode === "dom" ? domShim : ""}\n${entry}`);
    const output = execFileSync(
      "bun",
      mode === "dom"
        ? ["--conditions=browser", "run", runner]
        : ["run", runner],
      { cwd: packageRoot, encoding: "utf8" },
    ).trim();
    return JSON.parse(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Solid attribute-tag round-two runtime regressions", () => {
  const malicious = "<img src=x onerror=alert(1)>&amp;";

  const escapingFixture: Fixture = {
    callee: `export interface Input {
v: string;
dataOnly: AttrTag;
dataMixed: AttrTag;
renderOnly: AttrTag<{ as: "renderable" }>;
renderMixed: AttrTag<{ as: "renderable" }>;
dataParamOnly: AttrTag<{ params: [value: string] }>;
dataParamMixed: AttrTag<{ params: [value: string] }>;
renderParamOnly: AttrTag<{ as: "renderable"; params: [value: string] }>;
renderParamMixed: AttrTag<{ as: "renderable"; params: [value: string] }>;
}
<div><\${input.dataOnly.content}/>|<\${input.dataMixed.content}/>|<\${input.renderOnly}/>|<\${input.renderMixed}/>|<\${input.dataParamOnly.content}(input.v)/>|<\${input.dataParamMixed.content}(input.v)/>|<\${input.renderParamOnly}(input.v)/>|<\${input.renderParamMixed}(input.v)/></div>`,
    region: `<Row v=malicious><@dataOnly>\${malicious}</@dataOnly><@dataMixed>a\${malicious}</@dataMixed><@renderOnly>\${malicious}</@renderOnly><@renderMixed>a\${malicious}</@renderMixed><@dataParamOnly|value|>\${value}</@dataParamOnly><@dataParamMixed|value|>a\${value}</@dataParamMixed><@renderParamOnly|value|>\${value}</@renderParamOnly><@renderParamMixed|value|>a\${value}</@renderParamMixed></Row>`,
    setup: `const malicious = ${JSON.stringify(malicious)};`,
  };

  it("escapes placeholder-only and mixed values in every SSR shape", () => {
    const html = runFixture(escapingFixture, "ssr") as string;
    expect(html).not.toContain("<img");
    expect(html.match(/&lt;img/g)).toHaveLength(8);
  });

  it("keeps the same placeholder-only and mixed values as client text", () => {
    const text = (runFixture(escapingFixture, "dom") as string[])[0] ?? "";
    expect(text.match(/<img/g)).toHaveLength(8);
    expect(text).not.toContain("&lt;img");
  });

  it("keeps placeholder-only Dynamic accessors reactive", () => {
    const values = runFixture(
      {
        callee: `export interface Input { data: AttrTag; renderable: AttrTag<{ as: "renderable" }> }
<div><\${input.data.content}/><\${input.renderable}/></div>`,
        region: `<Row><@data>\${label()}</@data><@renderable>\${label()}</@renderable></Row>`,
        setup: 'const [label, setLabel] = createSignal("A");',
        steps: 'setLabel("B"); flush(); values.push(root.textContent);',
      },
      "dom",
    );
    expect(values).toEqual(["AA", "BB"]);
  });

  it("gives untyped Solid built-ins renderable fallback accessors", () => {
    const code = compileSolidMx(
      `<div><Show when=false><@fallback>show</@fallback>x</Show><Loading><@fallback>loading</@fallback>x</Loading><Errored><@fallback|e, reset|>error</@fallback>x</Errored></div>`,
      { filename: "builtins.solid.mx" },
    ).code.replace(/\s+/g, " ");
    expect(code).toContain("<Show when={false} fallback={() => <>show</>}");
    expect(code).toContain("<Loading fallback={() => <>loading</>}");
    expect(code).toContain(
      "<Errored fallback={(e, reset) => () => <>error</>}",
    );
    expect(code).not.toContain("fallback={{ content:");
  });

  it.each(["ssr", "dom"] as const)(
    "renders and escapes Show's untyped fallback accessor in %s mode",
    (mode) => {
      const result = runFixture(
        {
          region: `<Show when=false><@fallback>\${malicious}</@fallback><b>child</b></Show>`,
          setup: `const malicious = ${JSON.stringify(malicious)};`,
        },
        mode,
      );
      if (mode === "ssr") {
        expect(result as string).not.toContain("<img");
        expect(result as string).toContain("&lt;img");
      } else expect(result).toEqual([malicious]);
    },
  );

  it.each(["ssr", "dom"] as const)(
    "renders Loading's untyped fallback accessor in %s mode",
    (mode) => {
      const result = runFixture(
        {
          region: `<Loading><@fallback><span>loading fallback</span></@fallback><Pending/></Loading>`,
          setup: `function Pending() { const [value] = createSignal(async () => await new Promise(() => {})); return <span>{value()}</span>; }`,
        },
        mode,
      );
      if (mode === "ssr")
        expect(result as string).toContain("<span>loading fallback</span>");
      else expect(result).toEqual(["loading fallback"]);
    },
  );

  it.each(["ssr", "dom"] as const)(
    "renders Errored's parameterized untyped fallback accessor in %s mode",
    (mode) => {
      const result = runFixture(
        {
          region: `<Errored><@fallback|e, reset|><span>error:\${e().message}:\${typeof reset}</span></@fallback><Boom/></Errored>`,
          setup: `function Boom() { throw new Error("boom"); }`,
        },
        mode,
      );
      if (mode === "ssr")
        expect(result as string).toContain("<span>error:boom:function</span>");
      else expect(result).toEqual(["error:boom:function"]);
    },
  );

  it("escapes placeholder-only <if>/<for> bodies in SSR and preserves client text", () => {
    const fixture: Fixture = {
      callee: `<div><if=input.ok>\${input.value}</if>|<for|value| of=input.values>\${value}</for></div>`,
      region: `<Row ok=true value=malicious values=[malicious]/>`,
      setup: `const malicious = ${JSON.stringify(malicious)};`,
    };
    const html = runFixture(fixture, "ssr") as string;
    expect(html).not.toContain("<img");
    expect(html.match(/&lt;img/g)).toHaveLength(2);
    expect(runFixture(fixture, "dom")).toEqual([`${malicious}|${malicious}`]);
  });

  it("renders nothing for a nullish of=/in=, matching Marko, in content and attribute-tag loops", () => {
    const fixture: Fixture = {
      callee: `export interface Input { item: AttrTag<{ attrs: { id: number } }>[] }
<div><for|it| of=input.item>[<\${it.content}/>]</for></div>`,
      region:
        "<Row><for|x| of=list><@item id=x>x</@item></for><for|k| in=obj><@item id=1>k</@item></for></Row>",
      setup: "const list = undefined; const obj = null;",
    };
    expect(runFixture(fixture, "ssr")).toBe("<div></div>");
    expect(
      runFixture(
        {
          region:
            "<div><for|x| of=undefined><b>x</b></for><for|k, v| in=null><b>kv</b></for></div>",
        },
        "ssr",
      ),
    ).toBe("<div></div>");
  });

  it("renders nothing for a falsy (non-nullish) of= attribute tag, matching Marko", () => {
    const fixture: Fixture = {
      callee: `export interface Input { item: AttrTag<{ attrs: { id: number } }>[] }
<div><for|it| of=input.item>[<\${it.content}/>]</for></div>`,
      region: "<Row><for|x| of=list><@item id=x>x</@item></for></Row>",
      setup: "const list = false as unknown;",
    };
    expect(runFixture(fixture, "ssr")).toBe("<div></div>");
  });

  it("applies dynamic tag arguments to parameterized content", () => {
    const fixture: Fixture = {
      callee: `export interface Input { value: AttrTag<{ params: [label: string] }> }
<div><\${input.value.content}("called")/></div>`,
      region: `<Row><@value|label|><b>\${label}</b></@value></Row>`,
    };
    expect(runFixture(fixture, "ssr")).toBe("<div><b>called</b></div>");
    expect(runFixture(fixture, "dom")).toEqual(["called"]);
  });

  it("throws the shared diagnostic for an untyped data value", () => {
    const fixture: Fixture = {
      callee: `<div><\${input.value}/></div>`,
      region: `<Row><@value tone="hot">x</@value></Row>`,
    };
    expect(() => runFixture(fixture, "ssr")).toThrow(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exact runtime diagnostic quotes MX dynamic-tag syntax
      "MX: this value is a data attribute tag ({ ...attrs, content }); render its body with <${x.content}/>",
    );
  });
});
