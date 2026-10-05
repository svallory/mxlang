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
    const callerPath = join(scratch, "caller.mx");
    const entry = join(scratch, "caller.tsx");
    writeFileSync(
      entry,
      compileHonoMx(
        `import Counter from "./lib/counter.mx"\n${callerSource}`,
        callerPath,
      ).code.replace('"./lib/counter.mx"', '"./lib/counter.tsx"'),
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
});
