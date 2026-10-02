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
import { type Child, jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

const WRAP = "<section><${input.content}/></section>";

async function renderPair(
  callerSource: string,
  input: Record<string, unknown> = {},
  wrapSource: string = WRAP,
): Promise<string> {
  const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const scratch = mkdtempSync(join(tmpdir(), "mx-hono-dynbody-"));
  try {
    symlinkSync(
      dirname(dirname(dirname(require.resolve("hono")))),
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
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" },
      }),
    );
    writeFileSync(
      join(scratch, "wrap.tsx"),
      compileHonoMx(wrapSource, join(scratch, "wrap.mx")).code,
    );
    const caller = compileHonoMx(
      `import Wrap from "./wrap.mx"\n${callerSource}`,
      join(scratch, "caller.mx"),
    ).code.replace('"./wrap.mx"', '"./wrap.tsx"');
    const entry = join(scratch, "caller.tsx");
    writeFileSync(entry, caller);
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (props: Record<string, unknown>) => Child;
    };
    return await jsx(mod.default, input).toString();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("a body forwarded through <${input.content}/> (hono, Marko parity)", () => {
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
});
