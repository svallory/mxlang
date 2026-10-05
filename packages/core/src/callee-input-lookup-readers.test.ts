/**
 * Callee readers declared by the compile's own lookup: a file kind's
 * `readCalleeInput` is probed and used for a compile under that lookup with
 * nothing registered (`registerCalleeInputReader`), and only for that lookup.
 * Kept in its own file: the probe list is module state.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readCalleeInput } from "./callee-input.ts";
import {
  createTargetLookup,
  type TargetDescriptor,
} from "./target-descriptor.ts";
import { lookup } from "./test-targets.ts";

const directory = mkdtempSync(join(tmpdir(), "mx-callee-lookup-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("callee readers from the lookup", () => {
  it("reads a `.<segment>.mx` callee with the lookup's file-kind reader", () => {
    const caller = join(directory, "caller.mx");
    const path = join(directory, "widget.lookupkind.mx");
    writeFileSync(path, "export default function W() { return null }\n");
    const reader = vi.fn(({ path: p }: { path: string }) => ({
      kind: "none" as const,
      path: p,
    }));
    const host: TargetDescriptor = {
      descriptorVersion: 0,
      name: "lookupkind-jsx",
      packageName: "@example/lookupkind",
      defaultTag: "div",
      declarations: { default: { name: "@example/lookupkind" } },
      host: {
        name: "lookupkind",
        fileKinds: [
          {
            segment: "lookupkind",
            diagnosticSource: "lookupkind",
            compileRegion: () => ({ code: "null" }),
            readCalleeInput: reader,
          },
        ],
      },
    } as unknown as TargetDescriptor;
    const withKind = createTargetLookup([host]);
    const target = { kind: "name", name: "W" } as const;
    const context = (targets: typeof lookup) => ({
      importer: caller,
      imports: new Map([["W", "./widget"]]),
      targets,
    });

    // Another lookup neither probes the extension nor calls the reader.
    expect(readCalleeInput(target, context(lookup)).input.kind).toBe(
      "unresolved",
    );
    expect(reader).not.toHaveBeenCalled();

    expect(readCalleeInput(target, context(withKind))).toEqual({
      input: { kind: "none", path },
      dependencies: [path],
    });
    expect(reader).toHaveBeenCalledTimes(1);
  });
});
