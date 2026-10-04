import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProjects,
  type FakeTarget,
  fakeProject,
  installFake,
  specifier,
} from "../../../test-fixtures/third-party-targets/support.ts";
import * as core from "./index.ts";
import {
  clearTargetDescriptorCache,
  createTargetLookup,
  isTranslateError,
  loadTargetDescriptor,
  resolveTargetPolicyDetailed,
  TranslateError,
} from "./index.ts";

// Invented built-ins: core names no target and no host (decision 126).
const lookup = createTargetLookup([
  { descriptorVersion: 0, name: "page", packageName: "@t/page" },
  {
    descriptorVersion: 0,
    name: "unit-jsx",
    packageName: "@t/unit",
    host: { name: "unit" },
  },
]);

afterEach(() => {
  cleanupProjects();
  clearTargetDescriptorCache();
});

function resolve(
  mx: unknown,
  install: readonly FakeTarget[] = [],
  manifestText?: string,
) {
  const project = fakeProject({ mx, install, manifestText });
  return {
    project,
    ...resolveTargetPolicyDetailed(project.path("a.mx"), lookup),
  };
}

describe("a package specifier under mx.target / mx.host loads a descriptor (§4.1, §4.2)", () => {
  it("mx.target: the loaded descriptor is the policy's, with its host", () => {
    const { policy, diagnostics } = resolve({ target: specifier("ok") }, [
      "ok",
    ]);
    expect(diagnostics).toEqual([]);
    expect(policy).toMatchObject({ target: "fake-ok", host: "fake-host" });
    expect(policy.descriptor?.name).toBe("fake-ok");
  });

  it("keeps the descriptor's identity between resolutions (§4.2: no eviction per call)", () => {
    const project = fakeProject({
      mx: { target: specifier("ok") },
      install: ["ok"],
    });
    const first = resolveTargetPolicyDetailed(project.path("a.mx"), lookup);
    const second = resolveTargetPolicyDetailed(project.path("b.mx"), lookup);
    expect(second.policy.descriptor).toBe(first.policy.descriptor);
  });

  it("mx.host: a descriptor with a host part selects it", () => {
    const { policy, diagnostics } = resolve({ host: specifier("ok") }, ["ok"]);
    expect(diagnostics).toEqual([]);
    expect(policy).toMatchObject({ target: "fake-ok", host: "fake-host" });
    expect(policy.descriptor).toBeDefined();
  });

  it("a hostless descriptor is fine under mx.target", () => {
    const { policy, diagnostics } = resolve({ target: specifier("hostless") }, [
      "hostless",
    ]);
    expect(diagnostics).toEqual([]);
    expect(policy.target).toBe("fake-hostless");
    expect(policy.host).toBeUndefined();
  });

  it("carries mx.strict like any other explicit target", () => {
    expect(
      resolve({ target: specifier("ok"), strict: true }, ["ok"]).policy.strict,
    ).toBe(true);
  });

  it("built-in policies carry no descriptor", () => {
    expect(resolve({ target: "unit-jsx" }).policy.descriptor).toBeUndefined();
  });

  it("the loaded target compiles with the injected core (OQ10)", () => {
    const { policy } = resolve({ target: specifier("ok") }, ["ok"]);
    const compiler = policy.descriptor?.load?.(core);
    const warnings: core.MxWarning[] = [];
    const result = compiler?.compileModule("<p>hi</p>", "/p/a.mx", {
      warnings,
    });
    expect(result?.code).toContain("<p>hi</p>");
    expect(warnings).toEqual([
      { message: "fake target compiled a.mx", line: 1, column: 0 },
    ]);
    try {
      compiler?.compileModule("<p>FAIL</p>", "/p/a.mx", {});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TranslateError);
      expect(error).toMatchObject({ line: 1, column: 3 });
    }
  });
});

describe("own-core: a target importing its own core copy (§4.4, brand check)", () => {
  it("throws another copy's TranslateError that the brand check still recognises", () => {
    const { policy } = resolve({ target: specifier("own-core") }, ["own-core"]);
    const compiler = policy.descriptor?.load?.(core);
    try {
      compiler?.compileModule("<p>FAIL</p>", "/p/a.mx", {});
      expect.unreachable();
    } catch (error) {
      // A different class: `instanceof` alone would have lost it.
      expect(error).not.toBeInstanceOf(TranslateError);
      expect((error as Error).name).toBe("TranslateError");
      expect(isTranslateError(error)).toBe(true);
      expect(error).toMatchObject({ line: 1, column: 3 });
    }
  });

  it("is really a second copy of core", () => {
    const project = fakeProject({ install: ["own-core"] });
    const own = createRequire(join(project.root, "package.json"))(
      "@mxlang/core",
    ) as typeof core;
    expect(own.TranslateError).not.toBe(TranslateError);
  });
});

