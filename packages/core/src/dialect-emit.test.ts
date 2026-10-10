/**
 * What building a file calls: `emitFor` routes a file to its dialect and
 * returns that dialect's emit. Core is dialect zero, and its emit is the
 * target-driven whole-file compile; a routed dialect registers none, however
 * its module is written.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslateError } from "./core.ts";
import { type EmitRequest, emitFor } from "./dialect-emit.ts";
import * as core from "./index.ts";
import {
  createTargetLookup,
  type TargetCompiler,
  type TargetDescriptor,
} from "./target-descriptor.ts";
import { dialectProject } from "./test-dialect-project.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-dialect-emit-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const unwired = (identity: string, pending: string | undefined) =>
  `[${identity}|${pending ?? "-"}]`;

function target(
  overrides: Partial<TargetDescriptor> = {},
  compileModule: TargetCompiler["compileModule"] = () => ({
    code: "export default 1;",
    dependencies: [],
  }),
): { descriptor: TargetDescriptor; load: ReturnType<typeof vi.fn> } {
  const load = vi.fn(() => ({ compileModule }));
  return {
    load,
    descriptor: {
      descriptorVersion: 0,
      name: "fake",
      packageName: "@test/fake",
      defaultTag: "node",
      load,
      ...overrides,
    },
  };
}

function request(
  descriptor: TargetDescriptor,
  extra: Partial<EmitRequest> = {},
): EmitRequest {
  return {
    target: descriptor.name,
    targets: createTargetLookup([descriptor]),
    core,
    unwired,
    ...extra,
  };
}

describe("emitFor", () => {
  it("answers a plain .mx file with MX's own dialect and an emit", () => {
    const found = emitFor(join(dir, "page.mx"));
    expect(found.dialect).toEqual({ id: "mx", name: "MX" });
    expect(found.emit).toBeTypeOf("function");
  });

  it.each(["page.solid.mx", "page.astro.mx", "page.marko", "page.ts"])(
    "answers %s, a file no dialect claims, with MX's emit",
    (name) => {
      expect(emitFor(join(dir, name)).dialect.id).toBe("mx");
      expect(emitFor(join(dir, name)).emit).toBeTypeOf("function");
    },
  );

  it("answers the same emit for every file of MX's own", () => {
    expect(emitFor(join(dir, "a.mx")).emit).toBe(
      emitFor(join(dir, "b.mx")).emit,
    );
  });

  it("answers a routed dialect's file with the dialect and no emit", () => {
    dialectProject(dir, {
      manifest: { id: "mesh", name: "Mesh", extensions: [".mesh.mx"] },
      module: "export default { table: {} };",
    });
    const found = emitFor(join(dir, "a.mesh.mx"));
    expect(found.dialect).toMatchObject({ id: "mesh", name: "Mesh" });
    expect(found.emit).toBeUndefined();
    // MX's own files in the same project keep MX's emit.
    expect(emitFor(join(dir, "a.mx")).emit).toBeTypeOf("function");
  });

  it("a dialect cannot register an emit: one in its module is ignored", () => {
    dialectProject(dir, {
      module:
        "export default { table: {}, emit() { return { code: 'x', dependencies: [] }; } };",
    });
    const found = emitFor(join(dir, "a.tst"));
    expect(found.dialect.id).toBe("test");
    expect(found.emit).toBeUndefined();
  });

  it("a dialect cannot register an emit: the manifest has no field for one", () => {
    dialectProject(dir, { manifest: { emit: "./emit.mjs" } });
    expect(() => emitFor(join(dir, "a.tst"))).toThrow(
      "`mx.dialect.emit` is not a dialect manifest field (id, name, extensions, module)",
    );
  });

  describe("a file whose routing fails", () => {
    function clash(): void {
      dialectProject(dir, {
        packageName: "one",
        manifest: { id: "one", name: "One", extensions: [".dup", ".dup.mx"] },
        module: "export default { table: {} };",
      });
      dialectProject(dir, {
        packageName: "two",
        manifest: { id: "two", name: "Two", extensions: [".dup", ".dup.mx"] },
        module: "export default { table: {} };",
      });
    }

    it("throws the routing error when the file does not end in .mx", () => {
      clash();
      expect(() => emitFor(join(dir, "a.dup"))).toThrow(
        /two dialects claim `\.dup`/,
      );
    });

    it("is MX's emit when the file ends in .mx: the routing error is left to the compile", () => {
      clash();
      const found = emitFor(join(dir, "a.dup.mx"));
      expect(found.dialect.id).toBe("mx");
      expect(found.emit).toBeTypeOf("function");
    });
  });

  it("passes the caller's host segments on: a dialect claiming a host's file kind does not take it", () => {
    dialectProject(dir, {
      manifest: { id: "mesh", name: "Mesh", extensions: [".solid.mx"] },
      module: "export default { table: {} };",
    });
    // Nothing reserved: the dialect claims the file and registers no emit.
    expect(emitFor(join(dir, "a.solid.mx")).emit).toBeUndefined();
    // `solid` reserved: the claim is a routing error, which a `.mx` file's own compile reports.
    const found = emitFor(join(dir, "a.solid.mx"), { hostSegments: ["solid"] });
    expect(found.dialect.id).toBe("mx");
    expect(found.emit).toBeTypeOf("function");
  });
});

describe("MX's emit", () => {
  const file = "/project/page.mx";

  it("builds the source under the requested target with the tool's core", () => {
    const compileModule = vi.fn<TargetCompiler["compileModule"]>(() => ({
      code: "export default 2;",
      dependencies: ["/dep.mx"],
    }));
    const { descriptor, load } = target({}, compileModule);
    const customTags = {};
    const resolveImport = () => undefined;
    const { emit } = emitFor(file);
    const result = emit?.("<p/>\n", file, {
      ...request(descriptor),
      strict: true,
      customTags,
      defaultTag: "node",
      resolveImport,
    });
    expect(result).toEqual({
      code: "export default 2;",
      dependencies: ["/dep.mx"],
    });
    expect(load).toHaveBeenCalledWith(core);
    const options = compileModule.mock.calls[0]?.[2];
    expect(compileModule).toHaveBeenCalledWith(
      "<p/>\n",
      file,
      expect.anything(),
    );
    expect(options).toMatchObject({
      strict: true,
      customTags,
      defaultTag: "node",
      resolveImport,
    });
    // The emit's own inputs do not leak into the target's options.
    for (const key of ["target", "core", "unwired"]) {
      expect(options).not.toHaveProperty(key);
    }
  });

  it("hands the target the lookup it was asked under", () => {
    const compileModule = vi.fn<TargetCompiler["compileModule"]>(() => ({
      code: "",
      dependencies: [],
    }));
    const { descriptor } = target({}, compileModule);
    const input = request(descriptor);
    emitFor(file).emit?.("", file, input);
    expect(compileModule.mock.calls[0]?.[2].targets).toBe(input.targets);
  });

  it("lets the target's positioned error through unchanged", () => {
    const { descriptor } = target({}, (_source, filename) => {
      throw new TranslateError("nope", 3, 4, filename);
    });
    const error = (() => {
      try {
        emitFor(file).emit?.("", file, request(descriptor));
      } catch (caught) {
        return caught as TranslateError;
      }
    })();
    expect(error).toBeInstanceOf(TranslateError);
    expect([error?.message, error?.line, error?.column]).toEqual([
      "nope",
      3,
      4,
    ]);
  });

  it("a host target with no load: the tool's sentence names the host and the pending reason", () => {
    const { descriptor } = target({
      load: undefined,
      host: { name: "angular" },
      pending: "phase 2",
    });
    expect(() => emitFor(file).emit?.("", file, request(descriptor))).toThrow(
      new Error("[angular host|phase 2]"),
    );
  });

  it("a plain target with no load is named by its target name, with no reason", () => {
    const { descriptor } = target({ load: undefined });
    expect(() => emitFor(file).emit?.("", file, request(descriptor))).toThrow(
      new Error("[fake target|-]"),
    );
  });

  it("a target name the lookup does not hold is named too", () => {
    const { descriptor } = target();
    expect(() =>
      emitFor(file).emit?.("", file, request(descriptor, { target: "other" })),
    ).toThrow(new Error("[other target|-]"));
  });
});
