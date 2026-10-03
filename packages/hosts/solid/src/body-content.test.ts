import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import { createTargetLookup, getCustomTags } from "@mxlang/core";
import { sourceBindings } from "@mxlang/parser";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import cases from "../../../../test-fixtures/body-whitespace/cases.json";
import descriptor from "./descriptor.ts";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

/**
 * The body channel on Solid: a Marko template reads its body as
 * `input.content` (`<${input.content}/>`), while a Solid component receives
 * it as `props.children`. Every test here EXECUTES the rendered output
 * (SSR through `renderToString`, client through a DOM shim) rather than
 * asserting emitted text, because the original defect was silent: it
 * compiled cleanly and rendered nothing.
 */
const packageRoot = new URL("..", import.meta.url).pathname;
const prelude =
  'import { For, Show, createSignal, flush } from "solid-js"; import { Dynamic, render, renderToString } from "@solidjs/web";\n';

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
  /** MX tag units, by name, each compiled with `compileSolidUnit`. */
  units: Record<string, string>;
  /** Discover the units as tags/*.mx rather than importing them. */
  discovered?: boolean;
  /** Hand-written TSX components, by name (default exports). */
  tsx?: Record<string, string>;
  /** An MX region, compiled by `compileSolidMx` (the mx-caller case). */
  region?: string;
  /** Raw TSX expression instead of `region` (the plain-Solid-caller case). */
  expression?: string;
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

