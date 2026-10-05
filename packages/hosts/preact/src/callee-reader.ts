import type { CalleeInputReader, Node } from "@mxlang/core";
import { parse as parseMx } from "@mxlang/parser";

/**
 * Reads a JSX region-file callee's `Input` (`.react.mx`, and the other JSX
 * region kinds that share this engine) for core's caller analysis: the JSX
 * counterpart of `@mxlang/solid`'s `readSolidCalleeInput`, offered on each
 * JSX descriptor's file kind.
 *
 * Only module declarations are read, so region bodies are not compiled
 * (`mxRegionCompile` returns `null`): compiling them would resolve their own
 * callees, which recurses forever for two region files importing each other.
 * The reader does not depend on the segment, since the declarations it reads
 * are plain TypeScript in every region kind. This is the one place the JSX
 * hosts import `@mxlang/parser`.
 */
export const readJsxCalleeInput: CalleeInputReader = ({
  path,
  source,
  analyze,
}) => {
  try {
    return analyze(
      parseMx(source, path, { mxRegionCompile: () => ({ code: "null" }) })
        .program.body as Node[],
    );
  } catch {
    // Advisory: an unreadable callee never makes its caller invalid.
    return { kind: "none", path };
  }
};
