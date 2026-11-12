import {
  createTargetLookup,
  type TargetDescriptor,
  type TargetLookup,
} from "@mxlang/core";
import html from "./descriptor.ts";

/**
 * Stand-in for the astro target, which has no mode but strict (its descriptor
 * declares `strict: "always"`). This package cannot import `@mxlang/host-astro`
 * (it depends on this one), so the Bun loader's default lookup registers this
 * descriptor of the same name, package and host: every selection path the full
 * registry honours (`mx.host`, `mx.target`, a dependency on the package) then
 * resolves to a strict target here too. `@mxlang/targets`' `strict-hosts.test.ts`
 * keeps it equal to the real descriptor. Bun-free: tests import it.
 */
export const astroStrictStandIn: TargetDescriptor = {
  descriptorVersion: 0,
  name: "astro-html",
  packageName: "@mxlang/host-astro",
  defaultTag: html.defaultTag,
  strict: "always",
  host: { name: "astro" },
};

/** This package's own lookup plus {@link astroStrictStandIn}, for strictness only. */
export const strictnessTargets: TargetLookup = createTargetLookup(
  [html, astroStrictStandIn],
  { defaultTarget: html.name },
);
