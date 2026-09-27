import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

// Tiny DOM sufficient for Solid's generated templates/insertion algorithm.
// Keeping it local avoids adding a DOM-emulator dependency just for this one
// client-runtime reactivity assertion.
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

it("keeps accessor content and signal-backed arrays reactive in the client runtime", () => {
  const dir = mkdtempSync(join(packageRoot, ".attr-reactivity-"));
  try {
    const callee = join(dir, "Row.tsx");
    writeFileSync(
      callee,
      'import type { AttrTag } from "@mxlang/solid"; export interface Input { item: AttrTag[] }',
    );
    const compiled = compileSolidMx(
      `<Row><for|value| of=items()><@item>\${value}:\${label()}</@item></for></Row>`,
      {
        filename: join(dir, "caller.solid.mx"),
        importSpecifiers: new Map([["Row", "./Row.tsx"]]),
      },
    );
    const imports = compiled.hoistedImports
      .map((entry) => entry.code)
      .join("\n");
    const source = `
      ${imports}
      import { createSignal, flush, For } from "solid-js";
      import { Dynamic, render } from "@solidjs/web";
      const [items, setItems] = createSignal(["a"]);
      const [label, setLabel] = createSignal("A");
      function Row(input) { return <main><div>{input.item[0]?.content}{input.item[0]?.content}</div><div><Dynamic component={input.item[0]?.content}/></div><div><For each={input.item}>{item => <i>{item.content}</i>}</For></div></main>; }
      const root = document.createElement("root");
      render(() => ${compiled.code}, root);
      const before = root.textContent;
      setLabel("B"); setItems(["x", "y"]); flush();
      console.log(JSON.stringify({ before, after: root.textContent }));
    `;
    const transformed = transformSync(source, {
      filename: "reactivity.tsx",
      presets: [[typescriptPreset, {}]],
      plugins: [[solidBabelPlugin, { generate: "dom", hydratable: false }]],
      babelrc: false,
      configFile: false,
    });
    if (!transformed?.code) throw new Error("Solid transform produced no code");
    const runner = join(dir, "runner.mjs");
    writeFileSync(runner, `${domShim}\n${transformed.code}`);
    const output = execFileSync(
      "bun",
      ["--conditions=browser", "run", runner],
      { cwd: packageRoot, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      before: "a:Aa:Aa:Aa:A",
      after: "x:Bx:Bx:Bx:By:B",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