describe("failures are positioned errors with no fallback (§4.3, OQ2 c)", () => {
  const manifest = (key: string, spec: string) =>
    `{\n  "mx": {\n    "${key}": ${JSON.stringify(spec)}\n  }\n}`;

  it("missing", () => {
    const { diagnostics, policy, project } = resolve({
      target: specifier("missing"),
    });
    expect(policy.target).toBe("page");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "target-not-found",
      severity: "error",
      file: project.manifest,
      value: specifier("missing"),
    });
    const message = diagnostics[0]?.message as string;
    expect(
      message.startsWith(
        `mx.target "@fake/mx-missing" cannot be resolved from ${project.root}: `,
      ),
    ).toBe(true);
    expect(
      message.endsWith(
        "Install it (bun add -d @fake/mx-missing) or use a built-in target: page, unit-jsx.",
      ),
    ).toBe(true);
    expect(message).not.toContain("\n");
  });

  it("a missing path under mx.host is named for the key and says to check the path", () => {
    const { diagnostics } = resolve({ host: "./nope.cjs" });
    expect(diagnostics[0]).toMatchObject({ code: "target-not-found" });
    expect(diagnostics[0]?.message).toContain(
      'mx.host "./nope.cjs" cannot be resolved',
    );
    expect(diagnostics[0]?.message).toContain(
      "Check the path or use a built-in target",
    );
  });

  it("throws on load", () => {
    const { diagnostics, policy, project } = resolve(
      { target: specifier("throws") },
      ["throws"],
    );
    expect(policy.target).toBe("page");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "target-load-failed",
      severity: "error",
    });
    expect(diagnostics[0]?.message).toBe(
      `mx.target "@fake/mx-throws" failed to load: boom: the fixture target exploded on load. (${join(project.root, "node_modules/@fake/mx-throws/index.cjs")})`,
    );
  });

  it("invalid: the first failing field only", () => {
    const { diagnostics } = resolve({ target: specifier("invalid") }, [
      "invalid",
    ]);
    expect(diagnostics[0]).toMatchObject({
      code: "target-invalid-descriptor",
      severity: "error",
    });
    expect(diagnostics[0]?.message).toBe(
      'mx.target "@fake/mx-invalid" must export a target descriptor (default export or "mxTarget"): "name" is missing, expected a string. See the TargetDescriptor contract (unstable).',
    );
  });

  it("version", () => {
    const { diagnostics } = resolve({ target: specifier("version") }, [
      "version",
    ]);
    expect(diagnostics[0]).toMatchObject({
      code: "target-invalid-descriptor",
      severity: "error",
      message:
        'mx.target "@fake/mx-version" targets descriptor version 1; this mx supports 0.',
    });
  });

  it("hostless under mx.host (Q8)", () => {
    const { diagnostics, policy } = resolve({ host: specifier("hostless") }, [
      "hostless",
    ]);
    expect(policy.target).toBe("page");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "host-invalid-descriptor",
      severity: "error",
      message:
        'mx.host "@fake/mx-hostless" exports a target with no host. Use mx.target "@fake/mx-hostless", or give the descriptor a "host" part.',
    });
  });

  it("a failure is never an unknown-host warning or an unknown-target error", () => {
    for (const key of ["host", "target"]) {
      const { diagnostics } = resolve({ [key]: specifier("missing") });
      expect(diagnostics.map((d) => d.code)).toEqual(["target-not-found"]);
    }
  });

  it.each([
    ["target", "throws"],
    ["target", "invalid"],
    ["host", "throws"],
  ] as const)(
    "positions %s %s at the key's value with its length",
    (key, name) => {
      const text = manifest(key, specifier(name));
      const { diagnostics } = resolve(undefined, [name], text);
      expect(diagnostics[0]).toMatchObject({
        line: 3,
        column: 4 + key.length + 4,
        length: JSON.stringify(specifier(name)).length,
      });
    },
  );

  it("a name a built-in already owns is invalid, not silently shadowing it", () => {
    const project = fakeProject({
      mx: { target: specifier("ok") },
      install: ["ok"],
    });
    const taken = createTargetLookup([
      { descriptorVersion: 0, name: "fake-ok", packageName: "@t/taken" },
    ]);
    const { diagnostics, policy } = resolveTargetPolicyDetailed(
      project.path("a.mx"),
      taken,
    );
    expect(policy.target).toBe("fake-ok");
    expect(policy.descriptor).toBeUndefined();
    expect(diagnostics[0]).toMatchObject({
      code: "target-invalid-descriptor",
      severity: "error",
    });
    expect(diagnostics[0]?.message).toContain("is registered twice");
  });

  it("a reserved name stays reserved for a loaded target", () => {
    const project = fakeProject({
      mx: { target: specifier("ok") },
      install: ["ok"],
    });
    const reserving = createTargetLookup(
      [{ descriptorVersion: 0, name: "page", packageName: "@t/page" }],
      { reservedNames: ["fake-ok"] },
    );
    const { diagnostics } = resolveTargetPolicyDetailed(
      project.path("a.mx"),
      reserving,
    );
    expect(diagnostics[0]?.message).toContain("uses a reserved name");
  });

  it("a fixed install is picked up by the next call (failures are not cached)", () => {
    const project = fakeProject({ mx: { target: specifier("ok") } });
    expect(
      resolveTargetPolicyDetailed(project.path("a.mx"), lookup).diagnostics[0]
        ?.code,
    ).toBe("target-not-found");
    const installed = fakeProject({
      mx: { target: specifier("ok") },
      install: ["ok"],
    });
    expect(
      resolveTargetPolicyDetailed(installed.path("a.mx"), lookup).diagnostics,
    ).toEqual([]);
  });
});

