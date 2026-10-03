// Parity between the built-in descriptors and the closed lists and constants the
// tooling and core hold today. A later change deletes those constants and reads
// the descriptors instead; this file is the proof they agree, one row per
// constant. Each constant's `file:line` is cited where it is read, at the base
// commit this change was cut from.
//
// Constants that are not exported (`HOST_PACKAGES`, `MX_ATTR_TAG_SOURCES`) are
// read through the behavior they drive. The imports reach into sibling
// packages' sources by relative path, on purpose: the registry must not depend
// on the tooling, and the tooling will depend on the registry.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { angularDeclarations } from "@mxlang/angular";
import {
  type CalleeInput,
  HOST_MODULE_SEGMENTS,
  type HostDeclarations,
  resolveHostPolicy,
  resolveHostPolicyDetailed,
} from "@mxlang/core";
import { honoDeclarations } from "@mxlang/hono";
import { policy, strictPolicy, translator } from "@mxlang/html";
import { preactDeclarations } from "@mxlang/preact";
import { reactDeclarations } from "@mxlang/react";
import { solidDeclarations } from "@mxlang/solid";
import { afterAll, describe, expect, it, vi } from "vitest";
// core/src/host-policy.ts:71 (HOST_NAMES, exported)
import { HOST_NAMES } from "../../core/src/host-policy.ts";
// language-server/src/diagnose.ts:35 (SOLID_MX_LANGUAGE_IDS, exported)
import { SOLID_MX_LANGUAGE_IDS } from "../../tooling/language-server/src/diagnose.ts";
// typescript-plugin/src/amx-language.ts:32 (AMX_LANGUAGE_ID, exported)
// typescript-plugin/src/language.ts:42,45 (language ids, exported)
import { AMX_LANGUAGE_ID } from "../../tooling/typescript-plugin/src/amx-language.ts";
import {
  NG_MX_LANGUAGE_ID,
  SOLID_MX_LANGUAGE_ID,
} from "../../tooling/typescript-plugin/src/language.ts";
// typescript-plugin/src/mx-language.ts:315 (createAstroTypeSurface, exported)
import { createAstroTypeSurface } from "../../tooling/typescript-plugin/src/mx-language.ts";
import {
  builtinFileKinds,
  builtinTargets,
  builtinTargetLookup as lookup,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "mx-registry-parity-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
/** A project directory with the given package.json; returns the path of a `.mx` inside it. */
function project(pkg: unknown): string {
  const dir = join(work, `p${counter++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return join(dir, "a.mx");
}

const target = (name: string) => {
  const found = builtinTargets.find((t) => t.name === name);
  if (!found) throw new Error(name);
  return found;
};

// Relative `require("...")`, `import`/`export ... from "..."`, bare `import "..."`.
const SPECIFIER_RE =
  /\brequire\(\s*"([^"]+)"\s*\)|\bfrom\s+"([^"]+)"|\bimport\s+"([^"]+)"/g;

function resolveSibling(dir: string, spec: string): string | undefined {
  const base = resolve(dir, spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Every file under `root` reachable from `entry` through relative imports and requires. */
function reachableSources(entry: string, root: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  for (;;) {
    const file = queue.pop();
    if (!file) return [...seen];
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER_RE)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec?.startsWith(".")) continue;
      const resolved = resolveSibling(dirname(file), spec);
      if (resolved?.startsWith(root) && !seen.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
}

/** A function's text with vitest's per-module import aliases (`__vite_ssr_import_3__`) numbered alike. */
const sourceText = (fn: unknown) =>
  String(fn).replace(/__vite_ssr_import_\d+__/g, "__import__");

/**
 * Same declarations object, or (for a package whose `dist` is bundled once per
 * entry point, so the descriptor holds its own copy) the same fields with
 * functions of the same source text.
 */
function expectSame(actual: unknown, expected: unknown, path = "declarations") {
  if (Object.is(actual, expected)) return;
  if (typeof expected === "function") {
    expect(typeof actual, path).toBe("function");
    expect(sourceText(actual), path).toBe(sourceText(expected));
    return;
  }
  if (expected && typeof expected === "object") {
    expect(actual && typeof actual, path).toBe("object");
    const left = actual as Record<string, unknown>;
    const right = expected as Record<string, unknown>;
    expect(Object.keys(left).sort(), path).toEqual(Object.keys(right).sort());
    for (const key of Object.keys(right)) {
      expectSame(left[key], right[key], `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toEqual(expected);
}

describe("host names (core/src/host-policy.ts:71 HOST_NAMES, :99 isKnownHost)", () => {
  it("the targets' hosts, with html as the hostless one, are HOST_NAMES in order", () => {
    const hosts = builtinTargets.map((t) => t.host?.name ?? "html");
    expect(hosts).toEqual([...HOST_NAMES]);
  });

  it("mx.host accepts HOST_NAMES plus the deprecated `translator`", () => {
    expect(lookup.hostValues()).toEqual([
      ...HOST_NAMES.slice(0, 1),
      "translator",
      ...HOST_NAMES.slice(1),
    ]);
  });

  it("every accepted mx.host value resolves to the same host through today's resolver", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const value of lookup.hostValues()) {
      const selected = lookup.hostTarget(value);
      const expectedHost =
        selected && (lookup.hostOf(selected.target) ?? "html");
      const resolved = resolveHostPolicy(project({ mx: { host: value } }));
      expect(resolved.host, value).toBe(expectedHost);
    }
    vi.restoreAllMocks();
  });

  it("`translator` is the one deprecated value, and the resolver warns for exactly it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const value of lookup.hostValues()) {
      warn.mockClear();
      resolveHostPolicy(project({ mx: { host: value } }));
      const deprecated = lookup.hostTarget(value)?.deprecated === true;
      expect(warn.mock.calls.length > 0, value).toBe(deprecated);
    }
    vi.restoreAllMocks();
  });

  it("the unknown-host message lists the same values (host-policy.ts:349)", () => {
    const { diagnostics } = resolveHostPolicyDetailed(
      project({ mx: { host: "bogus" } }),
    );
    const message = diagnostics[0]?.message ?? "";
    const listed = /valid hosts: ([^(]*) \(/.exec(message)?.[1]?.split(", ");
    expect(listed).toEqual([...HOST_NAMES]);
  });
});

