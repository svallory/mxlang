/**
 * The drift gate for the landing page.
 *
 * `scripts/build-home.ts` runs the same three checks inside the docs build,
 * so CI (`pack-probe-docs`) already fails on a broken example or a stale
 * marker. What the build cannot catch is the one thing it fixes up as it
 * goes: a `docs/index.md` whose committed block no longer matches what the
 * generator produces. That is this file's third test.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compileExample,
  END,
  exampleSection,
  indexPath,
  readExample,
  readMarkers,
  START,
  spliceIndex,
  validate,
} from "./home-example.ts";

describe("the home page example", () => {
  it("compiles on the html target and drops nothing", () => {
    const { code, warnings } = compileExample();
    expect(warnings).toEqual([]);
    expect(code).toContain("export default HomeExample");
  });

  it("has markers that still cover the text they were written for", () => {
    const { lines } = readExample();
    expect(validate(lines, readMarkers())).toEqual([]);
  });

  it("leaves docs/index.md exactly as the generator writes it", async () => {
    const { source } = readExample();
    const fragment = await exampleSection(source, readMarkers());
    const onDisk = readFileSync(indexPath, "utf8");
    const start = onDisk.indexOf(START);
    const end = onDisk.indexOf(END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const emptied =
      onDisk.slice(0, start + START.length) + "\n" + onDisk.slice(end);
    expect(onDisk).toBe(spliceIndex(emptied, fragment));
  });
});
