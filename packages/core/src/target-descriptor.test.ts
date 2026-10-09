import { describe, expect, it } from "vitest";
import {
  createTargetLookup,
  type TargetDescriptor,
  TargetDescriptorError,
  TargetLookupError,
  validateDescriptor,
} from "./target-descriptor.ts";

/** A minimal valid hostless target; every test overrides what it exercises. */
function target(overrides: Record<string, unknown> = {}): TargetDescriptor {
  return {
    descriptorVersion: 0,
    name: "alpha",
    packageName: "@t/alpha",
    defaultTag: "node",
    ...overrides,
  } as TargetDescriptor;
}

/** A target belonging to host `host`. */
function hosted(
  name: string,
  host: string,
  extra: Record<string, unknown> = {},
  hostExtra: Record<string, unknown> = {},
): TargetDescriptor {
  return target({
    name,
    packageName: `@t/${host}`,
    host: { name: host, ...hostExtra },
    ...extra,
  });
}

function invalidField(value: unknown): TargetDescriptorError {
  try {
    validateDescriptor(value);
  } catch (error) {
    expect(error).toBeInstanceOf(TargetDescriptorError);
    return error as TargetDescriptorError;
  }
  throw new Error("expected validateDescriptor to throw");
}

function lookupRule(
  descriptors: readonly TargetDescriptor[],
  options?: { defaultTarget?: string; reservedNames?: readonly string[] },
): string {
  try {
    createTargetLookup(descriptors, options);
  } catch (error) {
    expect(error).toBeInstanceOf(TargetLookupError);
    return (error as TargetLookupError).rule;
  }
  throw new Error("expected createTargetLookup to throw");
}

describe("defaultTag (decision 145)", () => {
  it("is required on a target", () => {
    const { defaultTag: _omitted, ...rest } = target() as unknown as Record<
      string,
      unknown
    >;
    const error = invalidField(rest);
    expect(error.field).toBe("defaultTag");
    expect(error.message).toBe(
      "`defaultTag` is missing: the tag `<#id>`/`<.class>` stands for on this target, expected a string",
    );
  });

  it.each([
    [1, "is a number"],
    [null, "is null"],
    [true, "is a boolean"],
    [{}, "is an object"],
    ["", "is an empty string"],
  ])("rejects %j", (value, detail) => {
    const error = invalidField(target({ defaultTag: value }));
    expect(error.field).toBe("defaultTag");
    expect(error.message).toBe(
      `\`defaultTag\` ${detail}: the tag \`<#id>\`/\`<.class>\` stands for on this target, expected a string`,
    );
  });

  it("accepts any non-empty string, naming no tag itself", () => {
    expect(() =>
      validateDescriptor(target({ defaultTag: "anything" })),
    ).not.toThrow();
  });

  it("is checked before the later fields", () => {
    expect(invalidField(target({ defaultTag: 1, strict: "no" })).field).toBe(
      "defaultTag",
    );
  });

  it("host.defaultTag is an optional non-empty string", () => {
    expect(() =>
      validateDescriptor(hosted("a", "h", {}, { defaultTag: "slot" })),
    ).not.toThrow();
    for (const value of [1, "", null]) {
      const error = invalidField(hosted("a", "h", {}, { defaultTag: value }));
      expect(error.field).toBe("host.defaultTag");
    }
  });

  it("host.ambientTypes is an optional function", () => {
    expect(() =>
      validateDescriptor(hosted("a", "h", {}, { ambientTypes: () => [] })),
    ).not.toThrow();
    for (const value of [1, "astro/env.d.ts", ["astro/env.d.ts"]]) {
      const error = invalidField(hosted("a", "h", {}, { ambientTypes: value }));
      expect(error.field).toBe("host.ambientTypes");
    }
  });

  it("createTargetLookup refuses a descriptor without it", () => {
    const { defaultTag: _omitted, ...rest } = target() as unknown as Record<
      string,
      unknown
    >;
    expect(() =>
      createTargetLookup([rest as unknown as TargetDescriptor]),
    ).toThrow(TargetDescriptorError);
  });
});

