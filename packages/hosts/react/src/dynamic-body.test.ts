// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag/placeholder syntax in template source
/**
 * A body forwarded through a dynamic tag (`<${input.content}/>`), rendered
 * for real. Marko's body is always a renderer, never a string, so a text-only
 * body renders as text; this host's `content` is JSX children, where a
 * text-only body is a bare string that `mxDynamic` read as a tag name
 * (`<wrap>hello</wrap>` rendered `<hello></hello>`). Expected HTML is what
 * stock Marko 6.3.51 renders for the same templates (scratch/squad-liuna/
 * jsx-dynamic-body-text.md, parity table).
 */

import { createTargetLookup } from "@mxlang/core";
import { getCustomTags } from "@mxlang/preact";
import { createElement, type FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import cases from "../../../../test-fixtures/body-whitespace/cases.json";
import descriptor from "./descriptor.ts";
import { compileReactMx } from "./index.ts";

const WRAP = "<section><${input.content}/></section>";

async function renderPair(
  callerSource: string,
  input: Record<string, unknown> = {},
  wrapSource: string = WRAP,
  discovered = false,
): Promise<string> {
  const { mkdirSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const scratch = mkdtempSync(join(tmpdir(), "mx-react-dynbody-"));
  try {
    symlinkSync(
      dirname(dirname(require.resolve("react/package.json"))),
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
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
      }),
    );
    const wrapPath = discovered ? "tags/wrap.mx" : "wrap.mx";
    mkdirSync(join(scratch, "tags"));
    writeFileSync(join(scratch, wrapPath), wrapSource);
    writeFileSync(
      join(scratch, wrapPath.replace(".mx", ".tsx")),
      compileReactMx(wrapSource, join(scratch, wrapPath)).code,
    );
    const callerPath = join(scratch, "caller.mx");
    const caller = compileReactMx(
      discovered
        ? callerSource
        : `import Wrap from "./wrap.mx"\n${callerSource}`,
      callerPath,
      discovered
        ? {
            customTags: getCustomTags(callerPath, {
              targets: createTargetLookup([descriptor]),
            }),
          }
        : {},
    ).code.replace(`"./${wrapPath}"`, `"./${wrapPath.replace(".mx", ".tsx")}"`);
    const entry = join(scratch, "caller.tsx");
    writeFileSync(entry, caller);
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: FC<Record<string, unknown>>;
    };
    return renderToStaticMarkup(createElement(mod.default, input));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe.each([false, true])(
  "body whitespace, decision 141 (discovered=%s)",
  (discovered) => {
    it.each(cases)("$label", async ({ body, html }) => {
      const tag = discovered ? "wrap" : "Wrap";
      expect(
        await renderPair(`<${tag}>${body}</${tag}>`, {}, WRAP, discovered),
      ).toBe(`<section>${html}</section>`);
    });
  },
);

describe("a body forwarded through <${input.content}/> (react, Marko parity)", () => {
  it("(a) a text-only body renders as text, not as an element named by the text", async () => {
    expect(await renderPair("<Wrap>hello</Wrap>")).toBe(
      "<section>hello</section>",
    );
  });

  it("(b) an element body renders as that element", async () => {
    expect(await renderPair("<Wrap><b>x</b></Wrap>")).toBe(
      "<section><b>x</b></section>",
    );
  });

  it("(c) a mixed text and element body renders in order", async () => {
    expect(await renderPair("<Wrap>a <i>b</i> c</Wrap>")).toBe(
      "<section>a <i>b</i> c</section>",
    );
  });

  it("(d) no body renders nothing", async () => {
    expect(await renderPair("<Wrap/>")).toBe("<section></section>");
  });

  it("(e) a body with a placeholder renders the placeholder's value as text", async () => {
    expect(await renderPair("<Wrap>hi ${input.x}</Wrap>", { x: "div" })).toBe(
      "<section>hi div</section>",
    );
  });

  it("(e2) a body that is only a placeholder holding a tag name renders as text", async () => {
    expect(await renderPair("<Wrap>${input.x}</Wrap>", { x: "em" })).toBe(
      "<section>em</section>",
    );
  });

  it("a text body with markup characters is escaped, not parsed", async () => {
    expect(await renderPair("<Wrap>${input.x}</Wrap>", { x: "<b>" })).toBe(
      "<section>&lt;b&gt;</section>",
    );
  });

  it("a numeric placeholder body renders as text", async () => {
    expect(await renderPair("<Wrap>${input.x}</Wrap>", { x: 7 })).toBe(
      "<section>7</section>",
    );
  });

  it("a string target is still a tag name, and its body is still its content", async () => {
    expect(await renderPair("<${input.t}>body</>", { t: "em" })).toBe(
      "<em>body</em>",
    );
  });

  it("a forwarded body keeps working through a second forwarding wrapper", async () => {
    expect(await renderPair("<Wrap><Wrap>hello</Wrap></Wrap>")).toBe(
      "<section><section>hello</section></section>",
    );
  });

  it("a body that is a conditional text renders as text", async () => {
    expect(
      await renderPair("<Wrap><if=input.x>hello</if></Wrap>", { x: true }),
    ).toBe("<section>hello</section>");
  });

  it("a body that is a loop of text renders as text", async () => {
    expect(await renderPair("<Wrap><for|n| of=[1, 2]>n${n}</for></Wrap>")).toBe(
      "<section>n1n2</section>",
    );
  });

  it("a text body of an attribute tag renders as text bare", async () => {
    expect(
      await renderPair(
        "<Wrap><@item>hello</@item></Wrap>",
        {},
        "<section><${input.item}/></section>",
      ),
    ).toBe("<section>hello</section>");
  });

  it.each([
    ["0", 0, "<section>0</section>"],
    ['""', "", "<section></section>"],
    ["false", false, "<section></section>"],
    ["null", null, "<section></section>"],
    ["undefined", undefined, "<section></section>"],
    ["7", 7, "<section>7</section>"],
  ])(
    "a sole placeholder body of %s renders as Marko does",
    async (_label, x, expected) => {
      expect(await renderPair("<Wrap>${input.x}</Wrap>", { x })).toBe(expected);
    },
  );

  it.each([
    ['content="hello"', { content: "hello" }, "<section>hello</section>"],
    ['children="hello"', { children: "hello" }, "<section>hello</section>"],
    [
      "a tag-name-looking content",
      { content: "div" },
      "<section>div</section>",
    ],
    ["content=7", { content: 7 }, "<section>7</section>"],
    ["content=0", { content: 0 }, "<section>0</section>"],
    ['content=""', { content: "" }, "<section></section>"],
  ])(
    "a plain caller passing %s renders as text",
    async (_label, props, expected) => {
      // `...input` forwards the props untouched, the shape a hand-written
      // TSX caller (not this emitter's own call site) produces.
      expect(await renderPair("<Wrap ...input/>", props)).toBe(expected);
    },
  );
});
