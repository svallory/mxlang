/**
 * A `.react.mx` region in a live React root: an attribute-method handler
 * updates the surrounding component's `useState`, and a region `<define>`
 * closes over that state, so it re-reads the new value on the next render
 * (the reason a region's `<define>` stays a local of the render rather than
 * being hoisted to module scope).
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { FIXTURES, printReactMx, withPrinted } from "./region-test-helpers.ts";

/**
 * Installs a jsdom window for the duration of `run`. Installed only after the
 * module is printed: `@marko/compiler` reads a global `window` as a browser
 * and its module resolution then fails (`tryResolve is not a function`),
 * which is also why this file does not use vitest's `jsdom` environment.
 */
async function withDom<T>(run: () => Promise<T>): Promise<T> {
  // `jsdom` ships no types and this package has no `@types/jsdom`.
  const { JSDOM } = (await import("jsdom" as string)) as {
    JSDOM: new (
      html: string,
    ) => {
      window: Window & typeof globalThis & { close(): void };
    };
  };
  const dom = new JSDOM("<!doctype html><body></body>");
  const globals = {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  Object.assign(globalThis, globals);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(globals)) {
      delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
}

const SOURCE = `import { useState } from "react";

export default function Page() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <define/Label|prefix: string|><span>\${prefix} \${count}</span></define>
      <Label("count")/>
      <button type="button" onClick() { setCount(count + 1); }>add</button>
    </div>
  );
}
`;

describe(".react.mx region in a live root", () => {
  it("a handler updates useState and a region <define> reads the new value", async () => {
    const printed = printReactMx(SOURCE, `${FIXTURES}/client.react.mx`);
    const text = await withPrinted(printed, FIXTURES, (Page) =>
      withDom(async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        await act(async () => root.render(createElement(Page)));
        const before = host.querySelector("span")?.textContent;
        await act(async () => host.querySelector("button")?.click());
        await act(async () => host.querySelector("button")?.click());
        const after = host.querySelector("span")?.textContent;
        await act(async () => root.unmount());
        return { before, after };
      }),
    );
    expect(text).toEqual({ before: "count 0", after: "count 2" });
  });
});
