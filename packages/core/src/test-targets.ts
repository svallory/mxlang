/**
 * A registered set for tests that need one (decisions 129 and 132; unstable).
 *
 * Core names no target and no host (decision 126), so a test that needs a
 * `TargetLookup` must bring its own. This is that own: invented names, a
 * shape borrowed from the built-in set (a hostless target carrying a
 * deprecated legacy `mx.host` value, hosted targets, one of them with a file
 * kind), and nothing that could be mistaken for a real host.
 *
 * Test-only: the module lives beside the tests because nothing in core's own
 * runtime may hold a set of targets.
 */
import {
  createTargetLookup,
  type TargetDescriptor,
  type TargetLookup,
} from "./target-descriptor.ts";

function target(
  name: string,
  packageName: string,
  extra: Partial<TargetDescriptor> = {},
): TargetDescriptor {
  return {
    descriptorVersion: 0,
    name,
    packageName,
    defaultTag: "node",
    ...extra,
  };
}

/** A lookup over two targets: a hostless one and a hosted one with a file kind. */
export function testTargetLookup(): TargetLookup {
  return createTargetLookup([
    target("page", "@t/page", {
      legacyHostValues: [
        { value: "page" },
        { value: "oldpage", deprecated: true },
      ],
    }),
    target("unit-jsx", "@t/unit", {
      host: {
        name: "unit",
        fileKinds: [
          { segment: "u", diagnosticSource: "umx" },
          { segment: "v", diagnosticSource: "vmx" },
        ],
      },
    }),
  ]);
}

/** A lookup over one hosted target with the file-kind segments `segments`. */
export function testTargetLookupWithSegments(
  ...segments: string[]
): TargetLookup {
  return createTargetLookup([
    target("unit-jsx", "@t/unit", {
      host: {
        name: "unit",
        fileKinds: segments.map((segment) => ({
          segment,
          diagnosticSource: `${segment}mx`,
        })),
      },
    }),
  ]);
}
/**
 * The shared set: a hostless target carrying a deprecated legacy `mx.host`
 * value and a hosted one with two file kinds (`u`, `v`). Every test that just
 * needs *a* lookup uses this one; the tests that care about which segments
 * exist build their own with {@link testTargetLookupWithSegments}.
 */
export const lookup: TargetLookup = testTargetLookup();