describe("host packages (core/src/host-policy.ts:81 HOST_PACKAGES, rule 2 at :282)", () => {
  it.each(builtinTargets.map((t) => [t.name, t.packageName] as const))(
    "a project with only %s's package picks the same host through today's resolver",
    (name, pkg) => {
      const resolved = resolveHostPolicy(
        project({ dependencies: { [pkg]: "*" } }),
      );
      expect(lookup.fromPackage(pkg)).toBe(name);
      expect(resolved.host).toBe(lookup.hostOf(name) ?? "html");
    },
  );

  it("`@mxlang/<host>` for every HOST_NAMES entry is a registered package", () => {
    const packages = builtinTargets.map((t) => t.packageName).sort();
    expect(packages).toEqual(HOST_NAMES.map((h) => `@mxlang/${h}`).sort());
  });
});

describe("attr-tag sources (core/src/callee-input.ts:145 MX_ATTR_TAG_SOURCES)", () => {
  it("is @mxlang/core plus @mxlang/<host> for every HOST_NAMES entry", () => {
    // The set the reader tests is `["@mxlang/core", ...HOST_NAMES.map(h => `@mxlang/${h}`)]`.
    // Core's own source is added by the reader, not by the lookup.
    const today = HOST_NAMES.map((host) => `@mxlang/${host}`);
    expect([...lookup.attrTagSources()].sort()).toEqual(today.sort());
  });
});

describe("module segments (core/src/scan.ts:93 HOST_MODULE_SEGMENTS)", () => {
  it("are the file-kind segments of the targets (same set; order follows target registration, not the constant's)", () => {
    expect([...lookup.moduleSegments()].sort()).toEqual(
      [...HOST_MODULE_SEGMENTS].sort(),
    );
    expect(HOST_MODULE_SEGMENTS).toContain("astro");
  });
});

