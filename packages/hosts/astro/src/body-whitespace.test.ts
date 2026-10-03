// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX content syntax
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getCustomTags } from "@mxlang/core";
import { compile, htmlTargets } from "@mxlang/html";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import cases from "../../../../fixtures/body-whitespace/cases.json";
import renderer from "./server.ts";

const dir = mkdtempSync(join(tmpdir(), "mx-astro-body-whitespace-"));
const require = createRequire(import.meta.url);
const astroRequire = createRequire(
  realpathSync(require.resolve("astro/package.json")),
);
let compiler: {
  transform(
    source: string,
    options: { filename: string },
  ): Promise<{ code: string }>;
};
let container: AstroContainer;

// compiler-rs emits metadata consumed by Vite, not the container's public runtime.
function containerModule(code: string) {
  return code
    .replace(", createMetadata as $$createMetadata", "")
    .replace(
      /export const \$\$metadata = \$\$createMetadata\([\s\S]*?\n\}\);\n/,
      "",
    );
}

beforeAll(async () => {
  symlinkSync(
    join(dirname(require.resolve("../package.json")), "node_modules"),
    join(dir, "node_modules"),
    "dir",
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(dir, "tags"));
  const wrap = "<section><${input.content}/></section>";
  for (const path of ["wrap.mx", "tags/wrap.mx"]) {
    writeFileSync(join(dir, path), wrap);
    writeFileSync(
      join(dir, path.replace(".mx", ".ts")),
      compile(wrap, join(dir, path), { strict: true }).code,
    );
  }
  compiler = await import(
    pathToFileURL(astroRequire.resolve("@astrojs/compiler-rs")).href
  );
  container = await AstroContainer.create();
  container.addServerRenderer({ name: "@mxlang/astro", renderer });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let serial = 0;
// Astro's .mx host is the strict HTML compiler plus the MX server renderer.
// Execute that real path inside an Astro component, not only the plain function.
describe.each([false, true])(
  "body whitespace, decision 141 (discovered=%s)",
  (discovered) => {
    it.each(cases)("$label", async ({ body, html }) => {
      const name = `case${serial++}`;
      const filename = join(dir, `${name}.mx`);
      const tag = discovered ? "wrap" : "Wrap";
      const source = `${discovered ? "" : 'import Wrap from "./wrap.mx"\n'}<${tag}>${body}</${tag}>`;
      const code = compile(source, filename, {
        strict: true,
        customTags: getCustomTags(filename, {
          targets: htmlTargets,
          host: "astro",
        }),
      })
        .code.replaceAll('"./wrap.mx"', '"./wrap.ts"')
        .replaceAll('"./tags/wrap.mx"', '"./tags/wrap.ts"');
      writeFileSync(join(dir, `${name}.ts`), code);
      const compiled = await compiler.transform(
        `---\nimport Caller from "./${name}.ts";\n---\n<Caller/>`,
        { filename: join(dir, `${name}.astro`) },
      );
      const moduleFile = join(dir, `${name}.mjs`);
      writeFileSync(moduleFile, containerModule(compiled.code));
      const component = (
        await import(/* @vite-ignore */ pathToFileURL(moduleFile).href)
      ).default;
      expect(await container.renderToString(component)).toBe(
        `<section>${html}</section>`,
      );
    });
  },
);
