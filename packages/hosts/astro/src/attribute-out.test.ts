import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { ATTRIBUTE_OUT_SOURCE } from "./astro-template.ts";

/** The boolean-attribute list `__mxAttrOut` copies must be Astro's own. */
it("keeps the boolean-attribute list identical to the installed Astro's", () => {
  const astroDir = dirname(
    createRequire(import.meta.url).resolve("astro/package.json"),
  );
  const util = readFileSync(
    join(astroDir, "dist/runtime/server/render/util.js"),
    "utf8",
  );
  const theirs = /const htmlBooleanAttributes = (\/\^[^\n]+\/i);/.exec(
    util,
  )?.[1];
  const ours = /\/(\^\(\?:allowfullscreen[^\n]+?\$)\/i\.test/.exec(
    ATTRIBUTE_OUT_SOURCE,
  )?.[1];
  expect(theirs).toBeDefined();
  expect(`/${ours}/i`).toBe(theirs);
});
