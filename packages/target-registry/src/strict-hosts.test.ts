import { expect, it } from "vitest";
import { astroStrictStandIn } from "../../targets/html/src/foreign-strict.ts";
import { builtinTargets } from "./index.ts";

/**
 * `@mxlang/target-html`'s Bun loader cannot import this registry, so it
 * registers a stand-in for each always-strict target outside html. The stand-in
 * must name the same target, package and host as the real descriptor, and every
 * built-in always-strict target must have one.
 */
it("the html Bun loader's astro stand-in matches the real descriptor", () => {
  const real = builtinTargets.find((t) => t.name === astroStrictStandIn.name);
  expect(real).toBeDefined();
  expect(astroStrictStandIn).toMatchObject({
    name: real?.name,
    packageName: real?.packageName,
    strict: real?.strict,
    host: { name: real?.host?.name },
  });
});

it("every built-in always-strict target outside html has a stand-in", () => {
  const strictNames = builtinTargets
    .filter((t) => t.strict === "always" && t.name !== "html")
    .map((t) => t.name);
  expect(strictNames).toEqual([astroStrictStandIn.name]);
});
