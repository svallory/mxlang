// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Fragment, jsx as honoJsx } from "hono/jsx";
import { HtmlEscapedCallbackPhase, resolveCallback } from "hono/utils/html";
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";
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

describe("a compiled <@catch> body", () => {
  it("renders a <for> body's rows joined without commas, as html does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-hono-catch-for-"));
    try {
      let nodeModules = dirname(require.resolve("hono/jsx"));
      while (!nodeModules.endsWith("node_modules")) {
        nodeModules = dirname(nodeModules);
      }
      symlinkSync(nodeModules, join(dir, "node_modules"), "dir");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono" },
        }),
      );
      const entry = join(dir, "App.tsx");
      writeFileSync(
        entry,
        compileHonoMx(
          "<try><div>${input.boom()}</div><@catch|e|><for|i| of=[0, 1]>${i}</for></@catch></try>",
          join(dir, "App.mx"),
        ).code,
      );
      const module = (await import(entry)) as { default: unknown };
      expect(await html(jsx(module.default, { boom: missing }))).toBe("01");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
