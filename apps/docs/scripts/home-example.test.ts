/**
 * The drift gate for the landing page.
 *
 * `scripts/build-home.ts` runs the same three checks inside the docs build,
 * so CI (`pack-probe-docs`) already fails on a broken example or a stale
 * marker. What the build cannot catch is the two things it fixes up or defers
 * as it goes: a `docs/index.md` whose committed block no longer matches what
 * the generator produces, and a marker `#fragment` that is not an `id` in the
 * built site. The first is this file's third test; the second is
 * `bun run check:home`, which runs at the end of the docs build, where the
 * site to resolve anchors against exists — and is repeated here whenever that
 * site is already there.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  anchorExists,
  compileExample,
  END,
  exampleSection,
  indexPath,
  readExample,
  readMarkers,
  START,
  siteRoot,
  spliceIndex,
  validate,
  validateNodes,
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

  it("has markers whose node assertions still hold in the syntax tree", () => {
    const { source } = readExample();
    expect(validateNodes(source, readMarkers())).toEqual([]);
  });

  it("leaves docs/index.md exactly as the generator writes it", () => {
    const { source } = readExample();
    const fragment = exampleSection(source, readMarkers());
    const onDisk = readFileSync(indexPath, "utf8");
    const start = onDisk.indexOf(START);
    const end = onDisk.indexOf(END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const emptied =
      onDisk.slice(0, start + START.length) + "\n" + onDisk.slice(end);
    expect(onDisk).toBe(spliceIndex(emptied, fragment));
  });

  // Skipped on a fresh checkout, where the docs build has not run yet —
  // `check:home` covers that case at the end of every docs build.
  it.skipIf(!existsSync(siteRoot))(
    "links every marker at an anchor the built site has",
    () => {
      for (const marker of readMarkers()) {
        expect(anchorExists(marker.href), `${marker.id} → ${marker.href}`).toBe(
          true,
        );
      }
    },
  );
});
