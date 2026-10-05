import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import { sourceBindings, unknownSourceBindings } from "@mxlang/parser";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
const SUBPROCESS_TIMEOUT_MS = 15_000;

/**
 * `solid-client-render-harness` (TODO.md, triage-2026-09-28). Every other
 * render test in this package (`ssr-render.test.ts`) proves the emitted
 * `<For>`/`<Repeat>` binding renders the *right shape once*, server-side.
 * None of them prove a live signal write actually reaches the DOM — the
 * accessor-read rewrite `rewriteAccessorReads` performs
 * (`packages/hosts/solid/README.md`'s "`<for>` bodies read the row as a
 * value" section) exists specifically so a same-key row replacement stays
 * reactive under Solid 2's `keyed`/unkeyed `<For>` forms; only a real client
 * render, mutate, re-check cycle can catch a regression there. This file is
 * that harness: `compileSolidMx` -> Solid JSX text -> `@solidjs/babel-plugin`
 * DOM (client) codegen, not SSR -> mounted into a real DOM via `jsdom`,
 * inside a Bun subprocess with `--conditions=browser` forced (below), then a
 * signal write and a re-check of the live DOM.
 *
 * Confirmed regression-detecting: reverting `rewriteAccessorReads`
 * (`packages/core/src/accessor-reads.ts`) locally to an unconditional early
 * return, then rebuilding `@mxlang/core` (its `dist/` is what
 * `@mxlang/solid` resolves — see this package's own CLAUDE.md on stale
 * `dist/` failing silently), fails three of the four tests below with a real
 * client-side crash inside `@solidjs/signals`' `mapArray`/`updateKeyedMap`,
 * not a silently-wrong render: the row body still reads the accessor as a
 * plain object (`row.name` on a function), which Solid's own reactive core
 * throws on rather than stringifying quietly. Restored immediately after
 * confirming, and `@mxlang/core` rebuilt again.
 *
 * **jsdom, not happy-dom.** Both were tried. happy-dom throws inside
 * `@solidjs/web`'s own `insertExpression` on the very first client render of
 * a template with a reactive text child (`parent.firstChild.data = value`
 * against a `null` `firstChild` — happy-dom's initial `template()` clone
 * does not create the placeholder text node Solid's DOM codegen expects to
 * already be there) — a real incompatibility, not a config gap; jsdom does
 * not have this problem and renders the placeholder correctly. Neither
 * package existed anywhere in this repo before this file; jsdom is the one
 * that renders Solid 2's client codegen correctly, so it is the harness's
 * pinned `devDependency`. `happy-dom` is not added.
 *
 * **`--conditions=browser` is required, in the subprocess only.**
 * `@solidjs/web`'s (and `solid-js`'s own) `package.json#exports` branch on a
 * `worker`/`browser`/`deno`/`node` condition key, and Bun's *default*
 * runtime condition is `node` — which resolves to each package's
 * *server*-targeted build (`server.js`/`server.js`) even for a script that
 * imports nothing server-specific, so the DOM codegen's own
 * `import { template, insert } from "@solidjs/web"` silently loads the SSR
 * build instead of the client one without this flag. Passed to the `bun run`
 * subprocess exactly the way `ssr-render.test.ts`'s own `renderApp` passes
 * no special flag for its (correctly `node`-conditioned) SSR case — same
 * subprocess-isolation reasoning: vitest's own SSR module resolution does
 * not walk up to this workspace's bun-managed `node_modules/.bun`, so a
 * dynamic `import()` of `@solidjs/web` from a plain tmp file fails to
 * resolve its own `seroval` dependency there. Running an ordinary `bun run`
 * (no flag) resolves the workspace's real dependency graph but the *wrong*
 * package build; `--conditions=browser` fixes that half without breaking
 * the other.
 */
