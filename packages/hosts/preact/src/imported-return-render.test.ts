// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
/**
 * An imported `.mx` tag that declares `<return>`, called without `/var`,
 * rendered for real. The callee's default export returns `{ value, output }`;
 * before core marked an imported call as `returnsValue`, the caller rendered
 * the pair itself (`{Counter({ start: 1 })}`) and Preact dropped the object
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
import { type FunctionComponent, h } from "preact";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const COUNTER = [
  "export interface Input { start: number }",
  "<span>${input.start}</span>",
  "<return value=input.start + 1/>",
].join("\n");

async function renderCaller(callerSource: string): Promise<string> {
  const { render } = (await import("preact-render-to-string")) as {
    render: (vnode: unknown) => string;
  };
  const scratch = mkdtempSync(join(tmpdir(), "mx-preact-imported-return-"));
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
    mkdirSync(join(scratch, "lib"));
    writeFileSync(join(scratch, "lib/counter.mx"), COUNTER);
    writeFileSync(
      join(scratch, "lib/counter.tsx"),
      compilePreactMx(COUNTER, join(scratch, "lib/counter.mx")).code,
    );
    const callerPath = join(scratch, "caller.mx");
    const entry = join(scratch, "caller.tsx");
    writeFileSync(
      entry,
      compilePreactMx(
        `import Counter from "./lib/counter.mx"\n${callerSource}`,
        callerPath,
      ).code.replace('"./lib/counter.mx"', '"./lib/counter.tsx"'),
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: FunctionComponent<Record<string, unknown>>;
    };
    return render(h(mod.default, {}));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("an imported tag that declares <return>, rendered on Preact", () => {
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
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-imported-none-"));
    try {
      writeFileSync(join(scratch, "plain.mx"), "<b>x</b>\n");
      expect(() =>
        compilePreactMx(
          'import Plain from "./plain.mx"\n<Plain/n/>',
          join(scratch, "caller.mx"),
        ),
      ).toThrow(/`<Plain>` does not return a value/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects the call's own attribute reading its /var, as a discovered tag does", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-imported-self-"));
    try {
      writeFileSync(join(scratch, "counter.mx"), COUNTER);
      expect(() =>
        compilePreactMx(
          'import Counter from "./counter.mx"\n<Counter/n start=n/>',
          join(scratch, "caller.mx"),
        ),
      ).toThrow(/`n` is read before the `\/var` that binds it/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
