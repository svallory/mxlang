/**
 * A lookup for a test that needs one (decisions 129 and 132; unstable).
 *
 * The Angular package is a direct entry: `build`, `watch`, `discover` and the
 * CLI resolve their targets from this package's own descriptor unless the
 * caller passes a lookup (design note §5.1, rule (c)). A test about how a
 * *foreign* file kind routes therefore has to pass one that holds it, and
 * this builds it.
 */
import { createTargetLookup, type TargetLookup } from "@mxlang/core";
import descriptor from "../src/descriptor.ts";

/** This package's own descriptor over file kinds `segments` alone. */
export function testTargetLookupWithSegments(
  ...segments: string[]
): TargetLookup {
  return createTargetLookup([
    {
      descriptorVersion: 0,
      name: descriptor.name,
      packageName: descriptor.packageName,
      host: {
        name: descriptor.host?.name as string,
        fileKinds: segments.map((segment) => ({
          segment,
          diagnosticSource: `${segment}mx`,
        })),
      },
    },
  ]);
}
