import {
  act,
  createElement,
  Fragment,
  lazy,
  type ReactNode,
  use,
  useState,
} from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MxErrorBoundary, MxPlaceholder, mxClass } from "./runtime.ts";

function Ok(): ReactNode {
  return createElement("p", null, "fine");
}

function Boom(): ReactNode {
  throw new Error("nope");
}

const missing = (): never => {
  throw new TypeError("inline");
};

/** The emitted shape: `<__mxErrorBoundary fallback={…}>{() => body}</…>`. */
function tryOf(
  fallback: (error: unknown) => ReactNode,
  body: () => ReactNode,
): ReactNode {
  // The emitted thunk child; `createElement` types children as `ReactNode`.
  return createElement(
    MxErrorBoundary,
    { fallback },
    body as unknown as ReactNode,
  );
}

/** Final HTML once every suspended boundary has resolved. */
async function prerendered(node: ReactNode): Promise<string> {
  const { prerender } = await import("react-dom/static");
  const { prelude } = await prerender(node);
  return new Response(prelude).text();
}

/** Installs a jsdom window for `run`, as `region-client.test.ts` does. */
async function withDom<T>(run: () => Promise<T>): Promise<T> {
  const { JSDOM } = (await import("jsdom" as string)) as {
    JSDOM: new (
      html: string,
    ) => { window: Window & typeof globalThis & { close(): void } };
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
  const error = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = error;
    for (const key of Object.keys(globals)) {
      delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
}

describe("React runtime", () => {
  it("renders a transparent boundary on the server", () => {
    expect(
      renderToStaticMarkup(
        createElement(
          MxErrorBoundary,
          { fallback: "caught" },
          createElement(Ok),
        ),
      ),
    ).toBe("<p>fine</p>");
  });

  it("catches a descendant throw during server rendering, with a stand-in error", () => {
    const html = renderToStaticMarkup(
      createElement(
        MxErrorBoundary,
        {
          fallback: (e: unknown) =>
            `c:${e instanceof Error}:${(e as Error).message}`,
        },
        createElement(Boom),
      ),
    );
    expect(html).toMatch(/^c:true:.*server render/);
  });

  it("marks the server-caught Suspense boundary in renderToString", () => {
    const html = renderToString(
      createElement(
        MxErrorBoundary,
        { fallback: "caught" },
        createElement(Boom),
      ),
    );
    expect(html).toContain("<!--$!-->");
    expect(html).toContain("caught");
  });

  it("renders a thunk body when nothing throws", () => {
    expect(
      renderToStaticMarkup(
        tryOf(
          () => "c",
          () => createElement(Ok),
        ),
      ),
    ).toBe("<p>fine</p>");
  });

  it("catches an inline thunk throw with the real error and no partial output", () => {
    const html = renderToStaticMarkup(
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
      const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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

  it("keeps a hook written inline in the body working", () => {
    const html = renderToStaticMarkup(
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

  it("shows <@catch> as the loading state of a suspending catch-only body (divergence R2)", () => {
    const Lazy = lazy(() => new Promise<never>(() => {}));
    const html = renderToStaticMarkup(
      tryOf(
        () => "catch",
        () => createElement(Lazy),
      ),
    );
    expect(html).toBe("catch");
  });

  it("rethrows an inline use(promise) suspension instead of catching it", async () => {
    const promise = Promise.resolve("done");
    const body = (): ReactNode => createElement("p", null, use(promise));
    expect(await prerendered(tryOf(() => "caught", body))).toBe(
      "<!--$--><p>done</p><!--/$-->",
    );
    const promise2 = Promise.resolve("done");
    expect(
      await prerendered(
        tryOf(
          () => "caught",
          () =>
            createElement(
              MxPlaceholder,
              { fallback: "wait" },
              createElement("p", null, use(promise2)),
            ),
        ),
      ),
    ).toBe("<!--$--><!--$--><p>done</p><!--/$--><!--/$-->");
  });

  it("treats React's minified SuspenseException as a suspension, not an error", () => {
    for (const code of [460, 542]) {
      const html = renderToStaticMarkup(
        tryOf(
          (e) => `c:${(e as Error).message}`,
          () => {
            throw new Error(
              `Minified React error #${code}; visit https://react.dev/errors/${code} for the full message`,
            );
          },
        ),
      );
      // Reaches the internal Suspense (stand-in), not the thrown error.
      expect(html).toMatch(/server render/);
      expect(html).not.toContain("Minified React error");
    }
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
      return () => {
        if (!done) throw promise;
        return createElement("p", null, "done");
      };
    };
    expect(await prerendered(tryOf(() => "caught", make()))).toBe(
      "<!--$--><p>done</p><!--/$-->",
    );
    const read = make();
    expect(
      await prerendered(
        tryOf(
          () => "caught",
          () => createElement(MxPlaceholder, { fallback: "wait" }, read()),
        ),
      ),
    ).toBe("<!--$--><!--$--><p>done</p><!--/$--><!--/$-->");
  });

  it("renders <@placeholder> on the server and <@catch> on the client for a descendant throw (divergence R1)", async () => {
    const view = (): ReactNode =>
      tryOf(
        (e) => `c:${(e as Error).message}`,
        () =>
          createElement(
            MxPlaceholder,
            { fallback: "wait" },
            createElement(Boom),
          ),
      );
    expect(renderToStaticMarkup(view())).toBe("wait");
    const result = await withDom(async () => {
      const host = document.createElement("div");
      host.innerHTML = renderToString(view());
      document.body.append(host);
      await act(async () => {
        hydrateRoot(host, view());
      });
      const csr = document.createElement("div");
      document.body.append(csr);
      await act(async () => {
        createRoot(csr).render(view());
      });
      return { hydrated: host.textContent, csr: csr.textContent };
    });
    expect(result).toEqual({ hydrated: "c:nope", csr: "c:nope" });
  });

  it("hydrates and client-renders a descendant throw to the real error", async () => {
    const view = (): ReactNode =>
      createElement(
        "div",
        null,
        tryOf(
          (e) => `c:${(e as Error).message}`,
          () => createElement(Fragment, null, "x", createElement(Boom)),
        ),
      );
    const result = await withDom(async () => {
      const server = renderToString(view());
      const host = document.createElement("div");
      host.innerHTML = server;
      document.body.append(host);
      await act(async () => {
        hydrateRoot(host, view());
      });
      const csr = document.createElement("div");
      document.body.append(csr);
      await act(async () => {
        createRoot(csr).render(view());
      });
      return { hydrated: host.textContent, csr: csr.textContent };
    });
    expect(result).toEqual({ hydrated: "c:nope", csr: "c:nope" });
  });

  it("hydrates a caught inline throw to the catch", async () => {
    const view = (): ReactNode =>
      createElement(
        "div",
        null,
        tryOf(
          (e) => `c:${(e as Error).message}`,
          () => createElement(Fragment, null, "x", missing()),
        ),
      );
    const result = await withDom(async () => {
      const server = renderToString(view());
      const host = document.createElement("div");
      host.innerHTML = server;
      document.body.append(host);
      await act(async () => {
        hydrateRoot(host, view());
      });
      return host.textContent;
    });
    expect(result).toBe("c:inline");
  });

  it("renders an unsuspended placeholder subtree", () => {
    expect(
      renderToStaticMarkup(
        createElement(
          MxPlaceholder,
          { fallback: "loading" },
          createElement(Ok),
        ),
      ),
    ).toBe("<p>fine</p>");
  });

  it("selects a function fallback after React marks an error caught", () => {
    const boundary = new MxErrorBoundary({
      fallback: (error) => createElement("p", null, (error as Error).message),
    });
    boundary.state = MxErrorBoundary.getDerivedStateFromError(
      new Error("boom"),
    );
    expect(renderToStaticMarkup(boundary.render())).toBe("<p>boom</p>");
  });

  it("joins structured class values", () => {
    expect(mxClass(["card", { active: true, hidden: false }, [12]])).toBe(
      "card active 12",
    );
  });
});
