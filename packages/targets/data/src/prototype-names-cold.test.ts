// Its own file on purpose: vitest isolates modules per file, and each test
// clears Marko's lookup caches first, so no earlier parse can have hardened a
// lookup the parse-only scanner would then reuse (Marko caches a lookup by
// taglib ids, not by translator identity).
import { createRequire } from "node:module";
import type { CustomTag } from "@mxlang/core";
import { beforeEach, describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";
import { scanAuthoredTags } from "./scan.ts";

const require = createRequire(import.meta.url);

beforeEach(() => {
  (
    require("@marko/compiler") as typeof import("@marko/compiler")
  ).taglib.clearCaches();
});

const NAMES = ["toString", "constructor", "__proto__"] as const;
const child = { child: { parents: ["#root"] } } as Record<string, CustomTag>;

describe("cold lookup cache", () => {
  it.each(NAMES)(
    "an unknown <%s> parent above a contract error is reported, not the child",
    (name) => {
      const { tree, diagnostics } = parseData(
        `<${name}>\n  <child/>\n</${name}>\n`,
        "/p.mx",
        { unknownTags: "reject", customTags: child },
      );
      expect(tree).toBeUndefined();
      expect(diagnostics).toEqual([
        {
          severity: "error",
          message: `\`<${name}>\` is not a known tag: it has no contract in \`customTags\``,
          line: 1,
          column: 0,
          offset: 0,
        },
      ]);
    },
  );

  it.each(NAMES)("scanAuthoredTags lists <%s>", (name) => {
    expect(scanAuthoredTags(`<${name}/>\n`, "/p.mx", undefined)).toEqual([
      { name, line: 1, column: 0 },
    ]);
  });
});
