// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
/**
 * A falsy dynamic tag name leaves its `/var` `undefined` and renders nothing
 * of its own, as Marko does on the server and in the browser. Rendered for
 * real through `react-dom/server`, whole-file.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

async function renderCaller(
  callerSource: string,
  props: Record<string, unknown> = {},
): Promise<string> {
  const { renderToStaticMarkup } = (await import("react-dom/server")) as {
    renderToStaticMarkup: (vnode: unknown) => string;
  };
  const { createElement } = await import("react");
  const scratch = mkdtempSync(join(tmpdir(), "mx-react-falsy-dynamic-"));
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
    const entry = join(scratch, "caller.tsx");
    writeFileSync(
      entry,
      compileReactMx(callerSource, join(scratch, "caller.mx")).code,
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (props: Record<string, unknown>) => unknown;
    };
    return renderToStaticMarkup(createElement(mod.default as never, props));
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

describe("a falsy dynamic tag name on React", () => {
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