function renderSolidMxDom(mxFragment: string, setup: string): string {
  const {
    code: forCode,
    hoistedImports,
    hoistedDefines,
  } = compileSolidMx(mxFragment, {
    filename: "fixture.solid.mx",
    moduleBindings: sourceBindings(setup).bindings,
    unknownModuleBindings: unknownSourceBindings(setup),
  });
  const imports = [...hoistedImports, ...hoistedDefines]
    .map((entry) => entry.code)
    .join("\n");
  const jsxSource = `${imports}\nimport { createSignal } from "solid-js";\nexport function App() {\n  ${setup}\n  return <ul>${forCode}</ul>;\n}\n`;

  const dom = transformSync(jsxSource, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate: "dom", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!dom?.code)
    throw new Error("Solid babel plugin produced no DOM code for fixture.tsx");
  return dom.code;
}

/**
 * Mounts the compiled client module into a real jsdom document (a Bun
 * subprocess, `--conditions=browser` — see the file doc comment), applies
 * each of `mutations` in order (one signal write per entry), and returns the
 * container's `innerHTML` after the initial render and after each mutation
 * has flushed (Solid 2's scheduler batches a write through a microtask, so
 * the runner awaits one tick after each write before reading — confirmed
 * necessary: reading synchronously still shows the pre-write DOM). Each
 * surviving `<li>` is stamped with a `data-mx-node-id` on first creation
 * (never re-stamped), so a test can assert the same row's element identity
 * survived a write by comparing that id's presence rather than the node
 * object itself, which cannot cross the subprocess boundary.
 */
