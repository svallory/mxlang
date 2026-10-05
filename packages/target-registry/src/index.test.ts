import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTargetLookup,
  type TargetDescriptor,
  TargetLookupError,
  validateDescriptor,
} from "@mxlang/core";
import { afterAll, describe, expect, it } from "vitest";
import { builtinFileKinds, builtinLookup, builtinTargets } from "./index.ts";

const lookup = builtinLookup();

const NAMES = [
  "html",
  "astro-html",
  "solid-jsx",
  "preact-jsx",
  "react-jsx",
  "hono-jsx",
  "angular-template",
  "data",
];

const byName = (name: string): TargetDescriptor => {
  const found = builtinTargets.find((t) => t.name === name);
  if (!found) throw new Error(`no built-in target ${name}`);
  return found;
};

describe("builtinTargets", () => {
  it("lists the seven hosts in registration order, then the hostless `data`", () => {
    expect(builtinTargets.map((t) => t.name)).toEqual(NAMES);
    expect(lookup.hasTarget("data")).toBe(true);
  });

  it.each(NAMES)("%s passes validateDescriptor", (name) => {
    expect(() => validateDescriptor(byName(name))).not.toThrow();
  });

  it("every descriptor is version 0 and names its own package", () => {
    for (const t of builtinTargets) {
      expect(t.descriptorVersion).toBe(0);
      expect(t.packageName).toMatch(/^@mxlang\/[a-z]+$/);
    }
  });

  it("builds a builtinLookup over exactly those targets", () => {
    expect(lookup.targetNames()).toEqual(NAMES);
    for (const name of NAMES) expect(lookup.target(name)).toBe(byName(name));
    expect(lookup.target("solid")).toBeUndefined();
    expect(lookup.defaultTarget()).toBe("html");
  });
});

describe("defaultTag (decision 145)", () => {
  it("every built-in declares one: `div` for the html family, `object` for data", () => {
    expect(
      Object.fromEntries(builtinTargets.map((t) => [t.name, t.defaultTag])),
    ).toEqual({
      ...Object.fromEntries(
        builtinTargets
          .filter((t) => t.name !== "data")
          .map((t) => [t.name, "div"]),
      ),
      data: "object",
    });
    expect(builtinTargets.filter((t) => t.defaultTag === "div")).toHaveLength(
      7,
    );
  });
});

describe("shape of each descriptor", () => {
  it("html: no host, legacy host values, lazy translator, strict follows policy", () => {
    const html = byName("html");
    expect(html.host).toBeUndefined();
    expect(html.legacyHostValues).toEqual([
      { value: "html" },
      { value: "translator", deprecated: true },
    ]);
    expect(html.strict).toBeUndefined();
    expect(html.declarations?.strict).toBeDefined();
    expect(html.declarations?.default).not.toBe(html.declarations?.strict);
    expect(html.translator).toBeTypeOf("object");
  });

  it("astro-html: host astro, strict always, a type surface, html's declarations", () => {
    const astro = byName("astro-html");
    expect(astro.host?.name).toBe("astro");
    expect(astro.strict).toBe("always");
    expect(astro.typeSurface).toBeTypeOf("function");
    expect(astro.declarations).toBe(byName("html").declarations);
    expect(astro.legacyHostValues).toBeUndefined();
  });

  it("solid-jsx: merge-recorded mappings and one `solid` file kind", () => {
    const solid = byName("solid-jsx");
    expect(solid.mappings).toBe("merge-recorded");
    expect(solid.host?.name).toBe("solid");
    expect(solid.host?.fileKinds).toHaveLength(1);
    const [kind] = solid.host?.fileKinds ?? [];
    expect(kind?.segment).toBe("solid");
    expect(kind?.diagnosticSource).toBe("solidmx");
    expect(kind?.languageIds).toEqual(["solidmx", "SolidMX"]);
    expect(kind?.compileRegion).toBeTypeOf("function");
    expect(kind?.readCalleeInput).toBeTypeOf("function");
  });

  it.each([
    ["preact-jsx", "preact"],
    ["react-jsx", "react"],
    ["hono-jsx", "hono"],
  ])(
    "%s: host %s, a compile entry, no file kinds, no mapping override",
    (name, host) => {
      const target = byName(name);
      expect(target.host).toEqual({ name: host });
      expect(target.load).toBeTypeOf("function");
      expect(target.mappings).toBeUndefined();
      expect(target.typeSurface).toBeUndefined();
      expect(target.strict).toBeUndefined();
    },
  );

  it("angular-template: no load, pending phase 2, one `ng` file kind", () => {
    const ng = byName("angular-template");
    expect(ng.load).toBeUndefined();
    expect(ng.pending).toBe("phase 2");
    expect(ng.host?.name).toBe("angular");
    expect(ng.host?.fileKinds).toEqual([
      { segment: "ng", languageIds: ["ngmx"], diagnosticSource: "ngmx" },
    ]);
  });

  it("astro-html: the Astro template is a file kind of the astro host (decision 134), with no region compile or callee reader", () => {
    expect(byName("astro-html").host?.fileKinds).toEqual([
      {
        segment: "astro",
        languageIds: ["astromx"],
        diagnosticSource: "astromx",
      },
    ]);
  });

  it("only solid-jsx carries a region compile and a callee reader", () => {
    for (const t of builtinTargets) {
      for (const kind of t.host?.fileKinds ?? []) {
        expect(Boolean(kind.compileRegion)).toBe(t.name === "solid-jsx");
        expect(Boolean(kind.readCalleeInput)).toBe(t.name === "solid-jsx");
      }
    }
  });
});