describe("language ids and diagnostic sources", () => {
  it("solid: languageIds are language-server/src/diagnose.ts:35 SOLID_MX_LANGUAGE_IDS", () => {
    const [kind] = target("solid-jsx").host?.fileKinds ?? [];
    expect(new Set(kind?.languageIds)).toEqual(SOLID_MX_LANGUAGE_IDS);
    expect(kind?.languageIds).toContain(SOLID_MX_LANGUAGE_ID);
  });

  it("ng: languageIds are typescript-plugin/src/language.ts:45 NG_MX_LANGUAGE_ID", () => {
    const [kind] = target("angular-template").host?.fileKinds ?? [];
    expect(kind?.languageIds).toEqual([NG_MX_LANGUAGE_ID]);
  });

  it("astro: languageIds are typescript-plugin/src/amx-language.ts:32 AMX_LANGUAGE_ID, VS Code's `astromx` (decision 134)", () => {
    const [kind] = target("astro-html").host?.fileKinds ?? [];
    expect(kind?.languageIds).toEqual([AMX_LANGUAGE_ID]);
    expect(kind?.languageIds).toEqual(["astromx"]);
    const contributes = JSON.parse(
      readFileSync(join(here, "../../editors/vscode/package.json"), "utf8"),
    ).contributes.languages as { id: string; extensions?: string[] }[];
    const vscode = contributes.find((l) => l.extensions?.includes(".astro.mx"));
    expect(vscode?.id).toBe(kind?.languageIds?.[0]);
  });

  it("diagnosticSource is the label typescript-plugin/src/index.ts:235-241 puts on TS80001/2", () => {
    // `.solid.mx` -> "solidmx", `.ng.mx` -> "ngmx", `.astro.mx` -> "astromx".
    // The fallback "mx" is not a file kind.
    const sources = Object.fromEntries(
      builtinFileKinds.map((k) => [k.segment, k.diagnosticSource]),
    );
    expect(sources).toEqual({
      solid: "solidmx",
      ng: "ngmx",
      astro: "astromx",
    });
  });
});

describe("strict (language-server/src/diagnose.ts:188 resolveStrict, typescript-plugin/src/mx-language.ts:240)", () => {
  it("only astro is always strict", () => {
    for (const t of builtinTargets) {
      const host = t.host?.name ?? "html";
      expect(t.strict === "always", host).toBe(host === "astro");
    }
  });
});

describe("declarations (typescript-plugin/src/mx-language.ts:253-280, createHtmlMappings at :362)", () => {
  it("html and astro-html lower under html's policy and strictPolicy", () => {
    expectSame(target("html").declarations?.default, policy);
    expectSame(target("html").declarations?.strict, strictPolicy);
    expectSame(target("astro-html").declarations?.default, policy);
    expectSame(target("astro-html").declarations?.strict, strictPolicy);
  });

  const hostDeclarations: [string, HostDeclarations][] = [
    ["solid-jsx", solidDeclarations],
    ["preact-jsx", preactDeclarations],
    ["react-jsx", reactDeclarations],
    ["hono-jsx", honoDeclarations],
    ["angular-template", angularDeclarations],
  ];
  it.each(hostDeclarations)(
    "%s lowers under its host's own declarations",
    (name, expected) => {
      const declared = target(name).declarations;
      expectSame(declared?.default, expected);
      expect(declared?.strict).toBeUndefined();
    },
  );

  it("html's translator is the one the mapping pass uses for every target (D3, mx-language.ts:21)", () => {
    const fromDescriptor = target("html").translator as Record<string, unknown>;
    expectSame(
      Object.keys(fromDescriptor).sort(),
      Object.keys(translator).sort(),
    );
  });
});

describe("Astro type surface (typescript-plugin/src/mx-language.ts:315 createAstroTypeSurface)", () => {
  const surface = target("astro-html").typeSurface;
  const inputs = [
    "export default Card;",
    "const x = 1;\nexport default $mx_page_1;\n",
    "export interface Input { content: unknown }\nexport default render;",
  ];

  it.each(inputs)("rewrites %j exactly as the plugin does", (code) => {
    expect(surface?.(code)).toBe(createAstroTypeSurface(code));
  });

  it("throws the same error when there is no default export", () => {
    const code = "const x = 1;";
    let ours: unknown;
    let theirs: unknown;
    try {
      surface?.(code);
    } catch (e) {
      ours = e;
    }
    try {
      createAstroTypeSurface(code);
    } catch (e) {
      theirs = e;
    }
    expect((ours as Error).message).toBe((theirs as Error).message);
  });
});

