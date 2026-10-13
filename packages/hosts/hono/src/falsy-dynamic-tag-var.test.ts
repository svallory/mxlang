// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
/**
 * A falsy dynamic tag name leaves its `/var` `undefined` and renders nothing
 * of its own, as Marko does on the server and in the browser. Rendered for
 * real through `hono/jsx/dom/server`, whole-file.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

async function renderCaller(
  callerSource: string,
  props: Record<string, unknown> = {},
): Promise<string> {
  const { renderToString } = await import("hono/jsx/dom/server");
  const { jsx } = await import("hono/jsx");
  const scratch = mkdtempSync(join(tmpdir(), "mx-hono-falsy-dynamic-"));
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
    const entry = join(scratch, "caller.tsx");
    writeFileSync(
      entry,
      compileHonoMx(callerSource, join(scratch, "caller.mx")).code,
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (props: Record<string, unknown>) => unknown;
    };
    return renderToString(jsx(mod.default as never, props));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const FALSY: Array<[string, string]> = [
  ["null", "null"],
  ["false", "false"],
  ["undefined", "undefined"],
  ["the empty string", '""'],
  ["0", "0"],
];

describe("a falsy dynamic tag name on Hono", () => {
  for (const [label, literal] of FALSY) {
    it(`${label}: renders nothing and leaves /x undefined`, async () => {
      expect(
        await renderCaller(
          `<const/tag=${literal}/>\n<${"${tag}"}/x/>\n<p>${"${String(x)}"}</p>`,
        ),
      ).toBe("<p>undefined</p>");
    });
  }

  it("a falsy tag name read from input behaves the same", async () => {
    expect(
      await renderCaller("<${input.tag}/x/><p>${String(x)}</p>", { tag: null }),
    ).toBe("<p>undefined</p>");
  });

  it("a falsy tag name with attributes still binds nothing", async () => {
    expect(
      await renderCaller(
        '<const/tag=null/>\n<${tag}/x id="a" class="b"/><p>${String(x)}</p>',
      ),
    ).toBe("<p>undefined</p>");
  });

  it("a real tag name next to it still renders (control)", async () => {
    expect(
      await renderCaller(
        '<const/tag="b"/>\n<${tag}/x>hi</>\n<p>${String(x)}</p>',
      ),
    ).toMatch(/^<b>hi<\/b><p>/);
  });
});
