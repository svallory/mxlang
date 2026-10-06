import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/**
 * The tag fixtures under `fixtures-marko/` come as `.marko` (what stock Marko
 * renders in the oracle) and as `.mx` twins (what MX discovers). A twin is the
 * same bytes: if one is edited without the other, the two renders no longer
 * compare the same template.
 */
const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures-marko",
);

for (const [fixture, tag] of [
  ["tags-discovery", "badge"],
  ["try-child-throw", "boom"],
] as const) {
  test(`${fixture}/tags/${tag}.mx equals ${tag}.marko`, () => {
    const dir = join(fixtures, fixture, "tags");
    const marko = readFileSync(join(dir, `${tag}.marko`), "utf8");
    expect(marko.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, `${tag}.mx`), "utf8")).toBe(marko);
  });
}
