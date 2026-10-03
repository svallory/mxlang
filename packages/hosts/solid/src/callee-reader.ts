import type { CalleeInputReader, Node } from "@mxlang/core";
import { parse as parseMx } from "@mxlang/parser";

function parseSolidCalleeProgram(source: string, path: string): Node[] {
  return parseMx(source, path, {
    // The reader only needs module declarations. Compiling region bodies here
    // would resolve their imported callees, which recurses forever for two
    // `.solid.mx` files that import one another.
    mxRegionCompile: () => ({ code: "null" }),
  }).program.body as Node[];
}

/**
 * Reads a `.solid.mx` callee's `Input` for core's caller analysis. Registered
 * for `.solid.mx` by this package's `index.ts` (direct `compile` users) and
 * offered on the `solid-jsx` descriptor's file kind (tooling that installs
 * readers from the target table).
 */
export const readSolidCalleeInput: CalleeInputReader = ({
  path,
  source,
  analyze,
}) => {
  try {
    return analyze(parseSolidCalleeProgram(source, path));
  } catch {
    // A host reader is advisory. Malformed or unsupported SolidMX must never
    // make a caller invalid merely because its Input could not be inspected.
    return { kind: "none", path };
  }
};
