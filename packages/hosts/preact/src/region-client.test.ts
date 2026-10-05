/**
 * A `.preact.mx` region in a live Preact root: an attribute-method handler
 * updates the surrounding component's `useState`, and a region `<define>`
 * closes over that state, so it re-reads the new value on the next render
 * (the reason a region's `<define>` stays a local of the render rather than
 * being hoisted to module scope).
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { describe, expect, it } from "vitest";
import { FIXTURES, printPreactMx, withPrinted } from "./region-test-helpers.ts";

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

const SOURCE = `import { useState } from "preact/hooks";

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

describe(".preact.mx region in a live root", () => {
  it("a handler updates useState and a region <define> reads the new value", async () => {
    const printed = printPreactMx(SOURCE, `${FIXTURES}/client.preact.mx`);
    const text = await withPrinted(printed, FIXTURES, (Page) =>
      withDom(async () => {
        const host = document.createElement("div");
        document.body.append(host);
        await act(() => render(h(Page, {}), host));
        const before = host.querySelector("span")?.textContent;
        await act(() => host.querySelector("button")?.click());
        await act(() => host.querySelector("button")?.click());
        const after = host.querySelector("span")?.textContent;
        await act(() => render(null, host));
        return { before, after };
      }),
    );
    expect(text).toEqual({ before: "count 0", after: "count 2" });
  });
});