function run(fixture: Fixture, mode: "dom" | "ssr"): string[] {
  const dir = mkdtempSync(join(packageRoot, ".body-content-"));
  try {
    const importSpecifiers = new Map<string, string>();
    const importDefaultFromMarkoOrMx = new Set<string>();
    let imports = "";
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    if (fixture.discovered) mkdirSync(join(dir, "tags"));
    for (const [name, source] of Object.entries(fixture.units)) {
      const base = fixture.discovered ? `tags/${name}` : name;
      const path = join(dir, `${base}.mx`);
      writeFileSync(path, source);
      const code = compileSolidUnit(source, { filename: path }).code;
      writeFileSync(
        join(dir, `${base}.mjs`),
        transform(`${prelude}${code}`, `${name}.tsx`, mode).replace(
          /from "\.\/(\w+)\.(?:tsx|mx)"/g,
          'from "./$1.mjs"',
        ),
      );
      if (!fixture.discovered) {
        importSpecifiers.set(name, `./${name}.mx`);
        importDefaultFromMarkoOrMx.add(name);
        imports += `import ${name} from "./${name}.mjs";\n`;
      }
    }
    for (const [name, source] of Object.entries(fixture.tsx ?? {})) {
      writeFileSync(
        join(dir, `${name}.mjs`),
        transform(`${prelude}${source}`, `${name}.tsx`, mode),
      );
      importSpecifiers.set(name, `./${name}.tsx`);
      imports += `import ${name} from "./${name}.mjs";\n`;
    }
    let expression = fixture.expression ?? "null";
    let hoisted = "";
    if (fixture.region !== undefined) {
      const compiled = compileSolidMx(fixture.region, {
        filename: join(dir, "caller.solid.mx"),
        importSpecifiers,
        importDefaultFromMarkoOrMx,
        moduleBindings: sourceBindings(fixture.setup ?? "").bindings,
        customTags: fixture.discovered
          ? getCustomTags(join(dir, "caller.solid.mx"), {
              targets: createTargetLookup([descriptor]),
            })
          : undefined,
      });
      expression = `<>${compiled.code}</>`;
      hoisted = compiled.hoistedImports.map((entry) => entry.code).join("\n");
    }
    const execute =
      mode === "dom"
        ? `const root = document.createElement("root"); const values = []; render(() => ${expression}, root); values.push(root.textContent); ${fixture.steps ?? ""} console.log(JSON.stringify(values));`
        : `console.log(JSON.stringify([renderToString(() => ${expression})]));`;
    const entry = transform(
      `${prelude}${hoisted}\n${imports}${fixture.setup ?? ""}\n${execute}`,
      "entry.tsx",
      mode,
    ).replace(/from "\.\/([\w/]+)\.(?:tsx|mx)"/g, 'from "./$1.mjs"');
    const runner = join(dir, "entry.mjs");
    writeFileSync(runner, `${mode === "dom" ? domShim : ""}\n${entry}`);
    const output = execFileSync(
      "bun",
      mode === "dom"
        ? ["--conditions=browser", "run", runner]
        : ["run", runner],
      { cwd: packageRoot, encoding: "utf8" },
    ).trim();
    return JSON.parse(output) as string[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ssr = (fixture: Fixture) => run(fixture, "ssr")[0] ?? "";
const strip = (html: string) => html.replace(/<!--[^>]*-->/g, "");

const Wrap = "<section><${input.content}/></section>";
const Outer = 'import Wrap from "./Wrap.mx"\n<Wrap><${input.content}/></Wrap>';

describe.each([false, true])(
  "body whitespace, decision 141 (discovered=%s)",
  (discovered) => {
    it.each(cases)("$label", ({ body, html }) => {
      const tag = discovered ? "wrap" : "Wrap";
      expect(
        strip(
          ssr({
            units: { [tag]: Wrap },
            region: `<${tag}>${body}</${tag}>`,
            discovered,
          }),
        ),
      ).toBe(`<section>${html}</section>`);
    });
  },
);

describe("Solid body channel: input.content carries the body", () => {
  it("forwards an element body", () => {
    expect(
      strip(ssr({ units: { Wrap }, region: "<Wrap><b>hi</b></Wrap>" })),
    ).toBe("<section><b>hi</b></section>");
  });

  it("forwards a text body as text, not as a tag", () => {
    expect(strip(ssr({ units: { Wrap }, region: "<Wrap>hello</Wrap>" }))).toBe(
      "<section>hello</section>",
    );
  });

  it("forwards a placeholder body as text", () => {
    expect(
      strip(
        ssr({
          units: { Wrap },
          region: "<Wrap>${word}</Wrap>",
          setup: 'const word = "<b>";',
        }),
      ),
    ).toBe("<section>&lt;b></section>");
  });

  it("forwards a mixed body", () => {
    expect(
      strip(ssr({ units: { Wrap }, region: "<Wrap>a<b>c</b>d</Wrap>" })),
    ).toBe("<section>a<b>c</b>d</section>");
  });

  it("renders nothing for no body", () => {
    expect(strip(ssr({ units: { Wrap }, region: "<Wrap/>" }))).toBe(
      "<section></section>",
    );
  });

  it("forwards a body through two units", () => {
    expect(
      strip(
        ssr({
          units: { Wrap, Outer },
          region: "<Outer><i>x</i></Outer>",
        }),
      ),
    ).toBe("<section><i>x</i></section>");
    expect(
      strip(
        ssr({
          units: { Wrap, Outer },
          region: "<Outer>text</Outer>",
        }),
      ),
    ).toBe("<section>text</section>");
  });

  it("takes the if branch only when a body is present", () => {
    const unit =
      "<if=input.content><p><${input.content}/></p></if><else>none</else>";
    expect(
      strip(ssr({ units: { Maybe: unit }, region: "<Maybe><b>y</b></Maybe>" })),
    ).toBe("<p><b>y</b></p>");
    expect(strip(ssr({ units: { Maybe: unit }, region: "<Maybe/>" }))).toBe(
      "none",
    );
  });

  it("keeps a reactive body updating on the client", () => {
    const values = run(
      {
        units: { Wrap },
        region: "<Wrap>${label()}</Wrap>",
        setup: 'const [label, setLabel] = createSignal("A");',
        steps: 'setLabel("B"); flush(); values.push(root.textContent);',
      },
      "dom",
    );
    expect(values).toEqual(["A", "B"]);
  });

  it("keeps a reactive element body updating on the client", () => {
    const values = run(
      {
        units: { Wrap },
        region: "<Wrap><b>${label()}</b></Wrap>",
        setup: 'const [label, setLabel] = createSignal("A");',
        steps: 'setLabel("B"); flush(); values.push(root.textContent);',
      },
      "dom",
    );
    expect(values).toEqual(["A", "B"]);
  });

  it("does not evaluate the body when the callee never reads it", () => {
    const values = run(
      {
        units: { Skip: "<p>skip</p>" },
        region: "<Skip>${read()}</Skip>",
        setup: "let reads = 0; const read = () => { reads++; return 'x'; };",
        steps: "values.push(String(reads));",
      },
      "dom",
    );
    expect(values).toEqual(["skip", "0"]);
  });
});

describe("Solid body channel: props.children keeps working", () => {
  it("serves a plain Solid TSX caller passing children to an MX tag", () => {
    expect(
      strip(
        ssr({
          units: { Wrap },
          expression: "<Wrap><b>hi</b></Wrap>",
        }),
      ),
    ).toBe("<section><b>hi</b></section>");
    expect(
      strip(ssr({ units: { Wrap }, expression: "<Wrap>hello</Wrap>" })),
    ).toBe("<section>hello</section>");
    expect(
      strip(ssr({ units: { Wrap }, expression: "<Wrap>{7}</Wrap>" })),
    ).toBe("<section>7</section>");
  });

  it("serves a plain Solid caller passing content= explicitly", () => {
    expect(
      strip(
        ssr({
          units: { Wrap },
          expression: "<Wrap content={<b>c</b>} />",
        }),
      ),
    ).toBe("<section><b>c</b></section>");
  });

  it("keeps a reactive plain-Solid caller body updating", () => {
    const values = run(
      {
        units: { Wrap },
        expression: "<Wrap>{label()}</Wrap>",
        setup: 'const [label, setLabel] = createSignal("A");',
        steps: 'setLabel("B"); flush(); values.push(root.textContent);',
      },
      "dom",
    );
    expect(values).toEqual(["A", "B"]);
  });

  it("serves a Solid-native consumer reading props.children from an MX caller", () => {
    const Native = "export default (props) => <div>{props.children}</div>;";
    expect(
      strip(
        ssr({
          units: {},
          tsx: { Native },
          region: "<Native><b>x</b></Native>",
        }),
      ),
    ).toBe("<div><b>x</b></div>");
    expect(
      strip(ssr({ units: {}, tsx: { Native }, region: "<Native>t</Native>" })),
    ).toBe("<div>t</div>");
  });

  it("serves an MX unit that also reads props through input", () => {
    const unit = "<h1>${input.title}</h1><${input.content}/>";
    expect(
      strip(
        ssr({
          units: { Card: unit },
          region: '<Card title="T"><p>b</p></Card>',
        }),
      ),
    ).toBe("<h1>T</h1><p>b</p>");
  });
});
