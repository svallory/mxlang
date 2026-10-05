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
 * 6.3.51.
 */
function renderImported(fragment: string): string {
  const dir = mkdtempSync(join(packageRoot, ".ssr-imported-return-"));
  try {
    const counterPath = join(dir, "counter.mx");
    writeFileSync(counterPath, COUNTER);
    const callee = compileSolidUnit(COUNTER, { filename: counterPath });
    writeFileSync(join(dir, "counter.mjs"), ssr(callee.code, "counter.tsx"));
    const caller = compileSolidMx(fragment, {
      filename: join(dir, "page.solid.mx"),
      importSpecifiers: new Map([["Counter", "./counter.mx"]]),
      // What the region compiler passes for a default import of a `.mx` file.
      importDefaultFromMarkoOrMx: new Set(["Counter"]),
    });
    const imports = [...caller.hoistedImports, ...caller.hoistedDefines]
      .map((entry) => entry.code)
      .join("\n");
    const app = `${imports}\nimport Counter from "./counter.mx";\nexport function App() {\n  ${caller.returnVars.map((v) => `let ${v};`).join(" ")}\n  return <ul>${caller.code}</ul>;\n}\n`;
    writeFileSync(
      join(dir, "app.mjs"),
      ssr(app, "app.tsx").replace('"./counter.mx"', '"./counter.mjs"'),
    );
    writeFileSync(
      join(dir, "run.mjs"),
      `import { renderToString } from "@solidjs/web";\nimport { App } from "./app.mjs";\nprocess.stdout.write(renderToString(() => App()));\n`,
    );
    return execFileSync("bun", ["run", join(dir, "run.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
    });
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
