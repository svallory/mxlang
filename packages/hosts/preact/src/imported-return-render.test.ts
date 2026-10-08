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

const BODY_COUNTER = [
  "export interface Input { start: number }",
  "<span>${input.start}</span><${input.content}/>",
  "<return value=input.start + 1/>",
].join("\n");

const PLAIN = "<b>x</b>";

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
    writeFileSync(join(scratch, "lib/body-counter.mx"), BODY_COUNTER);
    writeFileSync(
      join(scratch, "lib/body-counter.tsx"),
      compilePreactMx(BODY_COUNTER, join(scratch, "lib/body-counter.mx")).code,
    );
    writeFileSync(join(scratch, "lib/plain.mx"), PLAIN);
    writeFileSync(
      join(scratch, "lib/plain.tsx"),
      compilePreactMx(PLAIN, join(scratch, "lib/plain.mx")).code,
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
      compilePreactMx(
        `import Counter from "./lib/counter.mx"\nimport Plain from "./lib/plain.mx"\nimport BodyCounter from "./lib/body-counter.mx"\n${callerSource}`,
        callerPath,
      ).code
        .replace('"./lib/counter.mx"', '"./lib/counter.tsx"')
        .replace('"./lib/plain.mx"', '"./lib/plain.tsx"')
        .replace('"./lib/body-counter.mx"', '"./lib/body-counter.tsx"'),
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

  // A dynamic tag with tag arguments AND a body: `__mxDynamicPair` called
  // `render(...payload)` and never passed `content`, so the body dropped.
  it("renders a dynamic /var call's body alongside tag arguments", async () => {
    expect(
      await renderCaller(
        '<div><${BodyCounter}/n({ start: 1 })>body</><p>${n}</p></div>',
      ),
    ).toBe("<div><span>1</span>body<p>2</p></div>");
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

describe("a dynamic tag whose callee declares <return>, rendered on Preact", () => {
  // The verifier's fixture (dynamic-tag-return-unit-object-object): before
  // decision 155's render path reached this host, `__mxDynamic` passed the
  // returning unit's `{ value, output }` pair straight through and Preact
  // rendered empty. The unit's `.render` is now the value channel; the
  // default export renders the body.
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
