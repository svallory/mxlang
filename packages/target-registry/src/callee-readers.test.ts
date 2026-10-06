/**
 * A loaded host's `readCalleeInput` (decision 148): consulted when a compile
 * under that project's lookup reads a `.<segment>.mx` callee, and scoped to
 * that lookup. Two projects can load different hosts that declare the same
 * segment without one reading with the other's reader.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCalleeInput } from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  builtinLookup,
  lookupFor,
  resolveTargetPolicyDetailed,
} from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __mxReaderCalls?: string[] }).__mxReaderCalls;
});

/** A project whose `mx.target` is a local descriptor whose host `mesh` reads callees. */
function project(label: string, packageName: string) {
  const root = mkdtempSync(join(tmpdir(), `mx-callee-readers-${label}-`));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ mx: { host: "./t/d.cjs" } }),
  );
  mkdirSync(join(root, "t"));
  writeFileSync(
    join(root, "t/d.cjs"),
    `module.exports = {
  descriptorVersion: 0,
  name: "mesh-${label}",
  packageName: "${packageName}",
  defaultTag: "node",
  declarations: { default: { builtinTags: ["node"] } },
  host: {
    name: "mesh",
    fileKinds: [{
      segment: "mesh",
      diagnosticSource: "mesh",
      readCalleeInput: ({ path }) => {
        (globalThis.__mxReaderCalls ??= []).push("${label}:" + path);
        return { kind: "none", path };
      },
    }],
  },
};\n`,
  );
  writeFileSync(
    join(root, "widget.mesh.mx"),
    "export default function W() { return null }\n",
  );
  return root;
}

const calls = () =>
  (globalThis as { __mxReaderCalls?: string[] }).__mxReaderCalls ?? [];

/** Reads `<W/>`'s `Input` from `root/caller.mx` under the project's own lookup. */
function read(root: string) {
  const { policy, diagnostics } = resolveTargetPolicyDetailed(
    join(root, "caller.mx"),
  );
  expect(diagnostics.map((d) => d.message)).toEqual([]);
  return readCalleeInput(
    { kind: "name", name: "W" },
    {
      importer: join(root, "caller.mx"),
      imports: new Map([["W", "./widget"]]),
      targets: lookupFor(policy),
    },
  );
}

describe("a loaded host's readCalleeInput", () => {
  it("is consulted for a `.<segment>.mx` callee", () => {
    const root = project("one", "@t/mesh-one");
    const result = read(root);
    expect(result.input.kind).toBe("none");
    expect(calls()).toEqual([`one:${join(root, "widget.mesh.mx")}`]);
  });

  it("stays with the project that loaded it when another declares the same segment", () => {
    const a = project("a", "@t/mesh-a");
    const b = project("b", "@t/mesh-b");
    read(a);
    read(b);
    read(a);
    expect(calls()).toEqual([
      `a:${join(a, "widget.mesh.mx")}`,
      `b:${join(b, "widget.mesh.mx")}`,
      `a:${join(a, "widget.mesh.mx")}`,
    ]);
  });

  it("is not registered process-wide: a compile under the built-in lookup never sees it", () => {
    const root = project("solo", "@t/mesh-solo");
    read(root);
    const before = calls().length;
    const result = readCalleeInput(
      { kind: "name", name: "W" },
      {
        importer: join(root, "caller.mx"),
        imports: new Map([["W", "./widget"]]),
        targets: builtinLookup(),
      },
    );
    expect(result.input.kind).toBe("unresolved");
    expect(calls()).toHaveLength(before);
  });
});