describe("builtinLookup: packages and host values", () => {
  it.each([
    ["@mxlang/html", "html"],
    ["@mxlang/astro", "astro-html"],
    ["@mxlang/solid", "solid-jsx"],
    ["@mxlang/preact", "preact-jsx"],
    ["@mxlang/react", "react-jsx"],
    ["@mxlang/hono", "hono-jsx"],
    ["@mxlang/angular", "angular-template"],
    ["@mxlang/data", "data"],
  ])("fromPackage(%s) is %s", (pkg, name) => {
    expect(lookup.fromPackage(pkg)).toBe(name);
  });

  it("fromPackage ignores core, a target name and a stranger", () => {
    expect(lookup.fromPackage("@mxlang/core")).toBeUndefined();
    expect(lookup.fromPackage("solid-jsx")).toBeUndefined();
    expect(lookup.fromPackage("left-pad")).toBeUndefined();
  });

  it("lists the mx.host values in registration order, `translator` last of the html pair", () => {
    expect(lookup.hostValues()).toEqual([
      "html",
      "translator",
      "astro",
      "solid",
      "preact",
      "react",
      "hono",
      "angular",
    ]);
  });

  it.each([
    ["html", "html"],
    ["astro", "astro-html"],
    ["solid", "solid-jsx"],
    ["preact", "preact-jsx"],
    ["react", "react-jsx"],
    ["hono", "hono-jsx"],
    ["angular", "angular-template"],
  ])("hostTarget(%s) selects %s without a deprecation", (value, target) => {
    expect(lookup.hostTarget(value)).toEqual({ target });
  });

  it("hostTarget(translator) selects html and flags the alias deprecated", () => {
    expect(lookup.hostTarget("translator")).toEqual({
      target: "html",
      deprecated: true,
    });
  });

  it("hostTarget rejects target names, data and strangers", () => {
    for (const value of ["solid-jsx", "astro-html", "data", "bogus", ""]) {
      expect(lookup.hostTarget(value)).toBeUndefined();
    }
  });

  it("hostOf answers the host name, none for the hostless html", () => {
    expect(lookup.hostOf("html")).toBeUndefined();
    expect(lookup.hostOf("astro-html")).toBe("astro");
    expect(lookup.hostOf("angular-template")).toBe("angular");
    expect(lookup.hostOf("nope")).toBeUndefined();
  });

  it("hostFilterKey keeps `html` for html and the host name for the rest", () => {
    expect(lookup.hostFilterKey("html")).toBe("html");
    expect(lookup.hostFilterKey("astro-html")).toBe("astro");
    expect(lookup.hostFilterKey("solid-jsx")).toBe("solid");
    expect(lookup.hostFilterKey("angular-template")).toBe("angular");
  });

  it("moduleSegments are astro, solid and ng (target registration order)", () => {
    expect(lookup.moduleSegments()).toEqual(["astro", "solid", "ng"]);
  });

  it("attrTagSources are the seven host packages and @mxlang/data", () => {
    expect([...lookup.attrTagSources()].sort()).toEqual(
      [
        "@mxlang/angular",
        "@mxlang/astro",
        "@mxlang/data",
        "@mxlang/hono",
        "@mxlang/html",
        "@mxlang/preact",
        "@mxlang/react",
        "@mxlang/solid",
      ].sort(),
    );
  });
});

describe("the hostless `data` target", () => {
  const data = byName("data");

  it("has no host, no legacy host values and a data package of its own", () => {
    expect(data.host).toBeUndefined();
    expect(data.legacyHostValues).toBeUndefined();
    expect(data.packageName).toBe("@mxlang/data");
    expect(data.strict).toBeUndefined();
    expect(data.declarations?.default.name).toBe("data");
    expect(data.declarations?.strict).toBeUndefined();
  });

  it("adds no mx.host value, no file-kind segment and no filter key", () => {
    expect(lookup.hostValues()).not.toContain("data");
    expect(lookup.hostOf("data")).toBeUndefined();
    expect(lookup.hostFilterKey("data")).toBeUndefined();
    expect(builtinFileKinds.map((k) => k.segment)).toEqual([
      "astro",
      "solid",
      "ng",
    ]);
    expect(lookup.moduleSegments()).toEqual(["astro", "solid", "ng"]);
  });

  it("is selected by its package (note 4.1 rule 2) and is not the default", () => {
    expect(lookup.fromPackage("@mxlang/data")).toBe("data");
    expect(lookup.defaultTarget()).toBe("html");
  });

  it("a registry without it still builds (it is one entry, not a dependency)", () => {
    expect(() =>
      createTargetLookup(
        builtinTargets.filter((t) => t.name !== "data"),
        {
          reservedNames: ["astro-template"],
        },
      ),
    ).not.toThrow();
  });
});

