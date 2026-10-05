import type { MxRegionCompile } from "@mxlang/babel";
import type { MxParseOptions } from "../index.ts";
import { parse } from "../index.ts";

/**
 * A region compiler that lowers every region to `null`. The bridge package
 * depends on no host, so its own tests drive the position and scanning logic
 * with this stub; tests that need a real lowering live in `@mxlang/solid`
 * (`packages/hosts/solid/src/bridge/`).
 */
export const stubRegionCompile: MxRegionCompile = () => ({ code: "null" });

/** `parse` with the stub region compiler (any `options` override it). */
export function parseStub(
  source: string,
  filename = "test.solid.mx",
  options: MxParseOptions = {},
) {
  return parse(source, filename, {
    mxRegionCompile: stubRegionCompile,
    ...options,
  });
}
