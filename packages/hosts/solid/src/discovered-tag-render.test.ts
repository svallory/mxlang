// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import { getCustomTags } from "@mxlang/core";
import { print } from "@mxlang/parser";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit, solidTargets } from "./index.ts";

/**
 * A custom tag found by the normal `tags/` scan (not path-registered), called
 * with an attribute and a body and rendered through Solid's real SSR pipeline
 * (`@solidjs/babel-plugin` `generate: "ssr"` then `@solidjs/web`'s
 * `renderToString`, in a Bun subprocess like `ssr-render.test.ts`), both from
 * a `.solid.mx` region and from a whole-file tag unit. Asserting the rendered
 * HTML, not the emitted text, is what catches a discovered tag that ships as a
 * literal element or throws at render time (the `.astro.mx` bug of PR #375).
 */
const packageRoot = new URL("..", import.meta.url).pathname;
// Inside the package so Bun resolves the workspace's solid runtime from there.
const dir = mkdtempSync(join(packageRoot, ".discovered-tag-render-"));
const scan = (file: string) => getCustomTags(file, { targets: solidTargets });

const BADGE = [
  "export interface Input { label: string }",
  "<b title=input.label>${input.label}:<${input.content}/></b>",
  "",
].join("\n");

/** Solid SSR codegen over TSX text, written as a `.mjs` sibling. */
function ssr(code: string, name: string): void {
  const out = transformSync(code, {
    filename: `${name}.tsx`,
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!out?.code) throw new Error(`Solid produced no code for ${name}`);
  writeFileSync(
    join(dir, `${name}.mjs`),
    out.code.replaceAll(/(["'])(\.\/[^"']*?)\.(?:mx|tsx)\1/g, "$1$2.mjs$1"),
  );
}

let pageId = 0;
/** Renders `entry.mjs`'s default export, after Solid-compiling the tag unit beside it. */
function render(entryCode: string): string {
  const name = `page${++pageId}`;
  ssr(entryCode, name);
  const runner = join(dir, `${name}-run.mjs`);
  writeFileSync(
    runner,
    `import { renderToString } from "@solidjs/web";\nimport Page from "./${name}.mjs";\nprocess.stdout.write(renderToString(() => Page()));\n`,
  );
  return execFileSync("bun", ["run", runner], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}

function region(body: string): string {
  const file = join(dir, "page.solid.mx");
  const source = `export default function Page() {\n  return (<>${body}</>);\n}\n`;
  const printed = print(source, file, {
    mx: true,
    customTags: scan(file),
    mxRegionCompile: (input) =>
      compileSolidMx(input.source, {
        ...input,
        targets: solidTargets,
      }) as ReturnType<
        NonNullable<Parameters<typeof print>[2]>["mxRegionCompile"] & {}
      >,
  }).code;
  return render(printed);
}

function whole(source: string): string {
  const file = join(dir, "page.mx");
  const { code } = compileSolidUnit(source, {
    filename: file,
    customTags: scan(file),
  });
  return render(code);
}

beforeAll(() => {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
  mkdirSync(join(dir, "tags"));
  writeFileSync(join(dir, "tags", "badge.mx"), BADGE);
  // The tag is a module of its own on Solid, as it ships.
  ssr(
    compileSolidUnit(BADGE, {
      filename: join(dir, "tags", "badge.mx"),
      customTags: scan(join(dir, "page.mx")),
    }).code,
    "tags/badge",
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a discovered custom tag, rendered on Solid", () => {
  it("scans the tag rather than being handed it", () => {
    expect(Object.keys(scan(join(dir, "page.mx")))).toEqual(["badge"]);
    expect(readFileSync(join(dir, "tags", "badge.mx"), "utf8")).toBe(BADGE);
  });

  it("whole-file unit: renders the tag's markup with its attribute and body", () => {
    expect(whole('<div><badge label="a">hi</badge></div>')).toBe(
      '<div><b title="a">a:hi</b></div>',
    );
  });

  it("region: renders the tag's markup with its attribute and body", () => {
    expect(region('<div><badge label="a">hi</badge></div>')).toBe(
      '<div><b title="a">a:hi</b></div>',
    );
  });

  it("region: renders every call, nested markup in the body", () => {
    expect(
      region('<badge label="a"><i>x</i></badge><p><badge label="b"/></p>'),
    ).toBe('<b title="a">a:<i>x</i></b><p><b title="b">b:</b></p>');
  });
});