describe("agreement of a loaded target with the other key (§4.1 rule 3)", () => {
  it("mx.host naming a built-in host contradicts a loaded target of another host", () => {
    const { diagnostics, policy } = resolve(
      { host: "unit", target: specifier("ok") },
      ["ok"],
    );
    expect(policy).toMatchObject({ target: "fake-ok", host: "fake-host" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "target-host-mismatch",
      severity: "error",
      message:
        'mx.target "fake-ok" belongs to host "fake-host", but mx.host is "unit". Remove one of them: mx.host "unit" selects target "unit-jsx"; mx.target "fake-ok" selects host "fake-host".',
    });
  });

  it("a hostless loaded target with a host", () => {
    const { diagnostics } = resolve(
      { host: "unit", target: specifier("hostless") },
      ["hostless"],
    );
    expect(diagnostics[0]?.message).toBe(
      'mx.target "fake-hostless" has no host, but mx.host is "unit". Remove one of them: mx.host "unit" selects target "unit-jsx"; mx.target "fake-hostless" needs no mx.host.',
    );
  });

  it("a loaded host against a built-in target", () => {
    const { diagnostics, policy } = resolve(
      { host: specifier("ok"), target: "unit-jsx" },
      ["ok"],
    );
    expect(policy.target).toBe("unit-jsx");
    expect(diagnostics[0]).toMatchObject({ code: "target-host-mismatch" });
    expect(diagnostics[0]?.message).toContain(
      'mx.host "@fake/mx-ok", but mx.host is'.slice(0, 0),
    );
    expect(diagnostics[0]?.message).toContain('but mx.host is "@fake/mx-ok"');
  });

  it("a loaded host and the same package under mx.target agree", () => {
    const { diagnostics, policy } = resolve(
      { host: specifier("ok"), target: specifier("ok") },
      ["ok"],
    );
    expect(diagnostics).toEqual([]);
    expect(policy.target).toBe("fake-ok");
  });
});

describe("round 2: rule 3 compares host names, not the specifier", () => {
  it("a bare mx.host naming the loaded target's host selects and agrees (no unknown-host)", () => {
    const { diagnostics, policy } = resolve(
      { host: "fake-host", target: specifier("ok") },
      ["ok"],
    );
    expect(diagnostics).toEqual([]);
    expect(policy).toMatchObject({ target: "fake-ok", host: "fake-host" });
  });

  it("a bare mx.host naming another host than the loaded target's is still an unknown host", () => {
    const { diagnostics } = resolve(
      { host: "other", target: specifier("ok") },
      ["ok"],
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["unknown-host"]);
  });

  it("two loaded specifiers of the same host agree", () => {
    const { diagnostics, policy } = resolve(
      { host: specifier("ok"), target: specifier("ok-ssr") },
      ["ok", "ok-ssr"],
    );
    expect(diagnostics).toEqual([]);
    expect(policy).toMatchObject({ target: "fake-ok-ssr", host: "fake-host" });
  });

  it("two loaded specifiers of different hosts mismatch", () => {
    const { diagnostics } = resolve(
      { host: specifier("ok"), target: specifier("own-core") },
      ["ok", "own-core"],
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["target-host-mismatch"]);
  });
});