describe("dist freshness (html and angular parity reads dist/descriptor.js)", () => {
  it.each(["html", "angular"])(
    "@mxlang/%s: dist/descriptor.js is no older than src/descriptor.ts and everything it reaches",
    (host) => {
      const src = join(here, `../../hosts/${host}/src`);
      const dist = join(src, "../dist/descriptor.js");
      expect(
        existsSync(dist),
        `rebuild: dist older than src (@mxlang/${host} dist/descriptor.js is missing)`,
      ).toBe(true);
      const distMtime = statSync(dist).mtimeMs;
      const stale = reachableSources(join(src, "descriptor.ts"), src).filter(
        (file) => statSync(file).mtimeMs > distMtime,
      );
      expect(
        stale,
        `rebuild: dist older than src (${stale.join(", ")})`,
      ).toEqual([]);
    },
  );
});

describe("mapping strategy (typescript-plugin/src/mx-language.ts:263 Solid merge)", () => {
  it("only solid merges recorded mappings", () => {
    for (const t of builtinTargets) {
      expect(t.mappings === "merge-recorded", t.name).toBe(
        t.name === "solid-jsx",
      );
    }
  });
});

describe("pending page compilation (typescript-plugin/src/mx-language.ts:244, vite-plugin/src/index.ts:155)", () => {
  it("only angular is unwired, with the text `phase 2`", () => {
    for (const t of builtinTargets) {
      expect(t.load === undefined, t.name).toBe(t.name === "angular-template");
    }
    expect(target("angular-template").pending).toBe("phase 2");
    // The sentence the tools print today, assembled from the descriptor.
    const t = target("angular-template");
    expect(
      `the ${t.host?.name} host is not wired into @mxlang/typescript-plugin yet (${t.pending})`,
    ).toBe(
      "the angular host is not wired into @mxlang/typescript-plugin yet (phase 2)",
    );
  });
});

describe("Solid file kind functions", () => {
  const [kind] = target("solid-jsx").host?.fileKinds ?? [];

  it("compileRegion is compileSolidMx (typescript-plugin/src/language.ts:36 solidRegionCompile)", async () => {
    const { compileSolidMx } = await import("@mxlang/solid");
    const input = {
      source: "<p>hi</p>",
      filename: join(work, "a.solid.mx"),
      baseOffset: 0,
      baseLine: 0,
      baseColumn: 0,
      importSpecifiers: new Map<string, string>(),
      moduleBindings: new Set<string>(),
      importDefaultFromMarkoOrMx: new Set<string>(),
      unknownModuleBindings: new Set<string>(),
    };
    const { source, ...rest } = input;
    const expected = compileSolidMx(source, rest);
    const actual = kind?.compileRegion?.(source, input);
    expect(actual?.code).toBe(expected.code);
    expect(actual?.code.length).toBeGreaterThan(0);
  });

  it("readCalleeInput hands the module's statements to analyze", () => {
    let seen: readonly unknown[] | undefined;
    const analyze = (program: readonly unknown[]): CalleeInput => {
      seen = program;
      return { kind: "none", path: "x" } as CalleeInput;
    };
    kind?.readCalleeInput?.({
      path: join(work, "c.solid.mx"),
      source: "export interface Input { name: string }\nexport const x = 1;\n",
      analyze,
    });
    expect(seen?.length).toBe(2);
  });

  it("readCalleeInput is advisory: unparsable source reads as `none`", () => {
    const path = join(work, "bad.solid.mx");
    const result = kind?.readCalleeInput?.({
      path,
      source: "export interface Input {",
      analyze: () => {
        throw new Error("analyze must not run for source that does not parse");
      },
    });
    expect(result).toEqual({ kind: "none", path });
  });
});