describe("validateDescriptor", () => {
  it("returns the very object it was given when valid", () => {
    const value = target();
    expect(validateDescriptor(value)).toBe(value);
  });

  it("accepts every optional field in its documented shape", () => {
    const value = target({
      legacyHostValues: [
        { value: "alpha" },
        { value: "old", deprecated: true },
      ],
      strict: "always",
      declarations: { default: {}, strict: {} },
      translator: {},
      load: () => ({ compileModule: () => ({ code: "", dependencies: [] }) }),
      typeSurface: (code: string) => code,
      mappings: "merge-recorded",
      pending: "phase 2",
      host: {
        name: "acme",
        default: true,
        fileKinds: [
          {
            segment: "acme",
            languageIds: ["acmemx"],
            diagnosticSource: "acmemx",
            compileRegion: () => ({ code: "" }),
            readCalleeInput: () => ({ kind: "none" }),
          },
        ],
      },
    });
    expect(validateDescriptor(value)).toBe(value);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "alpha"],
    ["an array", []],
  ])("rejects %s as the whole export", (_label, value) => {
    const error = invalidField(value);
    expect(error.field).toBe("descriptor");
    expect(error.kind).toBe("invalid");
  });

  it("rejects a missing descriptorVersion as invalid, not as a version mismatch", () => {
    const { descriptorVersion: _omit, ...rest } = target();
    const error = invalidField(rest);
    expect(error.field).toBe("descriptorVersion");
    expect(error.kind).toBe("invalid");
    expect(error.message).toContain('"descriptorVersion" is missing');
  });

  it.each([1, 2, -1, 0.5])(
    "rejects descriptorVersion %s as a version mismatch",
    (version) => {
      const error = invalidField(target({ descriptorVersion: version }));
      expect(error.field).toBe("descriptorVersion");
      expect(error.kind).toBe("version");
      expect(error.found).toBe(version);
    },
  );

  it("rejects a non-number descriptorVersion as invalid", () => {
    const error = invalidField(target({ descriptorVersion: "0" }));
    expect(error.kind).toBe("invalid");
    expect(error.message).toContain('"descriptorVersion"');
    expect(error.message).toContain("expected the number 0");
  });

  it("names the first failing field only, in declaration order", () => {
    const error = invalidField({ descriptorVersion: 0, packageName: 7 });
    expect(error.field).toBe("name");
  });

  it('words a missing field as `"name" is missing, expected a string`', () => {
    const { name: _omit, ...rest } = target();
    expect(invalidField(rest).message).toBe(
      '"name" is missing, expected a string',
    );
  });

  it("words a mistyped field with what was found", () => {
    expect(invalidField(target({ name: 3 })).message).toBe(
      '"name" is a number, expected a string',
    );
  });

  it.each([
    "",
    "has space",
    "@scope/pkg",
    "./relative",
    "a/b",
    "-lead",
    "9lead",
  ])(
    "rejects the target name %j (it must be a bare word, never a specifier)",
    (name) => {
      expect(invalidField(target({ name })).field).toBe("name");
    },
  );

  it.each(["alpha", "solid-jsx", "a1", "X_y"])(
    "accepts the target name %j",
    (name) => {
      expect(() => validateDescriptor(target({ name }))).not.toThrow();
    },
  );

  it.each(["", 5, undefined])("rejects packageName %j", (packageName) => {
    expect(invalidField(target({ packageName })).field).toBe("packageName");
  });

  it("rejects legacyHostValues that is not an array of { value }", () => {
    expect(invalidField(target({ legacyHostValues: "html" })).field).toBe(
      "legacyHostValues",
    );
    expect(invalidField(target({ legacyHostValues: ["html"] })).field).toBe(
      "legacyHostValues[0]",
    );
    expect(
      invalidField(target({ legacyHostValues: [{ value: "" }] })).field,
    ).toBe("legacyHostValues[0].value");
    expect(
      invalidField(
        target({ legacyHostValues: [{ value: "a", deprecated: false }] }),
      ).field,
    ).toBe("legacyHostValues[0].deprecated");
  });

  it("rejects more than one non-deprecated legacy value (07 Q3), with or without a host", () => {
    const two = [{ value: "a" }, { value: "b" }];
    const error = invalidField(target({ legacyHostValues: two }));
    expect(error.field).toBe("legacyHostValues");
    expect(error.message).toContain("more than one non-deprecated");
    expect(
      invalidField(hosted("x", "h", { legacyHostValues: two })).field,
    ).toBe("legacyHostValues");
  });

  it.each(["@acme/x", "./x", "a/b", ""])(
    "rejects legacy host value %j (it would shadow specifier loading)",
    (value) => {
      expect(
        invalidField(target({ legacyHostValues: [{ value }] })).field,
      ).toBe("legacyHostValues[0].value");
    },
  );

  it("accepts one non-deprecated legacy value beside any number of deprecated ones", () => {
    expect(() =>
      validateDescriptor(
        target({
          legacyHostValues: [
            { value: "a", deprecated: true },
            { value: "b" },
            { value: "c", deprecated: true },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("accepts only deprecated legacy values (no filter key)", () => {
    expect(() =>
      validateDescriptor(
        target({ legacyHostValues: [{ value: "a", deprecated: true }] }),
      ),
    ).not.toThrow();
  });

  it.each(["policy", "always"])("accepts strict %j", (strict) => {
    expect(() => validateDescriptor(target({ strict }))).not.toThrow();
  });

  it("rejects an unknown strict mode, mappings mode, or non-function hooks", () => {
    expect(invalidField(target({ strict: "never" })).field).toBe("strict");
    expect(invalidField(target({ mappings: "guess" })).field).toBe("mappings");
    expect(invalidField(target({ load: {} })).field).toBe("load");
    expect(invalidField(target({ typeSurface: "x" })).field).toBe(
      "typeSurface",
    );
    expect(invalidField(target({ pending: 1 })).field).toBe("pending");
  });

  it("rejects declarations without a default object, or with a non-object strict", () => {
    expect(invalidField(target({ declarations: {} })).field).toBe(
      "declarations.default",
    );
    expect(invalidField(target({ declarations: { default: 1 } })).field).toBe(
      "declarations.default",
    );
    expect(
      invalidField(target({ declarations: { default: {}, strict: "x" } }))
        .field,
    ).toBe("declarations.strict");
    expect(invalidField(target({ declarations: "x" })).field).toBe(
      "declarations",
    );
  });

  it("rejects a `builtOn` that is not a bare word", () => {
    expect(invalidField(target({ builtOn: 5 })).field).toBe("builtOn");
    expect(invalidField(target({ builtOn: "" })).field).toBe("builtOn");
    expect(invalidField(target({ builtOn: "@a/b" })).field).toBe("builtOn");
    expect(() => validateDescriptor(target({ builtOn: "data" }))).not.toThrow();
  });

  it("rejects a `declarations.default.builtinTags` that is not an array of non-empty strings", () => {
    const withTags = (builtinTags: unknown) =>
      invalidField(target({ declarations: { default: { builtinTags } } }));
    expect(withTags(5).field).toBe("declarations.default.builtinTags");
    expect(withTags("object").field).toBe("declarations.default.builtinTags");
    expect(withTags(["object", 1]).field).toBe(
      "declarations.default.builtinTags[1]",
    );
    expect(withTags([""]).field).toBe("declarations.default.builtinTags[0]");
    expect(() =>
      validateDescriptor(
        target({ declarations: { default: { builtinTags: ["object"] } } }),
      ),
    ).not.toThrow();
  });

  it("rejects a host part with a bad name, default flag, or file kinds", () => {
    expect(invalidField(target({ host: "solid" })).field).toBe("host");
    expect(invalidField(target({ host: {} })).field).toBe("host.name");
    expect(invalidField(target({ host: { name: "@a/b" } })).field).toBe(
      "host.name",
    );
    expect(
      invalidField(target({ host: { name: "h", default: false } })).field,
    ).toBe("host.default");
    expect(
      invalidField(target({ host: { name: "h", fileKinds: "x" } })).field,
    ).toBe("host.fileKinds");
    expect(
      invalidField(target({ host: { name: "h", fileKinds: [1] } })).field,
    ).toBe("host.fileKinds[0]");
  });

  it("validates each file kind", () => {
    const kind = (extra: Record<string, unknown>) =>
      target({
        host: {
          name: "h",
          fileKinds: [{ segment: "h", diagnosticSource: "hmx", ...extra }],
        },
      });
    expect(invalidField(kind({ segment: "" })).field).toBe(
      "host.fileKinds[0].segment",
    );
    expect(invalidField(kind({ segment: "a.b" })).field).toBe(
      "host.fileKinds[0].segment",
    );
    expect(invalidField(kind({ segment: "mx" })).field).toBe(
      "host.fileKinds[0].segment",
    );
    expect(invalidField(kind({ diagnosticSource: undefined })).field).toBe(
      "host.fileKinds[0].diagnosticSource",
    );
    expect(invalidField(kind({ languageIds: "x" })).field).toBe(
      "host.fileKinds[0].languageIds",
    );
    expect(invalidField(kind({ languageIds: [1] })).field).toBe(
      "host.fileKinds[0].languageIds[0]",
    );
    expect(invalidField(kind({ compileRegion: 1 })).field).toBe(
      "host.fileKinds[0].compileRegion",
    );
    expect(invalidField(kind({ readCalleeInput: "x" })).field).toBe(
      "host.fileKinds[0].readCalleeInput",
    );
    expect(invalidField(kind({ completeTypecheckModule: {} })).field).toBe(
      "host.fileKinds[0].completeTypecheckModule",
    );
  });

  it("ignores unknown extra fields, so a newer descriptor of the same version still loads", () => {
    expect(() =>
      validateDescriptor(target({ somethingNew: true })),
    ).not.toThrow();
  });
});

describe("createTargetLookup", () => {
  const solid = hosted(
    "solid-jsx",
    "solid",
    {},
    { fileKinds: [{ segment: "solid", diagnosticSource: "solidmx" }] },
  );
  const react = hosted("react-jsx", "react");
  const html = target({
    name: "html",
    packageName: "@t/html",
    legacyHostValues: [
      { value: "html" },
      { value: "translator", deprecated: true },
    ],
  });
  const data = target({ name: "data", packageName: "@t/data" });
  const all = [html, data, solid, react];

  describe("configKey", () => {
    const keyed = target({
      name: "tree",
      packageName: "@t/tree",
      configKey: "data",
    });

    it("defaults to the target's name: no configKey, no new rule", () => {
      expect(() => createTargetLookup(all)).not.toThrow();
    });

    it("a configKey equal to another target's name is refused, on the descriptor that loaded second", () => {
      const impostor = target({
        name: "other",
        packageName: "@t/other",
        configKey: "data",
      });
      expect(lookupRule([keyed, impostor])).toBe("config-key-conflict");
      // The reverse order blames the other one: whoever loads second took the
      // already-claimed key.
      expect(
        lookupRule([
          target({ name: "plain", packageName: "@t/plain", configKey: "data" }),
          keyed,
        ]),
      ).toBe("config-key-conflict");
    });

    it("a configKey equal to another target's configKey is refused", () => {
      expect(
        lookupRule([
          keyed,
          target({
            name: "other",
            packageName: "@t/other",
            configKey: "data",
          }),
        ]),
      ).toBe("config-key-conflict");
    });

    it("a target whose name equals an earlier target's configKey is the one refused", () => {
      const named = target({ name: "data", packageName: "@t/named" });
      expect(lookupRule([keyed, named])).toBe("config-key-conflict");
    });

    it("a configKey equal to the target's own name is accepted (it is the default)", () => {
      expect(
        createTargetLookup([
          ...all,
          target({
            name: "self",
            packageName: "@t/self",
            configKey: "self",
          }),
        ]),
      ).toBeTypeOf("object");
    });

    it("distinct configKeys are accepted", () => {
      expect(
        createTargetLookup([
          keyed,
          target({
            name: "other",
            packageName: "@t/other",
            configKey: "other",
          }),
        ]),
      ).toBeTypeOf("object");
    });
  });

  describe("builtOn", () => {
    const built = (name: string, builtOn: string, pkg = `@t/${name}`) =>
      target({ name, packageName: pkg, builtOn });
    const message = (descriptors: TargetDescriptor[]): string => {
      try {
        createTargetLookup(descriptors);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected createTargetLookup to throw");
    };

    it("resolves the end of the chain as the base target; a target without builtOn is its own", () => {
      const lookup = createTargetLookup([
        data,
        built("mid", "data"),
        built("top", "mid"),
        html,
      ]);
      expect(lookup.baseTargetOf?.("top")).toBe("data");
      expect(lookup.baseTargetOf?.("mid")).toBe("data");
      expect(lookup.baseTargetOf?.("data")).toBe("data");
      expect(lookup.baseTargetOf?.("html")).toBe("html");
      expect(lookup.baseTargetOf?.("missing")).toBeUndefined();
    });

    it("is generic: any target can be built on any other", () => {
      const lookup = createTargetLookup([html, built("x", "html")]);
      expect(lookup.baseTargetOf?.("x")).toBe("html");
    });

    it("rejects an unregistered name, naming both targets", () => {
      const verdict = [data, built("mesh", "dta")];
      expect(lookupRule(verdict)).toBe("built-on-unknown");
      expect(message(verdict)).toBe(
        'target "mesh" is built on "dta", which is not a registered target (registered: data, mesh)',
      );
      expect(message([data, built("a", "b"), built("b", "c")])).toContain(
        'target "b" is built on "c"',
      );
      expect(message([data, solid, built("mesh", "solid")])).toBe(
        'target "mesh" is built on "solid", which is not a registered target (registered: data, solid-jsx, mesh); "solid" is a host name, and builtOn takes a target name (did you mean "solid-jsx"?)',
      );
    });

    it("rejects a target built on itself and a loop, naming the chain", () => {
      expect(lookupRule([built("a", "a")])).toBe("built-on-loop");
      expect(message([built("a", "a")])).toBe(
        'target "a" is built on itself: a -> a',
      );
      expect(lookupRule([built("a", "b"), built("b", "a")])).toBe(
        "built-on-loop",
      );
      expect(message([built("a", "b"), built("b", "c"), built("c", "a")])).toBe(
        'target "a" is built on itself: a -> b -> c -> a',
      );
    });
  });

  describe("target questions", () => {
    it("answers hasTarget, target and targetNames in registration order", () => {
      const lookup = createTargetLookup(all);
      expect(lookup.targetNames()).toEqual([
        "html",
        "data",
        "solid-jsx",
        "react-jsx",
      ]);
      expect(lookup.hasTarget("solid-jsx")).toBe(true);
      expect(lookup.hasTarget("solid")).toBe(false);
      expect(lookup.hasTarget("")).toBe(false);
      expect(lookup.target("data")).toBe(data);
      expect(lookup.target("nope")).toBeUndefined();
    });

    it("does not answer for inherited property names", () => {
      const lookup = createTargetLookup(all);
      for (const word of [
        "constructor",
        "toString",
        "__proto__",
        "hasOwnProperty",
      ]) {
        expect(lookup.hasTarget(word)).toBe(false);
        expect(lookup.target(word)).toBeUndefined();
        expect(lookup.hostTarget(word)).toBeUndefined();
        expect(lookup.hostOf(word)).toBeUndefined();
        expect(lookup.hostFilterKey(word)).toBeUndefined();
        expect(lookup.fromPackage(word)).toBeUndefined();
      }
    });

    it("defaults to the first target, or to the named one", () => {
      expect(createTargetLookup(all).defaultTarget()).toBe("html");
      expect(
        createTargetLookup(all, { defaultTarget: "data" }).defaultTarget(),
      ).toBe("data");
      expect(createTargetLookup([solid]).defaultTarget()).toBe("solid-jsx");
    });

    it("rejects an empty set and an unknown default", () => {
      expect(lookupRule([])).toBe("empty");
      expect(lookupRule(all, { defaultTarget: "nope" })).toBe(
        "unknown-default",
      );
    });

    it("validates every descriptor it is given, naming the offending one", () => {
      expect(() => createTargetLookup([target({ name: 3 })])).toThrow(
        TargetDescriptorError,
      );
    });
  });

  describe("distinctness (decision 132)", () => {
    it("rejects two targets with the same name", () => {
      expect(lookupRule([target(), target({ packageName: "@t/other" })])).toBe(
        "duplicate-target",
      );
    });

    it("rejects a target named like a host", () => {
      expect(
        lookupRule([hosted("solid-jsx", "solid"), hosted("solid", "x")]),
      ).toBe("target-is-host-name");
    });

    it("rejects a target named like its own host", () => {
      expect(lookupRule([hosted("solid", "solid")])).toBe(
        "target-is-host-name",
      );
    });

    it("rejects a target named like a host registered later, and one registered earlier", () => {
      const a = hosted("a-jsx", "a");
      const b = hosted("a", "b");
      expect(lookupRule([a, b])).toBe("target-is-host-name");
      expect(lookupRule([b, a])).toBe("target-is-host-name");
    });

    it("rejects a hostless target named like a host", () => {
      expect(
        lookupRule([target({ name: "solid", packageName: "@t/x" }), solid]),
      ).toBe("target-is-host-name");
    });

    it("accepts distinct names", () => {
      expect(() => createTargetLookup(all)).not.toThrow();
    });
  });

  describe("reserved names (07 Q5)", () => {
    it("rejects a descriptor whose name is in reservedNames", () => {
      expect(
        lookupRule([target({ name: "taken" })], { reservedNames: ["taken"] }),
      ).toBe("reserved-name");
    });

    it("rejects it wherever it appears in the set", () => {
      expect(
        lookupRule(
          [target({ packageName: "@t/a", name: "ok" }), hosted("taken", "h")],
          {
            reservedNames: ["other", "taken"],
          },
        ),
      ).toBe("reserved-name");
    });

    it("reserves nothing by default, and not the neighbouring names", () => {
      expect(() =>
        createTargetLookup([target({ name: "taken" })]),
      ).not.toThrow();
      expect(() =>
        createTargetLookup([target({ name: "taken-2" })], {
          reservedNames: ["taken"],
        }),
      ).not.toThrow();
    });

    it("the validator is name-agnostic", () => {
      expect(() =>
        validateDescriptor(target({ name: "astro-template" })),
      ).not.toThrow();
    });
  });

  describe("packageName", () => {
    it("rejects two hostless targets sharing a package", () => {
      expect(lookupRule([target(), target({ name: "beta" })])).toBe(
        "package-conflict",
      );
    });

    it("rejects a hostless target sharing a package with a hosted one, in either order", () => {
      const hostless = target({ name: "beta", packageName: "@t/solid" });
      expect(lookupRule([solid, hostless])).toBe("package-conflict");
      expect(lookupRule([hostless, solid])).toBe("package-conflict");
    });

    it("rejects targets of different hosts sharing a package", () => {
      expect(
        lookupRule([
          hosted("a-jsx", "a", { packageName: "@t/shared" }),
          hosted("b-jsx", "b", { packageName: "@t/shared" }),
        ]),
      ).toBe("package-conflict");
    });

    it("lets two targets of one host share a package; fromPackage returns the host's default (07 change 2)", () => {
      const main = hosted(
        "solid-jsx",
        "solid",
        { packageName: "@t/solid" },
        { default: true },
      );
      const dom = hosted("solid-dom", "solid", { packageName: "@t/solid" });
      for (const order of [
        [main, dom],
        [dom, main],
      ]) {
        const lookup = createTargetLookup(order);
        expect(lookup.fromPackage("@t/solid")).toBe("solid-jsx");
      }
    });

    it("maps each package to its target when packages differ", () => {
      const lookup = createTargetLookup(all);
      expect(lookup.fromPackage("@t/html")).toBe("html");
      expect(lookup.fromPackage("@t/data")).toBe("data");
      expect(lookup.fromPackage("@t/solid")).toBe("solid-jsx");
      expect(lookup.fromPackage("@t/unknown")).toBeUndefined();
      expect(lookup.fromPackage("@mxlang/core")).toBeUndefined();
    });

    it("dedupes attrTagSources by package name, in registration order", () => {
      const main = hosted(
        "solid-jsx",
        "solid",
        { packageName: "@t/solid" },
        { default: true },
      );
      const dom = hosted("solid-dom", "solid", { packageName: "@t/solid" });
      const lookup = createTargetLookup([html, main, dom, data]);
      expect(lookup.attrTagSources()).toEqual([
        "@t/html",
        "@t/solid",
        "@t/data",
      ]);
    });
  });

  describe("host.default", () => {
    it("is implied when a host has one target, and may be stated", () => {
      expect(createTargetLookup([solid]).hostTarget("solid")).toEqual({
        target: "solid-jsx",
      });
      const stated = hosted("solid-jsx", "solid", {}, { default: true });
      expect(createTargetLookup([stated]).hostTarget("solid")).toEqual({
        target: "solid-jsx",
      });
    });

    it("requires exactly one default when a host has several targets", () => {
      const a = hosted("solid-jsx", "solid", { packageName: "@t/solid" });
      const b = hosted("solid-dom", "solid", { packageName: "@t/solid" });
      expect(lookupRule([a, b])).toBe("host-default");
      const aDefault = hosted(
        "solid-jsx",
        "solid",
        { packageName: "@t/solid" },
        { default: true },
      );
      const bDefault = hosted(
        "solid-dom",
        "solid",
        { packageName: "@t/solid" },
        { default: true },
      );
      expect(lookupRule([aDefault, bDefault])).toBe("host-default");
    });

    it("picks the single default among several targets", () => {
      const a = hosted("solid-jsx", "solid", { packageName: "@t/solid" });
      const b = hosted(
        "solid-dom",
        "solid",
        { packageName: "@t/solid" },
        { default: true },
      );
      const lookup = createTargetLookup([a, b]);
      expect(lookup.hostTarget("solid")).toEqual({ target: "solid-dom" });
      expect(lookup.hostOf("solid-jsx")).toBe("solid");
      expect(lookup.hostOf("solid-dom")).toBe("solid");
    });
  });

  describe("host questions", () => {
    it("lists hostValues: host names and legacy values, deduped, in registration order", () => {
      expect(createTargetLookup(all).hostValues()).toEqual([
        "html",
        "translator",
        "solid",
        "react",
      ]);
    });

    it("resolves a host name to the host's default target", () => {
      const lookup = createTargetLookup(all);
      expect(lookup.hostTarget("solid")).toEqual({ target: "solid-jsx" });
      expect(lookup.hostTarget("react")).toEqual({ target: "react-jsx" });
    });

    it("resolves a legacy value to its target, flagging a deprecated one", () => {
      const lookup = createTargetLookup(all);
      expect(lookup.hostTarget("html")).toEqual({ target: "html" });
      expect(lookup.hostTarget("translator")).toEqual({
        target: "html",
        deprecated: true,
      });
    });

    it("does not resolve a target name under mx.host", () => {
      const lookup = createTargetLookup(all);
      expect(lookup.hostTarget("solid-jsx")).toBeUndefined();
      expect(lookup.hostTarget("data")).toBeUndefined();
    });

    it("reports hostOf: the host name, or undefined for a hostless target", () => {
      const lookup = createTargetLookup(all);
      expect(lookup.hostOf("solid-jsx")).toBe("solid");
      expect(lookup.hostOf("html")).toBeUndefined();
      expect(lookup.hostOf("data")).toBeUndefined();
      expect(lookup.hostOf("nope")).toBeUndefined();
    });

    it("rejects a legacy value that collides with another target's host name", () => {
      const clash = target({
        name: "legacy",
        packageName: "@t/legacy",
        legacyHostValues: [{ value: "solid" }],
      });
      expect(lookupRule([clash, solid])).toBe("host-value-conflict");
      expect(lookupRule([solid, clash])).toBe("host-value-conflict");
    });

    it("rejects two targets claiming the same legacy value", () => {
      const a = target({
        name: "a",
        packageName: "@t/a",
        legacyHostValues: [{ value: "same" }],
      });
      const b = target({
        name: "b",
        packageName: "@t/b",
        legacyHostValues: [{ value: "same", deprecated: true }],
      });
      expect(lookupRule([a, b])).toBe("host-value-conflict");
    });

    it("lets a hosted target list its own host name as a legacy value", () => {
      const own = hosted("solid-jsx", "solid", {
        legacyHostValues: [{ value: "solid" }],
      });
      expect(createTargetLookup([own]).hostTarget("solid")).toEqual({
        target: "solid-jsx",
      });
    });
  });

  describe("hostFilterKey (07 Q3)", () => {
    it("is the host name for a hosted target", () => {
      expect(createTargetLookup(all).hostFilterKey("solid-jsx")).toBe("solid");
    });

    it("is the single non-deprecated legacy value for a hostless target", () => {
      expect(createTargetLookup(all).hostFilterKey("html")).toBe("html");
    });

    it("ignores deprecated values: no ordering rule, the deprecated one is never the key", () => {
      const lookup = createTargetLookup([
        target({
          legacyHostValues: [
            { value: "old", deprecated: true },
            { value: "current" },
          ],
        }),
      ]);
      expect(lookup.hostFilterKey("alpha")).toBe("current");
    });

    it("is undefined for a hostless target with no non-deprecated legacy value", () => {
      const lookup = createTargetLookup([
        data,
        target({
          name: "old",
          packageName: "@t/old",
          legacyHostValues: [{ value: "o", deprecated: true }],
        }),
      ]);
      expect(lookup.hostFilterKey("data")).toBeUndefined();
      expect(lookup.hostFilterKey("old")).toBeUndefined();
    });

    it("prefers the host name over a legacy value on a hosted target", () => {
      const own = hosted("solid-jsx", "solid", {
        legacyHostValues: [{ value: "solidish" }],
      });
      expect(createTargetLookup([own]).hostFilterKey("solid-jsx")).toBe(
        "solid",
      );
    });
  });

  describe("moduleSegments", () => {
    it("lists every host file-kind segment and none for hostless targets", () => {
      const ng = hosted(
        "ng-template",
        "ng",
        {},
        { fileKinds: [{ segment: "ng", diagnosticSource: "ngmx" }] },
      );
      expect(createTargetLookup(all).moduleSegments()).toEqual(["solid"]);
      expect(createTargetLookup([html, data]).moduleSegments()).toEqual([]);
      expect(createTargetLookup([solid, ng]).moduleSegments()).toEqual([
        "solid",
        "ng",
      ]);
    });

    it("rejects one segment declared by two hosts", () => {
      const kinds = { fileKinds: [{ segment: "x", diagnosticSource: "xmx" }] };
      expect(
        lookupRule([
          hosted("a-jsx", "a", {}, kinds),
          hosted("b-jsx", "b", {}, kinds),
        ]),
      ).toBe("segment-conflict");
    });

    it("dedupes a segment repeated by two targets of one host", () => {
      const kinds = { fileKinds: [{ segment: "x", diagnosticSource: "xmx" }] };
      const a = hosted(
        "x-jsx",
        "x",
        { packageName: "@t/x" },
        { ...kinds, default: true },
      );
      const b = hosted("x-dom", "x", { packageName: "@t/x" }, kinds);
      expect(createTargetLookup([a, b]).moduleSegments()).toEqual(["x"]);
    });

    it("rejects the same segment twice within one host's own kinds", () => {
      const kind = { segment: "x", diagnosticSource: "xmx" };
      expect(
        lookupRule([hosted("x-jsx", "x", {}, { fileKinds: [kind, kind] })]),
      ).toBe("segment-conflict");
    });
  });

  it("returns frozen-looking read-only arrays that do not alias internal state", () => {
    const lookup = createTargetLookup(all);
    const names = lookup.targetNames() as string[];
    names.push("tampered");
    expect(lookup.targetNames()).toEqual([
      "html",
      "data",
      "solid-jsx",
      "react-jsx",
    ]);
  });
});