function renderDomApp(
  mxFragment: string,
  setup: string,
  setterGlobal: string,
  mutations: readonly string[],
): { snapshots: string[] } {
  const code = renderSolidMxDom(mxFragment, setup);
  const dir = mkdtempSync(join(packageRoot, ".client-render-tmp-"));
  const appPath = join(dir, "app.mjs");
  const runnerPath = join(dir, "run.mjs");
  writeFileSync(appPath, code);
  writeFileSync(
    runnerPath,
    [
      'import { JSDOM } from "jsdom";',
      'const dom = new JSDOM("<!DOCTYPE html><body></body>");',
      "globalThis.window = dom.window;",
      "globalThis.document = dom.window.document;",
      "globalThis.HTMLElement = dom.window.HTMLElement;",
      "globalThis.Node = dom.window.Node;",
      "globalThis.Text = dom.window.Text;",
      "globalThis.Comment = dom.window.Comment;",
      "globalThis.DocumentFragment = dom.window.DocumentFragment;",
      'const { render } = await import("@solidjs/web");',
      'const { App } = await import("./app.mjs");',
      'const container = document.createElement("div");',
      "document.body.appendChild(container);",
      "render(() => App(), container);",
      "let nextNodeId = 0;",
      "const stampNodeIds = () => {",
      "  for (const li of container.querySelectorAll('li:not([data-mx-node-id])')) {",
      "    li.setAttribute('data-mx-node-id', String(nextNodeId++));",
      "  }",
      "};",
      "stampNodeIds();",
      "const snapshots = [container.innerHTML];",
      `const mutations = ${JSON.stringify(mutations)};`,
      "for (const mutation of mutations) {",
      `  globalThis.${setterGlobal}(new Function('return (' + mutation + ')')());`,
      "  await new Promise((r) => setTimeout(r, 0));",
      "  stampNodeIds();",
      "  snapshots.push(container.innerHTML);",
      "}",
      "process.stdout.write(JSON.stringify({ snapshots }));",
    ].join("\n"),
  );
  try {
    const output = execFileSync(
      "bun",
      ["run", "--conditions=browser", runnerPath],
      { cwd: packageRoot, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS },
    );
    return JSON.parse(output) as { snapshots: string[] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Non-asserting positional access for a fixed-length snapshot array. */
function snapshotAt(snapshots: readonly string[], index: number): string {
  const value = snapshots[index];
  if (value === undefined) {
    throw new Error(
      `expected a snapshot at index ${index}, got ${snapshots.length} total`,
    );
  }
  return value;
}

/** Extracts `data-mx-node-id="N"` for the `<li>` whose text is `needle`. */
function nodeIdFor(html: string, needle: string): string {
  const re = new RegExp(
    `<li data-mx-node-id="(\\d+)">[^<]*${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  const match = html.match(re);
  if (!match) throw new Error(`no <li> containing ${needle} in: ${html}`);
  return match[1] as string;
}

describe("Solid client render: live signal updates through the real DOM", () => {
  it("renders a textarea's value as content on the client without the server's doubled leading newline", () => {
    // A doubled client render would serialize as `\n\nx`.
    const { snapshots } = renderDomApp(
      '<textarea value=input.v/><textarea ...input.attrs class="c"/>',
      'const input = { v: "\\nx", attrs: { value: "\\nx" } };',
      "unused",
      [],
    );
    expect(snapshots).toEqual([
      '<ul><textarea>\nx</textarea><textarea class="c">\nx</textarea></ul>',
    ]);
  });

  it("renders a reactive class and a spread class/style as Marko does through live writes", () => {
    const { snapshots } = renderDomApp(
      "<p class=v()/><p ...{class: v(), style: v()}/>",
      'const [v, setV] = createSignal<unknown>("a"); (globalThis as any).setV = setV;',
      "setV",
      ['"x"', "false", "0", "true", "null", '""'],
    );
    const classes = snapshots.map((html) => html.match(/<p[^>]*><\/p>/g));
    // Client DOM writes `style` through the CSSOM, so a string that is no CSS
    // declaration (`a`, `x`, `true`) leaves `style=""` where Marko's SSR prints
    // the text; falsy values are omitted as in Marko.
    expect(classes).toEqual([
      ['<p class="a"></p>', '<p class="a" style=""></p>'],
      ['<p class="x"></p>', '<p class="x" style=""></p>'],
      ["<p></p>", "<p></p>"],
      ["<p></p>", "<p></p>"],
      ['<p class="true"></p>', '<p class="true" style=""></p>'],
      ["<p></p>", "<p></p>"],
      ["<p></p>", "<p></p>"],
    ]);
  });
  it("preserves empty and multi-colon attribute names through JSX prop spreads", () => {
    const { snapshots } = renderDomApp(
      '<div :/><div value:foo:bar="y"/><div value:foo:baz=input.v/><div x:/><div x: = "s"/><div x: = input.v/>',
      'const input = { v: "hello" };',
      "unused",
      [],
    );
    expect(snapshots).toEqual([
      '<ul><div value:=""></div><div value:foo:bar="y"></div><div value:foo:baz="hello"></div><div x:=""></div><div x:="s"></div><div x:="hello"></div></ul>',
    ]);
  });
  it('re-renders a same-key row replacement under <for by="id">, keeping the surviving row\'s own DOM node and reacting to a value change on it', () => {
    const { snapshots } = renderDomApp(
      '<for|row| of=input.rows() by="id"><li>${row.name}</li></for>',
      [
        "const [rows, setRows] = createSignal([",
        '  { id: 1, name: "Ada" },',
        '  { id: 2, name: "Grace" },',
        "]);",
        "const input = { rows };",
        "globalThis.__setRows = setRows;",
      ].join("\n"),
      "__setRows",
      [
        '[{ id: 2, name: "Grace" }, { id: 3, name: "New" }]',
        '[{ id: 2, name: "Dr. Grace" }, { id: 3, name: "New" }]',
      ],
    );
    const initial = snapshotAt(snapshots, 0);
    const afterReplace = snapshotAt(snapshots, 1);
    const afterValueChange = snapshotAt(snapshots, 2);
    expect(initial).toBe(
      '<ul><li data-mx-node-id="0">Ada</li><li data-mx-node-id="1">Grace</li></ul>',
    );
    expect(afterReplace).toBe(
      '<ul><li data-mx-node-id="1">Grace</li><li data-mx-node-id="2">New</li></ul>',
    );

    // Node identity: the surviving key (id 2)'s <li> is the same DOM element
    // across the row-replacement write, proven by its stamped id staying put.
    expect(nodeIdFor(afterReplace, "Grace")).toBe(nodeIdFor(initial, "Grace"));

    // Reactivity on the surviving row's own value: a same-key write that only
    // changes `name` must update that row's text live, through the same
    // element (the regression class `rewriteAccessorReads` guards — a stale
    // `const row = row$()` snapshot would never see this update).
    expect(afterValueChange).toBe(
      '<ul><li data-mx-node-id="1">Dr. Grace</li><li data-mx-node-id="2">New</li></ul>',
    );
    expect(nodeIdFor(afterValueChange, "Dr. Grace")).toBe(
      nodeIdFor(initial, "Grace"),
    );
  });

  it("re-renders a same-key row replacement under <for by=(fn)>, an explicit keying function", () => {
    const { snapshots } = renderDomApp(
      "<for|row| of=input.rows() by=(r) => r.id><li>${row.name}</li></for>",
      [
        "const [rows, setRows] = createSignal([",
        '  { id: 1, name: "Ada" },',
        '  { id: 2, name: "Grace" },',
        "]);",
        "const input = { rows };",
        "globalThis.__setRows = setRows;",
      ].join("\n"),
      "__setRows",
      ['[{ id: 2, name: "Grace" }, { id: 3, name: "New" }]'],
    );
    const initial = snapshotAt(snapshots, 0);
    const after = snapshotAt(snapshots, 1);
    expect(initial).toBe(
      '<ul><li data-mx-node-id="0">Ada</li><li data-mx-node-id="1">Grace</li></ul>',
    );
    expect(after).toBe(
      '<ul><li data-mx-node-id="1">Grace</li><li data-mx-node-id="2">New</li></ul>',
    );
    expect(nodeIdFor(after, "Grace")).toBe(nodeIdFor(initial, "Grace"));
  });

  it("re-renders an unkeyed <for> (of=, no by=) after a signal write, reading the row as a value", () => {
    const { snapshots } = renderDomApp(
      "<for|row| of=input.rows()><li>${row.name}</li></for>",
      [
        "const [rows, setRows] = createSignal([",
        '  { name: "Ada" },',
        '  { name: "Grace" },',
        "]);",
        "const input = { rows };",
        "globalThis.__setRows = setRows;",
      ].join("\n"),
      "__setRows",
      ['[{ name: "Grace" }, { name: "New" }]'],
    );
    const initial = snapshotAt(snapshots, 0);
    const after = snapshotAt(snapshots, 1);
    expect(initial).toBe(
      '<ul><li data-mx-node-id="0">Ada</li><li data-mx-node-id="1">Grace</li></ul>',
    );
    expect(after).toBe(
      '<ul><li data-mx-node-id="2">Grace</li><li data-mx-node-id="3">New</li></ul>',
    );
  });

  it("re-renders a <for in=> (key/value entries) after a signal write", () => {
    const { snapshots } = renderDomApp(
      "<for|k, v| in=input.obj()><li>${k}:${v}</li></for>",
      [
        'const [obj, setObj] = createSignal({ a: "1", b: "2" });',
        "const input = { obj };",
        "globalThis.__setObj = setObj;",
      ].join("\n"),
      "__setObj",
      ['{ b: "2", c: "3" }'],
    );
    const [initial, after] = snapshots;
    // `in=` entries get a marker comment beside each row, part of Solid's
    // own fine-grained DOM bookkeeping for a keyed `<For>` (unrelated to
    // this fix; present in every `in=` render, not just this test).
    expect(initial).toBe(
      '<ul><li data-mx-node-id="0">a:1<!----></li><li data-mx-node-id="1">b:2<!----></li></ul>',
    );
    expect(after).toBe(
      '<ul><li data-mx-node-id="1">b:2<!----></li><li data-mx-node-id="2">c:3<!----></li></ul>',
    );
  });
});
