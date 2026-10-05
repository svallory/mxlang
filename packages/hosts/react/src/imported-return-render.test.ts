// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
/**
 * An imported `.mx` tag that declares `<return>`, called without `/var`,
 * rendered for real. The callee's default export returns `{ value, output }`;
 * before core marked an imported call as `returnsValue`, the caller rendered
 * the pair itself (`{Counter({ start: 1 })}`) and React dropped the object
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
import type { FunctionComponent } from "react";
import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

const COUNTER = [
  "export interface Input { start: number }",
  "<span>${input.start}</span>",
  "<return value=input.start + 1/>",
].join("\n");

async function renderCaller(callerSource: string): Promise<string> {
  const { renderToStaticMarkup } = (await import("react-dom/server")) as {
    renderToStaticMarkup: (vnode: unknown) => string;
  };
  const { createElement } = await import("react");
  const scratch = mkdtempSync(join(tmpdir(), "mx-react-imported-return-"));
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
    mkdirSync(join(scratch, "lib"));
    writeFileSync(join(scratch, "lib/counter.mx"), COUNTER);
    writeFileSync(
      join(scratch, "lib/counter.tsx"),
      compileReactMx(COUNTER, join(scratch, "lib/counter.mx")).code,
    );
    const callerPath = join(scratch, "caller.mx");
    const entry = join(scratch, "caller.tsx");
    writeFileSync(
      entry,
      compileReactMx(
        `import Counter from "./lib/counter.mx"\n${callerSource}`,
        callerPath,
      ).code.replace('"./lib/counter.mx"', '"./lib/counter.tsx"'),
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: FunctionComponent<Record<string, unknown>>;
    };
    return renderToStaticMarkup(createElement(mod.default, {}));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("an imported tag that declares <return>, rendered on React", () => {
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
    const scratch = mkdtempSync(join(tmpdir(), "mx-react-imported-none-"));
    try {
      writeFileSync(join(scratch, "plain.mx"), "<b>x</b>\n");
      expect(() =>
        compileReactMx(
          'import Plain from "./plain.mx"\n<Plain/n/>',
          join(scratch, "caller.mx"),
        ),
      ).toThrow(/`<Plain>` does not return a value/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
