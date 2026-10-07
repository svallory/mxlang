/**
 * The `<try>` runtime, at the render level.
 *
 * Every other `<try>` test in this package asserts the *emitted JSX text* —
 * that `<@catch>` becomes `<MxErrorBoundary fallback={…}>`. None of them runs
 * the boundary, so a defect inside `componentDidCatch` or
 * `getDerivedStateFromError` would leave the whole lowering looking correct
 * while a thrown error escaped to the caller. These render it for real.
 *
 * ## What is covered
 *
 * The boundary is exercised for real under `preact-render-to-string` and, for
 * hydration and client rendering, under a jsdom window:
 *
 * - a throw written directly in the `<try>` body reaches the boundary as a
 *   thunk (`() => body`), so it is caught on the server with the real error
 *   and none of the partial body;
 * - a descendant component's throw is caught on the server because the
 *   boundary switches on `preact-render-to-string`'s `flag.errorBoundaries`
 *   flag (a process-global of the consumer's `preact`).
 */

import {
  type ComponentChildren,
  type ComponentType,
  render as clientRender,
  createElement,
  Fragment,
  hydrate,
  options,
  type VNode,
} from "preact";
import { useState } from "preact/hooks";
import { render, renderToStringAsync } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { MxErrorBoundary, MxPlaceholder, mxClass } from "./runtime.ts";

/** A component that throws during render, for the boundary to catch. */
function Boom({ value }: { value?: unknown }): ComponentChildren {
  throw value;
}

function Ok(): ComponentChildren {
  return createElement("p", null, "fine");
}

