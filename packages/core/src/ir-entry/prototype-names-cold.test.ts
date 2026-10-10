// Its own file on purpose: vitest isolates modules per file, and each test
// clears Marko's lookup caches first, so no earlier parse can have hardened a
// lookup the parse-only scanner would then reuse (Marko caches a lookup by
// taglib ids, not by translator identity). Core's own tag table now answers
// the parse, so the clear is belt and braces; it keeps a cold start the case
// under test.

import { WEB_ELEMENTS } from "@mxlang/web-elements";
import { beforeEach, describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import { markoCompiler } from "../marko-frontend.ts";
import { tagRulesPreset } from "../tag-presets.ts";
import { scanAuthoredTags } from "./authored-tags.ts";
import { DEFAULT_TAG } from "./declarations.ts";
import { lowerSource } from "./index.ts";

beforeEach(() => {
  // Core's instance: the one `lowerSource` and the scanner compile with.
  markoCompiler().taglib.clearCaches?.();
});

const NAMES = ["toString", "constructor", "__proto__"] as const;
const child = { child: { parents: ["#root"] } } as Record<string, CustomTag>;

describe("cold lookup cache", () => {
  it.each(NAMES)(
    "an unknown <%s> parent above a contract error is reported, not the child",
    (name) => {
      const { ir, diagnostics } = lowerSource(
        `<${name}>\n  <child/>\n</${name}>\n`,
        "/p.mx",
        { unknownTags: "reject", customTags: child },
      );
      expect(ir).toBeUndefined();
      expect(diagnostics).toEqual([
        {
          severity: "error",
          message: `\`<${name}>\` is not a known tag: it has no contract in \`customTags\``,
          line: 1,
          column: 0,
          offset: 0,
        },
        {
          severity: "error",
          message: `\`<child>\` must be at the top level; found inside \`<${name}>\` (inside the unknown tag \`<${name}>\`; may resolve once it is declared)`,
          line: 2,
          column: 2,
          offset: 13 + (name.length - "toString".length),
        },
      ]);
    },
  );

  it.each(NAMES)("scanAuthoredTags lists <%s>", (name) => {
    expect(
      scanAuthoredTags(
        `<${name}/>\n`,
        "/p.mx",
        tagRulesPreset("none", WEB_ELEMENTS),
        undefined,
        DEFAULT_TAG,
      ),
    ).toEqual([
      { name, line: 1, column: 0, endLine: 1, endColumn: name.length + 3 },
    ]);
  });
});
