// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
/**
 * An imported `.mx` tag that declares `<return>`, called without `/var`,
 * rendered for real. The callee's default export returns `{ value, output }`;
 * before core marked an imported call as `returnsValue`, the caller rendered
 * the pair itself (`{Counter({ start: 1 })}`) and Hono dropped the object
 * instead of the markup. Marko 6.3.51 renders the body and drops the value.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

const COUNTER = [
  "export interface Input { start: number }",
  "<span>${input.start}</span>",
  "<return value=input.start + 1/>",
].join("\n");

const PLAIN = "<b>x</b>";

async function renderCaller(callerSource: string): Promise<string> {
  const { renderToString } = await import("hono/jsx/dom/server");
  const { jsx } = await import("hono/jsx");
  const scratch = mkdtempSync(join(tmpdir(), "mx-hono-imported-return-"));
  try {
    // Hono's exports table blocks `hono/package.json`, so resolve a real
    // subpath and walk up to the workspace `node_modules`.
    let nodeModules = dirname(require.resolve("hono/jsx"));
    while (!nodeModules.endsWith("node_modules")) {
      nodeModules = dirname(nodeModules);
    }
    symlinkSync(nodeModules, join(scratch, "node_modules"), "dir");
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono" },
      }),
    );
    mkdirSync(join(scratch, "lib"));
    writeFileSync(join(scratch, "lib/counter.mx"), COUNTER);
    writeFileSync(
      join(scratch, "lib/counter.tsx"),
      compileHonoMx(COUNTER, join(scratch, "lib/counter.mx")).code,
    );
    writeFileSync(join(scratch, "lib/plain.mx"), PLAIN);
    writeFileSync(
      join(scratch, "lib/plain.tsx"),
      compileHonoMx(PLAIN, join(scratch, "lib/plain.mx")).code,
    );
    // The verifier's second route: the same unit through a `.ts` barrel —
    // the re-exported default is the same function object, so its render
    // path travels with it.
    writeFileSync(
      join(scratch, "lib/counter-barrel.ts"),
      'export { default } from "./counter.tsx";\n',
    );
    const callerPath = join(scratch, "caller.mx");
    const entry = join(scratch, "caller.tsx");
    writeFileSync(
      entry,
      compileHonoMx(
        `import Counter from "./lib/counter.mx"\nimport Plain from "./lib/plain.mx"\n${callerSource}`,
        callerPath,
      ).code
        .replace('"./lib/counter.mx"', '"./lib/counter.tsx"')
        .replace('"./lib/plain.mx"', '"./lib/plain.tsx"'),
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: () => unknown;
    };
    return renderToString(jsx(mod.default, null));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("an imported tag that declares <return>, rendered on Hono", () => {
  it("renders its body and drops the value without /var", async () => {
    expect(await renderCaller("<div><Counter start=1/></div>")).toBe(
      "<div><span>1</span></div>",
    );
  });

  it("renders one body per call", async () => {
    expect(await renderCaller("<Counter start=1/><Counter start=5/>")).toBe(
      "<span>1</span><span>5</span>",
    );
  });

  it("binds /var to the returned value and renders the body", async () => {
    expect(
      await renderCaller("<div><Counter/n start=1/><p>${n}</p></div>"),
    ).toBe("<div><span>1</span><p>2</p></div>");
  });

  it("binds each call's own /var", async () => {
    expect(
      await renderCaller(
        "<Counter/a start=1/><Counter/b start=10/><i>${a}-${b}</i>",
      ),
    ).toBe("<span>1</span><span>10</span><i>2-11</i>");
  });

  it("refuses /var on an imported tag without <return>, at the call", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mx-hono-imported-none-"));
    try {
      writeFileSync(join(scratch, "plain.mx"), "<b>x</b>\n");
      expect(() =>
        compileHonoMx(
          'import Plain from "./plain.mx"\n<Plain/n/>',
          join(scratch, "caller.mx"),
        ),
      ).toThrow(/`<Plain>` does not return a value/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("a dynamic tag whose callee declares <return>, rendered on Hono", () => {
  // The verifier's fixture (dynamic-tag-return-unit-object-object): before
  // decision 155's render path reached this host, `__mxDynamic` passed the
  // returning unit's `{ value, output }` pair straight through and Hono's
  // string resolver failed on it. The unit's `.render` is now the value
  // channel; the default export renders the body.
  it("renders the body and binds /var, reached directly", async () => {
    expect(
      await renderCaller("<div><${Counter}/n start=1/><p>${n}</p></div>"),
    ).toBe("<div><span>1</span><p>2</p></div>");
  });

  it("renders the body and binds /var through a .ts barrel", async () => {
    expect(
      await renderCaller(
        'import Barrel from "./lib/counter-barrel.ts"\n<div><${Barrel}/n start=1/><p>${n}</p></div>',
      ),
    ).toBe("<div><span>1</span><p>2</p></div>");
  });

  it("renders the body without /var, never the unit object", async () => {
    expect(await renderCaller("<div><${Counter} start=1/></div>")).toBe(
      "<div><span>1</span></div>",
    );
  });

  it("binds undefined for a callee without <return>, and renders its body", async () => {
    expect(
      await renderCaller("<div><${Plain}/n/><p>${String(n)}</p></div>"),
    ).toBe("<div><b>x</b><p>undefined</p></div>");
  });

  it("renders a string target as its element, /var or not", async () => {
    expect(await renderCaller('<${"em"}>i</${"em"}>')).toBe("<em>i</em>");
  });
});
