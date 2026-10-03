/**
 * Extension probing derives from the registered callee-input readers. Kept in
 * its own file because `registerCalleeInputReader` has no unregister: a
 * registration here would leak into other tests' probe lists.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readCalleeInput, registerCalleeInputReader } from "./callee-input.ts";
import { lookup } from "./test-targets.ts";

const directory = mkdtempSync(join(tmpdir(), "mx-callee-probes-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("callee-input extension probes", () => {
  it("probes a compound extension only once a reader registers it", () => {
    const caller = join(directory, "caller.mx");
    const path = join(directory, "widget.solid.mx");
    writeFileSync(path, "export default function W() { return null }\n");
    const target = { kind: "name", name: "W" } as const;
    const context = () => ({
      importer: caller,
      imports: new Map([["W", "./widget"]]),
      targets: lookup,
    });

    const before = readCalleeInput(target, context());
    expect(before.input.kind).toBe("unresolved");
    expect(before.dependencies).not.toContain(path);

    registerCalleeInputReader(".solid.mx", ({ path: p }) => ({
      kind: "none",
      path: p,
    }));
    expect(readCalleeInput(target, context())).toEqual({
      input: { kind: "none", path },
      dependencies: [path],
    });
  });
});
