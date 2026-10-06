import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const require = createRequire(import.meta.url);

/**
 * Decision 167: an attribute method shorthand is a `function` / `async
 * function` expression, never an arrow. A regex over the printed function once
 * split it at the last `) {`, so a body holding its own `) {` emitted
 * `() { if (c) => { … } }`, which is not JavaScript. Each handler here is
 * rendered for real and fired.
 */
const BUTTONS: Record<string, string> = {
  ifBlock: "onClick() { if (input.on) { input.hit(1) } }",
  forBlock: "onClick() { for (const n of [2, 3]) { input.hit(n) } }",
  innerFunction:
    "onClick() { const add = function (n: number) { input.hit(n) }; add(4) }",
  innerArrow:
    "onClick(e: unknown) { [5].forEach((n) => { if (e) { input.hit(n) } }) }",
  asyncAwait:
    "async onClick() { await Promise.resolve(); if (input.on) { input.hit(7) } }",
  generic: "onClick<T>(e: T) { if (e) { input.hit(8) } }",
  named:
    "onClick=function tick(e: unknown, n = 0) { if (n < 2) { tick(e, n + 1) } else { input.hit(9) } }",
  ownThis: 'onClick() { input.hit(this.id === "mine" ? 10 : 0) }',
};

const SOURCE = `<div>${Object.entries(BUTTONS)
  .map(([id, method]) => `<button id="${id}" ${method}>${id}</button>`)
  .join("")}</div>`;

type Handler = (this: unknown, event?: unknown) => unknown;

/** Each `<button>` element's `onClick` in a rendered tree, by `id`. */
function handlersOf(tree: unknown): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props && typeof props.onClick === "function") {
      out[String(props.id)] = props.onClick as Handler;
    }
    visit(props?.children);
  };
  visit(tree);
  return out;
}

let handlers: Record<string, Handler> = {};
let hits: number[] = [];
let code = "";

beforeAll(async () => {
  const scratch = mkdtempSync(join(tmpdir(), "mx-preact-method-"));
  try {
    symlinkSync(
      dirname(dirname(require.resolve("preact/package.json"))),
      join(scratch, "node_modules"),
      "dir",
    );
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
      }),
    );
    const entry = join(scratch, "buttons.tsx");
    code = compilePreactMx(SOURCE, entry).code;
    writeFileSync(entry, code);
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (props: unknown) => unknown;
    };
    handlers = handlersOf(
      mod.default({ on: true, hit: (n: number) => hits.push(n) }),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** Fires `id`'s handler and returns what it hit, once any async body settled. */
async function fire(id: string, thisArg: unknown = {}): Promise<number[]> {
  hits = [];
  await handlers[id]?.call(thisArg, {});
  return hits;
}

describe("an attribute method shorthand (decision 167)", () => {
  it("emits every handler as a function expression, never an arrow", () => {
    expect(code).not.toMatch(/onClick=\{(async )?\(/);
    expect(code).toContain("onClick={function () { if (input.on)");
    expect(code).toContain("onClick={async function () { await");
  });

  it.each([
    ["ifBlock", [1]],
    ["forBlock", [2, 3]],
    ["innerFunction", [4]],
    ["innerArrow", [5]],
    ["asyncAwait", [7]],
    ["generic", [8]],
    ["named", [9]],
  ])("fires %s", async (id, expected) => {
    expect(await fire(id)).toEqual(expected);
  });

  it("gives `this` inside the method to the function, not the module", async () => {
    expect(await fire("ownThis", { id: "mine" })).toEqual([10]);
    expect(await fire("ownThis", { id: "other" })).toEqual([0]);
  });
});

describe("a method shorthand's typecheck mapping", () => {
  const compile = (source: string) =>
    compilePreactMx(source, "/fixtures/test.mx", { typeCheck: true });

  /** The authored text at the mapping that covers `needle`'s generated text. */
  function authoredAt(source: string, needle: string): string | undefined {
    const { code, mappings } = compile(source);
    const at = code.indexOf(needle);
    const mapping = mappings.find(
      (item) => item.generatedStart <= at && at < item.generatedEnd,
    );
    if (!mapping) return undefined;
    return source.slice(
      mapping.sourceStart + (at - mapping.generatedStart),
      mapping.sourceStart + (at - mapping.generatedStart) + needle.length,
    );
  }

  it.each([
    ["a nested block", "<button onClick() { if (c) { go(c) } }>x</button>"],
    ["an async body", "<button async onClick() { await go(1) }>x</button>"],
    ["a generic method", "<button onPick<T>(v: T) { go(v) }>x</button>"],
    ["a reformatted body", "<button onClick() { go(1) }>x</button>"],
  ])("maps the body of %s to the authored body", (_name, source) => {
    const needle = source.match(/go\([^)]*\)/)?.[0] ?? "";
    expect(authoredAt(source, needle)).toBe(needle);
    expect(compile(source).code).not.toContain("=>");
  });

  it("maps a nested `if` at its authored position", () => {
    const source = "<button onClick() { if (c) { go(c) } }>x</button>";
    expect(authoredAt(source, "if (c) {")).toBe("if (c) {");
  });

  it("keeps a generic method's type parameters in the typed output", () => {
    const { code } = compile("<button onPick<T>(v: T) { go(v) }>x</button>");
    expect(code).toContain("function <T>(v: T) { go(v); }");
  });
});
