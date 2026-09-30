/**
 * `bun run example` — compiles one fixture and renders it to stdout.
 *
 * Deliberately not an app: it shows the whole product in one screen, which is
 * a compiled module with no runtime but `escape`, and the HTML it produces.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanCached } from "@mxlang/core";
import { compileFile } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = process.argv[2] ?? "class-object";
const dir = join(here, "..", "fixtures-marko", fixture);
const path = join(dir, "input.marko");

const { code } = compileWithTags(path);
const input = JSON.parse(readFileSync(join(dir, "input.json"), "utf8"));

console.log(`--- ${fixture}/input.marko ---`);
console.log(readFileSync(path, "utf8").trimEnd());
console.log(`\n--- compiled module ---`);
console.log(code.trimEnd());
console.log(`\n--- rendered with ${JSON.stringify(input)} ---`);
console.log(await render(path, input));

/**
 * Runs the emitted module for real, without a bundler.
 *
 * The compiled output is TypeScript that imports `escape` from
 * `@mxlang/html` and any component by its `.marko` path. Bun's own module
 * loader runs it: this registers a loader for `.marko` (the shipped plugin in
 * `bun.ts` deliberately claims only `.mx`) that hands `compileFile`'s output
 * to the TypeScript stripper, then imports the fixture. Nothing here knows
 * the emitted shape, so it cannot drift from it.
 */
async function render(file: string, input: unknown): Promise<string> {
  Bun.plugin({
    name: "mxlang-example",
    setup(build) {
      build.onLoad({ filter: /\.marko$/ }, ({ path }) => ({
        contents: compileWithTags(path).code,
        loader: "ts",
      }));
    },
  });
  const mod = (await import(file)) as {
    default: (input: unknown) => string;
  };
  return mod.default(input);
}

/**
 * `compileFile` with the `tags/` discovery the Bun plugin in `bun.ts` applies
 * per loaded file, plus the import the emitter leaves out.
 *
 * A `tags/*.marko` component is called by bare identifier and the emitted
 * module does not import it, so Bun would hit a `ReferenceError`. The oracle's
 * `translator-render.ts` makes the same addition for the same reason.
 */
function compileWithTags(file: string) {
  const { customTags } = scanCached(file, { host: "html" });
  const result = compileFile(file, { customTags });
  const tagsDir = join(dirname(file), "tags");
  if (!existsSync(tagsDir)) return result;
  const imports = readdirSync(tagsDir)
    .filter((name) => name.endsWith(".marko"))
    .map((name) => name.slice(0, -".marko".length))
    .filter((tag) => result.code.includes(`${tag}(`))
    .map(
      (tag) =>
        `import ${tag} from ${JSON.stringify(join(tagsDir, `${tag}.marko`))};\n`,
    );
  return { ...result, code: imports.join("") + result.code };
}
