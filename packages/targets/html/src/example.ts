/**
 * `bun run example` — compiles one fixture and renders it to stdout.
 *
 * Deliberately not an app: it shows the whole product in one screen, which is
 * a compiled module with no runtime but `escape`, and the HTML it produces.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanCached } from "@mxlang/core";
import { configuredDefaultTag } from "./default-tag.ts";
import { compileFile, htmlTargets } from "./index.ts";

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
      // `.mx` too: a fixture's `tags/x.mx` twin wins discovery over its
      // `tags/x.marko` and is imported by that path.
      build.onLoad({ filter: /\.(marko|mx)$/ }, ({ path }) => ({
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
 * per loaded file. The emitted module imports each `tags/*.marko` tag it
 * calls, as Marko does, so nothing is added here.
 */
function compileWithTags(file: string) {
  const { customTags, tags } = scanCached(file, {
    host: "html",
    targets: htmlTargets,
  });
  const defaultTag = configuredDefaultTag(file, customTags, htmlTargets, tags);
  return compileFile(file, {
    customTags,
    ...(defaultTag === undefined ? {} : { defaultTag }),
  });
}
