import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTargetLookup,
  TargetDescriptorError,
  validateDescriptor,
} from "@mxlang/core";
import { afterAll, describe, expect, it } from "vitest";
import { dataDeclarations } from "./declarations.ts";
import descriptor from "./descriptor.ts";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "mx-data-descriptor-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("the data descriptor", () => {
  it("passes validateDescriptor", () => {
    expect(validateDescriptor(descriptor)).toBe(descriptor);
  });

  it("is a hostless target named data in @mxlang/data", () => {
    expect(descriptor.descriptorVersion).toBe(0);
    expect(descriptor.name).toBe("data");
    expect(descriptor.packageName).toBe("@mxlang/data");
    expect(descriptor.host).toBeUndefined();
    expect(descriptor.legacyHostValues).toBeUndefined();
    expect(descriptor.strict).toBeUndefined();
    expect(descriptor.pending).toBeUndefined();
    expect(descriptor.typeSurface).toBeUndefined();
  });

  it("lowers under the package's delegate-everything declarations only", () => {
    expect(descriptor.declarations?.default).toBe(dataDeclarations);
    expect(descriptor.declarations?.strict).toBeUndefined();
  });

  it("has no translator and no mapping mode (data PR 4 chooses it)", () => {
    expect(descriptor.translator).toBeUndefined();
    expect(descriptor.mappings).toBeUndefined();
  });

  it("rejects a descriptor that breaks the contract (the validator is live)", () => {
    for (const [patch, field] of [
      [{ descriptorVersion: 1 }, "descriptorVersion"],
      [{ name: "@mxlang/data" }, "name"],
      [{ packageName: "" }, "packageName"],
      [{ load: "compile.ts" }, "load"],
      [{ mappings: "merge" }, "mappings"],
    ] as const) {
      const bad = { ...descriptor, ...patch };
      expect(() => validateDescriptor(bad), field).toThrow(
        TargetDescriptorError,
      );
      try {
        validateDescriptor(bad);
      } catch (error) {
        expect((error as TargetDescriptorError).field).toBe(field);
      }
    }
  });
});

describe("the lookup over data", () => {
  it("builds alone, and data is hostless: no host, filter key or mx.host value", () => {
    const lookup = createTargetLookup([descriptor]);
    expect(lookup.targetNames()).toEqual(["data"]);
    expect(lookup.defaultTarget()).toBe("data");
    expect(lookup.hasTarget("data")).toBe(true);
    expect(lookup.fromPackage("@mxlang/data")).toBe("data");
    expect(lookup.attrTagSources()).toEqual(["@mxlang/data"]);
    expect(lookup.hostOf("data")).toBeUndefined();
    expect(lookup.hostFilterKey("data")).toBeUndefined();
    expect(lookup.hostValues()).toEqual([]);
    expect(lookup.hostTarget("data")).toBeUndefined();
    expect(lookup.moduleSegments()).toEqual([]);
  });

  it("load() returns the compile entry", () => {
    const compiler = descriptor.load?.({} as never);
    expect(typeof compiler?.compileModule).toBe("function");
  });
});

describe("light import", () => {
  // A fresh `bun` process lists the compiler modules left in `require.cache`.
  // The npm compiler (core from source) or core's bundled one (core's dist,
  // decision 159).
  const COMPILERS = String.raw`/node_modules\/(\.bun\/)?@marko[+/]compiler\/|\/marko-frontend\.cjs$/`;

  function probe(body: string): { loaded: string[]; value: unknown } {
    const file = join(work, `probe-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(
      file,
      `import descriptor from ${JSON.stringify(join(here, "descriptor.ts"))};
const compilers = () => Object.keys(require.cache).filter((k) => ${COMPILERS}.test(k));
const value = (() => { ${body} })();
console.log(JSON.stringify({ loaded: compilers(), value }));
`,
    );
    const run = spawnSync("bun", [file], { encoding: "utf8", cwd: here });
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout.trim().split("\n").at(-1) as string);
  }

  it("importing the descriptor loads no @marko/compiler", () => {
    expect(probe("return descriptor.name;")).toEqual({
      loaded: [],
      value: "data",
    });
  });

  it("load() alone loads no @marko/compiler", () => {
    const { loaded } = probe("descriptor.load!({} as never); return null;");
    expect(loaded).toEqual([]);
  });

  it("compiling does (positive control: the probe can see the compiler)", () => {
    const { loaded } = probe(
      `descriptor.load!({} as never).compileModule("<x a=1/>\\n", "a.mx", {}); return null;`,
    );
    expect(
      loaded.some(
        (k) => k.includes("@marko") || k.endsWith("marko-frontend.cjs"),
      ),
    ).toBe(true);
  });
});
