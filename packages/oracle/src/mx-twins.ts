import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { htmlTargets } from "@mxlang/html";

/**
 * Turns a scratch copy of a stock `.marko` fixture into the `.mx` project MX
 * actually compiles (decision 172: a `.marko` file is not an MX input).
 *
 * Each `.marko` file is rewritten, by content, to a `.mx` file of the same
 * name, with its own `from "./X.marko"` imports pointed at the `.mx` twins,
 * and the `.marko` file is removed from the scratch copy. Marko's own run
 * (`marko-compile-stock.ts`) still reads the real `.marko` files; this only
 * ever touches the scratch directory MX renders from. A tag under `tags/`
 * becomes an ordinary `tags/x.mx`, which MX's scan discovers.
 */
export function mxTwins(scratch: string): void {
  for (const file of markoFiles(scratch)) {
    const source = readFileSync(file, "utf8").replace(
      /(from\s+["'])(\.[^"']*)\.marko(["'])/g,
      "$1$2.mx$3",
    );
    writeFileSync(file.replace(/\.marko$/, ".mx"), source);
    rmSync(file);
  }
}

/** The custom tags MX's own scan finds for `file`, as the Bun loaders pass them. */
export function discoveredCustomTags(file: string) {
  return getCustomTags(file, { targets: htmlTargets });
}

function markoFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...markoFiles(full));
    else if (entry.endsWith(".marko")) results.push(full);
  }
  return results;
}
