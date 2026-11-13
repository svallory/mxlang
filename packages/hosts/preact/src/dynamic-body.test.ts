// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag/placeholder syntax in template source
/**
 * A body forwarded through a dynamic tag (`<${input.content}/>`), rendered
 * for real. Marko's body is always a renderer, never a string, so a text-only
 * body renders as text; this host's `content` is JSX children, where a
 * text-only body is a bare string that `mxDynamic` read as a tag name
 * (`<wrap>hello</wrap>` rendered `<hello></hello>`). Expected HTML is what
 * stock Marko 6.4.4 renders for the same templates (scratch/squad-liuna/
 * jsx-dynamic-body-text.md, parity table).
 */

import { createTargetLookup } from "@mxlang/core";
import { type FunctionComponent, h } from "preact";
import { describe, expect, it } from "vitest";
import cases from "../../../../test-fixtures/body-whitespace/cases.json";
import descriptor from "./descriptor.ts";
import { compilePreactMx, getCustomTags } from "./index.ts";

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
  const { render } = (await import("preact-render-to-string")) as {
    render: (vnode: unknown) => string;
  };
  const scratch = mkdtempSync(join(tmpdir(), "mx-preact-dynbody-"));
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
    const wrapPath = discovered ? "tags/wrap.mx" : "wrap.mx";
    mkdirSync(join(scratch, "tags"));
    writeFileSync(join(scratch, wrapPath), wrapSource);
    writeFileSync(
      join(scratch, wrapPath.replace(".mx", ".tsx")),
      compilePreactMx(wrapSource, join(scratch, wrapPath)).code,
    );
    const callerPath = join(scratch, "caller.mx");
    const caller = compilePreactMx(
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
      default: FunctionComponent<Record<string, unknown>>;
    };
    return render(h(mod.default, input));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe.each([false, true])(
  "body whitespace (discovered=%s)",
  (discovered) => {
    it.each(cases)("$label", async ({ body, html }) => {
      const tag = discovered ? "wrap" : "Wrap";
      expect(
        await renderPair(`<${tag}>${body}</${tag}>`, {}, WRAP, discovered),
      ).toBe(`<section>${html}</section>`);
    });
  },
);

describe("a body forwarded through <${input.content}/> (preact, Marko parity)", () => {
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
      "<section>&lt;b></section>",
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

// Stock Marko 6.4.4 renders the body for every falsy dynamic tag name
// (false, 0, "", null, undefined) and nothing for a self-closing dynamic
// tag — measured on the stock toolchain. `__mxDynamic` previously returned
// the raw falsy target on its fallback path, so `<${0}/>` rendered "0" as
// JSX text and `<${false}>body</>` never rendered its body on the
// args-array path.
describe("a falsy dynamic tag name (Marko parity)", () => {
  it.each([
    ["false", false],
    ["0", 0],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
  ])("%s renders the body and nothing else", async (_label, t) => {
    expect(await renderPair("<${input.t}>body</>", { t })).toBe("body");
  });

  it.each([
    ["false", false],
    ["0", 0],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
  ])("%s renders nothing self-closing", async (_label, t) => {
    expect(await renderPair("<${input.t}/>", { t })).toBe("");
  });
});

describe("a <define> used as a dynamic target (mx-jsx-define-as-dynamic-target-empty)", () => {
  const define = (params: string) =>
    `<define/Row${params}><li><\${content}${params === "" ? "" : '("r")'}/></li></define>\n<const/R = Row/>\n`;

  it("renders the body when the call has no tag params", async () => {
    expect(
      await renderPair(
        `${define("|{ content }|")}<\${R}><b>x</b></>`,
        {},
        WRAP,
        true,
      ),
    ).toBe("<li><b>x</b></li>");
  });

  it("renders the body, called with its params, when the call has tag params", async () => {
    expect(
      await renderPair(
        `${define("|{ content }|")}<\${R}|n|><b>\${n}</b></>`,
        {},
        WRAP,
        true,
      ),
    ).toBe("<li><b>r</b></li>");
  });

  it("the args form hands the body over as the object after the args", async () => {
    expect(
      await renderPair(
        '<define/Row|label, { content }|><li>${label}:<${content}/></li></define>\n<const/R = Row/>\n<${R}("a")><b>x</b></>',
        {},
        WRAP,
        true,
      ),
    ).toBe("<li>a:<b>x</b></li>");
  });

  it("a text body reads as text, not a tag name", async () => {
    expect(
      await renderPair(
        `${define("|{ content }|")}<\${R}>hi</>`,
        {},
        WRAP,
        true,
      ),
    ).toBe("<li>hi</li>");
  });

  // Stock Marko 6.4.4: `<${Row} x=1/>` is `Row.content({ x: 1 })` and
  // `<${Row}(1, 2)/>` is `Row.content(1, 2)`.
  it.each([
    [
      "<define/Row|a, b|>[${typeof b}]</define>\n<const/R = Row/>\n<${R} x=1/>",
      "[undefined]",
    ],
    [
      '<define/Row|a, b|>[${a}|${b}]</define>\n<const/R = Row/>\n<${R}("p", "q")/>',
      "[p|q]",
    ],
  ])(
    "%s: a 2nd param comes only from the argument form",
    async (source, html) => {
      expect(await renderPair(source, {}, WRAP, true)).toBe(html);
    },
  );
});

describe("a /var in a dynamic-tag body is its own scope", () => {
  it("renders the inner and the outer x independently", async () => {
    expect(
      await renderPair(
        `<\${"section"}><wrap/x v=2/>\${x}</>\n<wrap/x v=1/>\${x}`,
        {},
        "<return value=input.v/>",
        true,
      ),
    ).toBe("<section>2</section>1");
  });
});

describe("a direct call of a <define> passes its arguments through untouched", () => {
  class TreeNode {
    children = ["a"];
    label() {
      return "node";
    }
  }

  it("a positional argument keeps its identity and prototype", async () => {
    expect(
      await renderPair(
        "<define/Row|item|>${item.label()}:${item.children.length}</define>\n<Row(input.node)/>",
        { node: new TreeNode() },
        WRAP,
        true,
      ),
    ).toBe("node:1");
  });

  it("an attribute named children is not read as the body", async () => {
    expect(
      await renderPair(
        "<define/Row|{ children, content }|><if=content>has body</if><else>none</else></define>\n<Row children=input.list/>",
        { list: ["x"] },
        WRAP,
        true,
      ),
    ).toBe("none");
  });
});
