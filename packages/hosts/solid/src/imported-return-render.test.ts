// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

const COUNTER = [
  "export interface Input { start: number }",
  "<span>${input.start}</span>",
  "<return value=input.start + 1/>",
  "",
].join("\n");

const BOX = "<section><${input.content}/></section>\n";

const ssr = (code: string, filename: string): string => {
  const out = transformSync(code, {
    filename,
    presets: [[typescriptPreset, { isTSX: true, allExtensions: true }]],
    plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!out?.code) throw new Error(`Solid babel plugin produced no code`);
  return out.code;
};

/**
 * An imported `.mx` tag that declares `<return>`, called without `/var`,
 * through the real Solid SSR pipeline. Solid hands the value back through a
 * callback prop instead of a `{ value, output }` pair, so the call site has
 * nothing to unwrap: the markup renders and the value is dropped, as in Marko
 * 6.4.4.
 */
function renderImported(fragment: string): string {
  return renderWithHeadVars(fragment).html;
}

/**
 * {@link renderImported}, plus the names the caller hoists to the component
 * head (`returnVars`). A `/var` in a lazy body declares its own `let` in that
 * body, so its name never reaches this list.
 */
function renderWithHeadVars(fragment: string): {
  html: string;
  returnVars: readonly string[];
} {
  const dir = mkdtempSync(join(packageRoot, ".ssr-imported-return-"));
  try {
    const counterPath = join(dir, "counter.mx");
    writeFileSync(counterPath, COUNTER);
    const callee = compileSolidUnit(COUNTER, { filename: counterPath });
    writeFileSync(join(dir, "counter.mjs"), ssr(callee.code, "counter.tsx"));
    const boxPath = join(dir, "box.mx");
    writeFileSync(boxPath, BOX);
    const box = compileSolidUnit(BOX, { filename: boxPath });
    writeFileSync(join(dir, "box.mjs"), ssr(box.code, "box.tsx"));
    const caller = compileSolidMx(fragment, {
      filename: join(dir, "page.solid.mx"),
      importSpecifiers: new Map([
        ["Counter", "./counter.mx"],
        ["Box", "./box.mx"],
      ]),
      // What the region compiler passes for a default import of a `.mx` file.
      importDefaultFromMarkoOrMx: new Set(["Counter", "Box"]),
    });
    const imports = [...caller.hoistedImports, ...caller.hoistedDefines]
      .map((entry) => entry.code)
      .join("\n");
    const app = `${imports}\nimport Counter from "./counter.mx";\nimport Box from "./box.mx";\nexport function App() {\n  ${caller.returnVars.map((v) => `let ${v};`).join(" ")}\n  return <ul>${caller.code}</ul>;\n}\n`;
    writeFileSync(
      join(dir, "app.mjs"),
      ssr(app, "app.tsx")
        .replace('"./counter.mx"', '"./counter.mjs"')
        .replace('"./box.mx"', '"./box.mjs"'),
    );
    writeFileSync(
      join(dir, "run.mjs"),
      `import { renderToString } from "@solidjs/web";\nimport { App } from "./app.mjs";\nprocess.stdout.write(renderToString(() => App()));\n`,
    );
    const html = execFileSync("bun", ["run", join(dir, "run.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    return { html, returnVars: caller.returnVars };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("an imported tag that declares <return>, rendered on Solid", () => {
  it("renders its body and drops the value without /var", () => {
    expect(renderImported("<Counter start=1/>").replace(/ _hk=\S+/g, "")).toBe(
      "<ul><span>1</span></ul>",
    );
  });

  it("binds /var to the returned value and renders the body", () => {
    expect(
      renderImported("<div><Counter/n start=1/><p>${n}</p></div>").replace(
        / _hk=\S+/g,
        "",
      ),
    ).toContain("<span>1</span><p>2</p>");
  });
});

/** A render without Solid's hydration keys and SSR comment markers. */
const strip = (html: string): string =>
  html.replace(/ _hk=[^\s>]+|<!--[\s\S]*?-->/g, "");
const markup = (fragment: string): string => strip(renderImported(fragment));

describe("a /var in a lazy body, rendered on Solid", () => {
  // Each `<For>` row, `<Show>` branch, content body and `<define>` body
  // declares its own `let`s, so a `/var` binds per row, branch or call, as
  // in Marko 6.4.4 and the html target.
  it("binds a /var in a <for> body per row", () => {
    expect(
      markup("<for|i| of=[1,2]><Counter/n start=i/><p>${n}</p></for>"),
    ).toBe("<ul><span>1</span><p>2</p><span>2</span><p>3</p></ul>");
  });

  it("binds a /var in each <if>/<else> branch's own scope", () => {
    const { html, returnVars } = renderWithHeadVars(
      "<if=false><Counter/n start=1/>${n}</if><else><Counter/m start=5/><p>${m}</p></else>",
    );
    expect(strip(html)).toBe("<ul><span>5</span><p>6</p></ul>");
    // SSR renders the same markup from a head `let`; the branch's names
    // staying off the component head is what pins the per-branch scope.
    expect(returnVars).toEqual([]);
  });

  it("gives a repeated /var its own binding across element and lazy scopes", () => {
    expect(
      markup(
        "<Counter/n start=1/><div><Counter/n start=3/><for|i| of=[5]><Counter/n start=i/><b>${n}</b></for><i>${n}</i></div><u>${n}</u>",
      ),
    ).toBe(
      "<ul><span>1</span><div><span>3</span><span>5</span><b>6</b><i>4</i></div><u>2</u></ul>",
    );
  });

  it("binds a /var in a component's content body", () => {
    const { html, returnVars } = renderWithHeadVars(
      "<Box><Counter/n start=1/><p>${n}</p></Box>",
    );
    expect(strip(html)).toBe(
      "<ul><section><span>1</span><p>2</p></section></ul>",
    );
    // The content body's names stay off the component head.
    expect(returnVars).toEqual([]);
  });

  it("binds a /var in a <define> body per call", () => {
    expect(
      markup(
        "<define/Row|{ s }|><Counter/n start=s/><b>${n}</b></define><Row s=1/><Row s=4/>",
      ),
    ).toBe("<ul><span>1</span><b>2</b><span>4</span><b>5</b></ul>");
  });
});
