import { Fragment, jsx as honoJsx } from "hono/jsx";
import { HtmlEscapedCallbackPhase, resolveCallback } from "hono/utils/html";
import { describe, expect, it } from "vitest";
import { MxErrorBoundary, mxClass } from "./runtime.ts";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed so tests can build trees directly
const jsx = honoJsx as (type: any, props: any, ...children: any[]) => any;

/** What `c.html()` does with a JSX element. */
async function html(element: {
  toString(): string | Promise<string>;
}): Promise<string> {
  return String(
    await resolveCallback(
      await element.toString(),
      HtmlEscapedCallbackPhase.Stringify,
      false,
      {},
    ),
  );
}

const missing = (): never => {
  throw new TypeError("inline");
};

function Boom(): never {
  throw new RangeError("below");
}

describe("mxClass", () => {
  it("joins a structured class value", () => {
    expect(mxClass(["card", { active: true, hidden: false }])).toBe(
      "card active",
    );
  });

  it("drops falsy entries", () => {
    expect(mxClass([null, undefined, false, "", "x"])).toBe("x");
  });
});

describe("MxErrorBoundary", () => {
  it("renders a thunk body when nothing throws", async () => {
    expect(
      await html(
        jsx(MxErrorBoundary as never, { fallback: () => "c" }, (() =>
          jsx("p", {}, "fine")) as never),
      ),
    ).toBe("<p>fine</p>");
  });

  it("catches an inline thunk throw with the real error and no partial output", async () => {
    const out = await html(
      jsx(
        "div",
        {},
        jsx(
          MxErrorBoundary as never,
          {
            fallback: (e: Error) => `c:${e.message}`,
          },
          (() =>
            jsx(
              Fragment as never,
              {},
              jsx("b", {}, "before"),
              missing() as never,
            )) as never,
        ),
      ),
    );
    expect(out).toBe("<div>c:inline</div>");
  });

  it("catches a descendant component throw", async () => {
    const out = await html(
      jsx(
        MxErrorBoundary as never,
        {
          fallback: (e: Error) => `c:${e.constructor.name}`,
        },
        (() =>
          jsx(Fragment as never, {}, "x", jsx(Boom as never, {}))) as never,
      ),
    );
    expect(out).toBe("c:RangeError");
  });

  it("lets a nested <try> catch before the outer one", async () => {
    const out = await html(
      jsx(MxErrorBoundary as never, { fallback: () => "outer" }, (() =>
        jsx(
          Fragment as never,
          {},
          jsx("a", {}, "1"),
          jsx(
            MxErrorBoundary as never,
            {
              fallback: () => jsx("i", {}, "3"),
            },
            (() =>
              jsx(
                Fragment as never,
                {},
                jsx("b", {}, "2"),
                missing() as never,
              )) as never,
          ),
          jsx("u", {}, "4"),
        )) as never),
    );
    expect(out).toBe("<a>1</a><i>3</i><u>4</u>");
  });
});
