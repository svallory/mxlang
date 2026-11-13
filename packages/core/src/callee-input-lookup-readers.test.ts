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

  // One case rule for file kinds: an upper-case `.<Segment>.MX` callee goes
  // to the same reader, and reads the same contract, as the lower-case name.
  it.each(["widget.casekind.mx", "Widget.CaseKind.MX"])(
    "reads %s with the file kind's reader",
    (name) => {
      const path = join(directory, name);
      writeFileSync(path, "export default function W() { return null }\n");
      const contract = {
        kind: "declared" as const,
        path,
        attributeTags: { tab: { multiple: false, renderable: true } },
      };
      const host = {
        descriptorVersion: 0,
        name: "casekind-jsx",
        packageName: "@example/casekind",
        defaultTag: "div",
        declarations: { default: { name: "@example/casekind" } },
        host: {
          name: "casekind",
          fileKinds: [
            {
              segment: "casekind",
              diagnosticSource: "casekind",
              compileRegion: () => ({ code: "null" }),
              readCalleeInput: () => contract,
            },
          ],
        },
      } as unknown as TargetDescriptor;
      expect(
        readCalleeInput(
          { kind: "name", name: "W" },
          {
            importer: join(directory, "caller.mx"),
            imports: new Map([["W", `./${name}`]]),
            targets: createTargetLookup([host]),
          },
        ),
      ).toEqual({ input: contract, dependencies: [path] });
    },
  );
});
