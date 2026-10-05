import type { TargetDescriptor } from "../../../target-descriptor.ts";
import { TranslateError } from "./core-copy.ts";

/**
 * A target that ignores the `core` handed to `load` and uses its own copy of
 * `@mxlang/core` instead (`./core-copy.ts` stands in for that copy). The
 * `TranslateError` it throws is a different class from the tool's, so
 * `instanceof` fails across the boundary (OQ10).
 */
const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "acme-own-core",
  packageName: "@acme/mx-own-core",
  defaultTag: "node",
  load() {
    return {
      compileModule(_source, filename) {
        throw new TranslateError("from the target's own core", 1, 0, filename);
      },
    };
  },
};

export default descriptor;