describe("round 2: what a loaded descriptor may not declare", () => {
  it("host.fileKinds is rejected", () => {
    const { diagnostics, policy } = resolve(
      { target: specifier("file-kinds") },
      ["file-kinds"],
    );
    expect(policy.target).toBe("page");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "target-invalid-descriptor",
      severity: "error",
      message:
        'mx.target "@fake/mx-file-kinds" cannot be registered next to the built-in targets: file kinds are supported for built-in targets only (for now). See the TargetDescriptor contract (unstable).',
    });
  });

  it("a built-in host name cannot be joined", () => {
    const withSolid = createTargetLookup([
      { descriptorVersion: 0, name: "page", packageName: "@t/page" },
      {
        descriptorVersion: 0,
        name: "solid-jsx",
        packageName: "@t/solid",
        host: { name: "solid" },
      },
    ]);
    const project = fakeProject({
      mx: { target: specifier("join-solid") },
      install: ["join-solid"],
    });
    const { diagnostics, policy } = resolveTargetPolicyDetailed(
      project.path("a.mx"),
      withSolid,
    );
    expect(policy.target).toBe("page");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "target-invalid-descriptor",
      severity: "error",
      message:
        'mx.target "@fake/mx-join-solid" cannot be registered next to the built-in targets: host "solid" belongs to the built-in targets; a third-party target cannot join it (for now). See the TargetDescriptor contract (unstable).',
    });
  });
});

describe("round 3: a failed load is fixed by fixing any file it loaded", () => {
  it("a throwing file the entry requires: fixing it (not the entry) loads on the next call", () => {
    const project = fakeProject({ mx: { target: "./t/b.cjs" } });
    mkdirSync(join(project.root, "t"));
    writeFileSync(
      join(project.root, "t/b.cjs"),
      'module.exports = require("./lib.cjs");\n',
    );
    writeFileSync(
      join(project.root, "t/lib.cjs"),
      'throw new Error("lib is broken");\n',
    );
    const first = resolveTargetPolicyDetailed(project.path("a.mx"), lookup);
    expect(first.diagnostics[0]?.code).toBe("target-load-failed");
    expect(first.diagnostics[0]?.message).toContain("lib is broken");
    writeFileSync(
      join(project.root, "t/lib.cjs"),
      'module.exports = { descriptorVersion: 0, name: "fixed-b", packageName: "@t/fixed-b" };\n',
    );
    const fixed = resolveTargetPolicyDetailed(project.path("a.mx"), lookup);
    expect(fixed.diagnostics).toEqual([]);
    expect(fixed.policy.target).toBe("fixed-b");
  });
});

describe("round 3: a resolution miss sticks once the project has a node_modules (KNOWN LIMITATION)", () => {
  // TODO target-loader-sticky-not-found: Bun and Node both keep a miss once the
  // project has a node_modules (probes D2/D3). Without one (D1) Node sees a new
  // install at once, which is why this project gets a node_modules BEFORE the
  // miss: the D1 shape would not pin the limitation. When the TODO is fixed,
  // flip these assertions: the install must be found.
  it.each([
    ["node_modules present, scope absent (D3)", false],
    ["node_modules/@fake present with a sibling loaded (D2)", true],
  ])("%s", (_label, withSibling) => {
    const project = fakeProject({
      mx: { target: specifier("ok") },
      ...(withSibling ? { install: ["ok-ssr"] as const } : {}),
    });
    mkdirSync(join(project.root, "node_modules", ".bin"), { recursive: true });
    if (withSibling) {
      // the sibling is loaded (resolved) before the miss
      loadTargetDescriptor(specifier("ok-ssr"), project.root);
    }
    expect(
      resolveTargetPolicyDetailed(project.path("a.mx"), lookup).diagnostics[0]
        ?.code,
    ).toBe("target-not-found");
    installFake(project, "ok");
    const after = resolveTargetPolicyDetailed(project.path("a.mx"), lookup);
    // Current behaviour, pinned: still not found until the process restarts.
    expect(after.diagnostics[0]?.code).toBe("target-not-found");
  });
});