/** Installs a jsdom window for `run`, as `region-client.test.ts` does. */
async function withDom<T>(run: () => Promise<T>): Promise<T> {
  const { JSDOM } = (await import("jsdom" as string)) as {
    JSDOM: new (
      html: string,
    ) => { window: Window & typeof globalThis & { close(): void } };
  };
  const dom = new JSDOM("<!doctype html><body></body>");
  const globals = { window: dom.window, document: dom.window.document };
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

const missing = (): never => {
  throw new TypeError("inline");
};

/** The emitted shape: `<__mxErrorBoundary fallback={…}>{() => body}</…>`. */
function tryOf(
  fallback: (error: unknown) => ComponentChildren,
  body: () => ComponentChildren,
): VNode<never> {
  return createElement(MxErrorBoundary, { fallback }, body) as VNode<never>;
}

const flag = options as { errorBoundaries?: boolean };

describe("MxErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    const html = render(
      createElement(
        MxErrorBoundary,
        { fallback: createElement("p", null, "caught") },
        createElement(Ok, null),
      ),
    );

    expect(html).toBe("<p>fine</p>");
  });

  it("renders a thunk body when nothing throws", () => {
    expect(
      render(
        tryOf(
          () => "caught",
          () => createElement(Ok, null),
        ),
      ),
    ).toBe("<p>fine</p>");
  });

  it("catches a descendant throw during server rendering", () => {
    expect(
      render(
        createElement(
          MxErrorBoundary,
          { fallback: (e: unknown) => `c:${(e as Error).message}` },
          createElement(Boom, { value: new Error("nope") }),
        ),
      ),
    ).toBe("c:nope");
  });

  it("sets the process-global errorBoundaries flag idempotently", () => {
    flag.errorBoundaries = false;
    render(createElement(MxErrorBoundary, { fallback: "x" }, "ok"));
    expect(flag.errorBoundaries).toBe(true);
    render(createElement(MxErrorBoundary, { fallback: "x" }, "ok"));
    expect(flag.errorBoundaries).toBe(true);
  });

  it("catches an inline thunk throw with the real error and no partial output", () => {
    const html = render(
      createElement(
        "div",
        null,
        tryOf(
          (e) => `c:${(e as Error).message}`,
          () =>
            createElement(
              Fragment,
              null,
              createElement("b", null, "before"),
              missing(),
              createElement("i", null, "after"),
            ),
        ),
      ),
    );

    expect(html).toBe("<div>c:inline</div>");
  });

  it("catches a falsy thrown value through the thunk", () => {
    for (const value of [undefined, null, 0, "", false]) {
      const html = render(
        tryOf(
          (e) => `c:${String(e)}`,
          () => {
            throw value;
          },
        ),
      );
      expect(html).toBe(`c:${String(value)}`);
    }
  });

  it("lets a nested <try> catch before the outer one", () => {
    const html = render(
      tryOf(
        () => "outer",
        () =>
          createElement(
            Fragment,
            null,
            createElement("a", null, "1"),
            tryOf(
              () => createElement("i", null, "3"),
              () =>
                createElement(
                  Fragment,
                  null,
                  createElement("b", null, "2"),
                  missing(),
                ),
            ),
            createElement("u", null, "4"),
          ),
      ),
    );

    expect(html).toBe("<a>1</a><i>3</i><u>4</u>");
  });

  it("lets the outer <try> catch when the inner has no catch of its own", () => {
    const html = render(
      tryOf(
        () => "outer",
        () =>
          createElement(
            Fragment,
            null,
            "x",
            createElement(Boom as ComponentType, {}),
          ),
      ),
    );

    expect(html).toBe("outer");
  });

  it("keeps a hook written inline in the body working", () => {
    // The thunk is evaluated inside `MxTryBody`, a function component, so a
    // hook called inline stays legal.
    const html = render(
      tryOf(
        () => "caught",
        () => {
          const [n] = useState(5);
          return createElement("p", null, n);
        },
      ),
    );
    expect(html).toBe("<p>5</p>");
  });

  it("rethrows an inline thrown thenable instead of catching it", async () => {
    const make = () => {
      let done = false;
      const promise = new Promise<void>((resolve) =>
        setTimeout(() => {
          done = true;
          resolve();
        }, 5),
      );
      return (): ComponentChildren => {
        if (!done) throw promise;
        return createElement("p", null, "done");
      };
    };
    // Catch-only, then catch + placeholder, each under an outer Suspense.
    expect(
      await renderToStringAsync(
        createElement(
          MxPlaceholder,
          { fallback: "wait" },
          tryOf(() => "caught", make()),
        ),
      ),
    ).toBe("<p>done</p>");
    const read = make();
    expect(
      await renderToStringAsync(
        createElement(
          MxPlaceholder,
          { fallback: "wait" },
          tryOf(
            () => "caught",
            () => createElement(MxPlaceholder, { fallback: "w2" }, read()),
          ),
        ),
      ),
    ).toBe("<p>done</p>");
  });

  it("hydrates a caught server render to the catch", async () => {
    const view = (): VNode =>
      createElement(
        "div",
        null,
        tryOf(
          (e) => `c:${(e as Error).message}`,
          () => createElement(Fragment, null, "x", missing()),
        ),
      );
    const server = render(view());
    expect(server).toBe("<div>c:inline</div>");

    const result = await withDom(async () => {
      const host = document.createElement("div");
      host.innerHTML = server;
      document.body.append(host);
      hydrate(view(), host);
      await new Promise((r) => setTimeout(r, 20));
      const csr = document.createElement("div");
      clientRender(view(), csr);
      await new Promise((r) => setTimeout(r, 20));
      return { hydrated: host.innerHTML, csr: csr.innerHTML };
    });
    expect(result).toEqual({
      hydrated: "<div>c:inline</div>",
      csr: "<div>c:inline</div>",
    });
  });

  it("selects a plain fallback node over a function one", () => {
    // The branch `<@catch>` (no params) takes, exercised directly on the
    // component rather than through a render, since the render half cannot
    // run server-side. `<@catch|error|>`'s function form is covered by the
    // browser assertion in `examples/preact-app`'s e2e.
    const boundary = new MxErrorBoundary({
      fallback: createElement("p", null, "caught"),
    });
    boundary.state = MxErrorBoundary.getDerivedStateFromError(
      new Error("nope"),
    );

    expect(render(boundary.render() as VNode)).toBe("<p>caught</p>");
  });

  it("passes the thrown error to a function fallback", () => {
    const boundary = new MxErrorBoundary({
      fallback: (error: unknown) =>
        createElement("p", null, String((error as Error).message)),
    });
    boundary.state = MxErrorBoundary.getDerivedStateFromError(
      new Error("the message"),
    );

    expect(render(boundary.render() as VNode)).toBe("<p>the message</p>");
  });

  it("marks itself caught for a falsy thrown value", () => {
    // The case `runtime.ts`'s own doc comment calls out, and the reason the
    // component tracks `caught` separately from `error`: `throw undefined` is
    // legal JavaScript and a rejected promise can carry one. Keying off the
    // error's truthiness would re-render the failed subtree forever, so this
    // asserts the flag directly — a boolean no render can hide.
    for (const value of [undefined, null, 0, "", false]) {
      const state = MxErrorBoundary.getDerivedStateFromError(value);

      expect(state.caught).toBe(true);
      expect(state.error).toBe(value);

      const boundary = new MxErrorBoundary({
        fallback: (error: unknown) =>
          createElement("p", null, `caught:${String(error)}`),
      });
      boundary.state = state;
      expect(render(boundary.render() as VNode)).toBe(
        `<p>caught:${String(value)}</p>`,
      );
    }
  });
});

describe("MxPlaceholder", () => {
  it("renders its children when nothing suspends", () => {
    const html = render(
      createElement(
        MxPlaceholder,
        { fallback: createElement("p", null, "loading") },
        createElement(Ok, null),
      ),
    );

    expect(html).toBe("<p>fine</p>");
  });
});

describe("mxClass", () => {
  it("keeps a plain string", () => {
    expect(mxClass("a b")).toBe("a b");
  });

  it("takes the truthy keys of an object", () => {
    expect(mxClass({ a: true, b: false, c: 1, d: 0 })).toBe("a c");
  });

  it("flattens an array, recursively", () => {
    expect(mxClass(["x", { y: true, z: false }, ["w"]])).toBe("x y w");
  });

  it("renders nothing for null, undefined, false or an empty string", () => {
    expect(mxClass(null)).toBe("");
    expect(mxClass(undefined)).toBe("");
    expect(mxClass(false)).toBe("");
    expect(mxClass("")).toBe("");
    expect(mxClass([null, undefined, false, ""])).toBe("");
  });

  it("keeps a number, which is a legal class name in HTML", () => {
    expect(mxClass(["col", 12])).toBe("col 12");
  });
});
