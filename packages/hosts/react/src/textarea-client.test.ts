/**
 * `<textarea value=x/>` stays a controlled `value` on React so a client update
 * changes the text (as on origin/main and as Marko's textarea does).
 * `defaultValue` would be write-once: "a" -> "b" would leave the text at "a".
 * react-dom writes the server markup (and its leading-newline double) itself.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
let scratch = "";

const CLIENT = `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
console.error = () => {}; // controlled value without onChange: React's own dev warning
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const mod = await import("./case.tsx");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const values = [];
for (const v of JSON.parse(process.argv[2])) {
  flushSync(() => root.render(React.createElement(mod.default, { v, attrs: { value: v } })));
  values.push(host.querySelector("textarea").value);
}
console.log(JSON.stringify(values));
`;

beforeAll(() => {
  scratch = mkdtempSync(join(packageDir, ".textarea-client-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("<textarea value> client update (React)", () => {
  it.each([
    ["direct", "<textarea value=input.v/>"],
    ["spread", "<textarea ...input.attrs/>"],
    ["explicit then spread", "<textarea value=input.v ...input.attrs/>"],
  ])(
    "%s: a changed value changes the text",
    (_form, source) => {
      const file = join(scratch, "case.tsx");
      writeFileSync(file, compileReactMx(source, file).code);
      writeFileSync(join(scratch, "run.mjs"), CLIENT);
      const values = JSON.parse(
        execFileSync(
          "bun",
          ["run.mjs", JSON.stringify(["a", "b", "\nc", null])],
          {
            encoding: "utf8",
            cwd: scratch,
          },
        ),
      );
      expect(values).toEqual(["a", "b", "\nc", ""]);
    },
    30_000,
  );
});