describe("the reserved `astro-template` name", () => {
  const impostor: TargetDescriptor = {
    descriptorVersion: 0,
    name: "astro-template",
    packageName: "@acme/mx-astro",
    defaultTag: "node",
  };

  it("is not a built-in target", () => {
    expect(lookup.hasTarget("astro-template")).toBe(false);
  });

  it("a file-kind segment belongs to one host: a second host taking `astro` is a segment-conflict", () => {
    const rival: TargetDescriptor = {
      descriptorVersion: 0,
      name: "other-jsx",
      packageName: "@acme/other",
      defaultTag: "node",
      host: {
        name: "other",
        fileKinds: [{ segment: "astro", diagnosticSource: "othermx" }],
      },
    };
    let error: unknown;
    try {
      createTargetLookup([...builtinTargets, rival]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TargetLookupError);
    expect((error as TargetLookupError).rule).toBe("segment-conflict");
  });

  it("a builtinLookup built the registry's way refuses a third party that takes it", () => {
    let error: unknown;
    try {
      createTargetLookup([...builtinTargets, impostor], {
        reservedNames: ["astro-template"],
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TargetLookupError);
    expect((error as TargetLookupError).rule).toBe("reserved-name");
  });

  it("without the reservation the same descriptor is accepted (the reservation is the registry's, not core's)", () => {
    const open = createTargetLookup([...builtinTargets, impostor]);
    expect(open.hasTarget("astro-template")).toBe(true);
  });
});

describe("builtinFileKinds", () => {
  it("tags solid with the region pipeline, ng with ng-template and astro with astro-template", () => {
    expect(
      builtinFileKinds.map((k) => [k.segment, k.pipeline, k.diagnosticSource]),
    ).toEqual([
      ["astro", "astro-template", "astromx"],
      ["solid", "region", "solidmx"],
      ["ng", "ng-template", "ngmx"],
    ]);
  });

  it("keeps every field of the core file kind and adds only the pipeline", () => {
    const solid = builtinFileKinds.find((k) => k.segment === "solid");
    const source = byName("solid-jsx").host?.fileKinds?.[0];
    expect(solid?.languageIds).toBe(source?.languageIds);
    expect(solid?.compileRegion).toBe(source?.compileRegion);
    expect(solid?.readCalleeInput).toBe(source?.readCalleeInput);
  });

  it("the pipeline key is registry-only: core's descriptors carry none", () => {
    for (const t of builtinTargets) {
      for (const kind of t.host?.fileKinds ?? []) {
        expect("pipeline" in kind).toBe(false);
      }
    }
  });
});

describe("descriptors compile through load()", () => {
  const core = () => import("@mxlang/core");
  const work = mkdtempSync(join(tmpdir(), "mx-registry-load-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX interpolation, not a JS template
  const paragraph = "<p>${input.name}</p>";
  const source = `export interface Input { name: string }\n${paragraph}\n`;
  const page = join(work, "page.mx");
  writeFileSync(join(work, "package.json"), "{}");

  it.each([
    ["html", () => import("@mxlang/html").then((m) => m.compile(source, page))],
    [
      "astro-html",
      () =>
        import("@mxlang/html").then((m) =>
          m.compile(source, page, { strict: true }),
        ),
    ],
    [
      "solid-jsx",
      () =>
        import("@mxlang/solid").then((m) =>
          m.compileSolidUnit(source, { filename: page }),
        ),
    ],
    [
      "preact-jsx",
      () =>
        import("@mxlang/preact").then((m) => m.compilePreactMx(source, page)),
    ],
    [
      "react-jsx",
      () => import("@mxlang/react").then((m) => m.compileReactMx(source, page)),
    ],
    [
      "hono-jsx",
      () => import("@mxlang/hono").then((m) => m.compileHonoMx(source, page)),
    ],
  ])("%s emits what the host's own entry emits", async (name, direct) => {
    const compiler = byName(name).load?.(await core());
    const viaDescriptor = compiler?.compileModule(source, page, {
      strict: name === "astro-html",
    });
    const expected = await direct();
    expect(viaDescriptor?.code).toBe(expected.code);
    expect(viaDescriptor?.dependencies).toEqual(expected.dependencies);
    expect(viaDescriptor?.code.length).toBeGreaterThan(0);
  });

  it("forwards warnings and customTags to the host entry (preact-jsx)", async () => {
    const warnings: unknown[] = [];
    const compiler = byName("preact-jsx").load?.(await core());
    const result = compiler?.compileModule(source, page, {
      customTags: {},
      warnings: warnings as never,
    });
    expect(result?.code).toContain("input.name");
  });

  it("load() returns a fresh compiler object each time and never throws for the wired targets", async () => {
    for (const t of builtinTargets) {
      if (!t.load) continue;
      expect(t.load(await core())).toBeTypeOf("object");
    }
  });
});
