// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
/**
 * A falsy dynamic tag name leaves its `/var` `undefined` and renders nothing
 * of its own, as Marko does on the server and in the browser. Rendered for
 * real through `preact-render-to-string`, whole-file.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { h } from "preact";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

async function renderCaller(
  callerSource: string,
  props: Record<string, unknown> = {},
): Promise<string> {
  const { render } = (await import("preact-render-to-string")) as {
    render: (vnode: unknown) => string;
  };
  const scratch = mkdtempSync(join(tmpdir(), "mx-preact-falsy-dynamic-"));
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
    const entry = join(scratch, "caller.tsx");
    writeFileSync(
      entry,
      compilePreactMx(callerSource, join(scratch, "caller.mx")).code,
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (props: Record<string, unknown>) => unknown;
    };
    return render(h(mod.default as never, props));
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

describe("a falsy dynamic tag name on Preact", () => {
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
