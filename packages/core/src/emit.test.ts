import { describe, expect, it } from "vitest";
import { drive, type Emitter, type IrNode } from "./index.ts";

/**
 * The driver's contract, which is mostly about what it refuses to do quietly.
 *
 * `Emitter` requires a method per IR kind so a host cannot forget one, but the
 * *driver* is what decides what happens to a kind nobody handles. Ignoring one
 * would drop authored content from a successful compile — the S8 class this
 * codebase's guards exist to close — so both unknown kinds and module-level
 * kinds that should never reach the body walk are hard errors.
 */

/** An emitter that records which methods the driver called. */
function recordingEmitter(): Emitter<string[]> & { calls: string[] } {
  const calls: string[] = [];
  const note =
    (name: string) =>
    (node: { kind: string }): void => {
      calls.push(`${name}:${node.kind}`);
    };
  return {
    calls,
    text: note("text"),
    interpolation: note("interpolation"),
    element: note("element"),
    component: note("component"),
    ifChain: note("ifChain"),
    forLoop: note("forLoop"),
    define: note("define"),
    constant: note("constant"),
    hoisted: note("hoisted"),
    delegatedTag: note("delegatedTag"),
    documentType: note("documentType"),
    comment: note("comment"),
    done: () => calls,
  };
}

const loc = { line: 1, column: 0 };

describe("drive", () => {
  it("dispatches each kind to its own emitter method", () => {
    const emitter = recordingEmitter();
    drive(emitter, [
      { kind: "Text", value: "x", loc },
      { kind: "Comment", value: "c", html: true, loc },
    ]);
    expect(emitter.calls).toEqual(["text:Text", "comment:Comment"]);
  });

  it("throws on an unknown IR kind rather than ignoring it", () => {
    // A forged node stands in for a kind from a newer core, or one a host
    // hand-built. TypeScript cannot catch either at the call site, so the
    // runtime guard is the one that has to hold: silently returning would
    // drop whatever the node represented, with nothing anywhere reporting it.
    const emitter = recordingEmitter();
    const forged = { kind: "FutureKind", loc } as unknown as IrNode;

    expect(() => drive(emitter, [forged])).toThrow(
      /unknown IR node kind "FutureKind"/,
    );
    expect(emitter.calls).toEqual([]);
  });

  it("throws on a module-level kind reaching the body walk", () => {
    // `lower()` lifts these into `Ir`'s own fields, so one arriving here
    // means the IR was hand-built; emitting it into the body would put an
    // `import` in the middle of a render function.
    const emitter = recordingEmitter();
    const stray = {
      kind: "Import",
      code: 'import x from "y";',
      bindings: ["x"],
      loc,
    } as IrNode;

    expect(() => drive(emitter, [stray])).toThrow(
      /unexpected module-level node kind "Import"/,
    );
  });
});
