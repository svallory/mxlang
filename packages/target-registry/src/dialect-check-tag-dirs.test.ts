/**
 * `tagDirs: []` through `checkDialectFile`, the entry the language server,
 * `mx-tsc` and the TypeScript plugin check a dialect file with: the dialect's
 * file gets nothing from the project's `tags/`, and an absent `tagDirs` still
 * means `["tags"]`. Core pins the same field through `lowerSource` and the
 * scan in `packages/core/src/dialect-tag-dirs-empty.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  probeProject,
} from "../../../test-fixtures/dialects/probe.ts";
import { checkDialectFile } from "./dialect-check.ts";

afterEach(() => cleanupProbeProjects());

/** `tags/badge.tag.ts` is a contract whose call needs a `label`. */
const BADGE = {
  "tags/badge.tag.ts":
    'export default { attributes: { label: { type: "string", required: true } } };\n',
};

const MISSING_LABEL = "`<badge>`: missing required attribute `label`";

describe("checkDialectFile and the dialect's `tagDirs`", () => {
  it('(c) absent `tagDirs` means `["tags"]`: the `tags/` contract applies to the call', () => {
    const project = probeProject(BADGE);
    const check = checkDialectFile(project.path("a.probe"), "<badge/>\n");
    expect(check?.source).toBe("Probe");
    expect(check?.diagnostics).toEqual([
      {
        severity: "error",
        message: MISSING_LABEL,
        line: 1,
        column: 0,
        offset: 0,
        end: { line: 1, column: 6, offset: 6 },
        code: "MX_MISSING_ATTRIBUTE",
      },
    ]);
  });

  it("(b) `tagDirs: []` closes `tags/`: the same call finds no contract", () => {
    const project = probeProject(BADGE, { manifest: { tagDirs: [] } });
    expect(checkDialectFile(project.path("a.probe"), "<badge/>\n")).toEqual({
      source: "Probe",
      diagnostics: [],
    });
  });

  it("`tagDirs: []` does not hide the dialect's own diagnostics", () => {
    const project = probeProject(BADGE, { manifest: { tagDirs: [] } });
    expect(
      checkDialectFile(project.path("a.probe"), "<y !bad/>\n")?.diagnostics,
    ).toEqual([
      {
        severity: "error",
        message: "bad probe",
        line: 1,
        column: 3,
        offset: 3,
        end: { line: 1, column: 7, offset: 7 },
        code: "PROBE_BAD",
      },
    ]);
  });

  it('`tagDirs: ["tags"]` written out is the same as absent', () => {
    const project = probeProject(BADGE, { manifest: { tagDirs: ["tags"] } });
    expect(
      checkDialectFile(project.path("a.probe"), "<badge/>\n")?.diagnostics.map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([MISSING_LABEL]);
  });

  it('(d) `tagDirs: "tags"` is the manifest error at the field, shown on the file', () => {
    const project = probeProject(BADGE, { manifest: { tagDirs: "tags" } });
    const check = checkDialectFile(project.path("a.probe"), "<badge/>\n");
    expect(check?.diagnostics).toHaveLength(1);
    expect(check?.diagnostics[0]?.message).toMatch(
      /^`mx\.dialect\.tagDirs` must be an array of the directory names the dialect's files discover tags in \(`\["components"\]`\), or `\[\]` for none \(in .*package\.json:\d+:\d+\)$/,
    );
  });
});
