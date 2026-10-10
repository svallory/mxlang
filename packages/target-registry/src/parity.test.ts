// Parity between the built-in descriptors and the resolution, scanning and
// tooling rules that core's former closed lists encoded. Tooling is imported
// by relative path here: the registry
// must not depend on tooling, which now depends on the registry.

import { spawnSync } from "node:child_process";
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
import type { CalleeInput, HostDeclarations } from "@mxlang/core";
import { angularDeclarations } from "@mxlang/host-angular";
import { honoDeclarations } from "@mxlang/host-hono";
import { preactDeclarations } from "@mxlang/host-preact";
import { reactDeclarations } from "@mxlang/host-react";
import { solidDeclarations } from "@mxlang/host-solid";
import { policy, strictPolicy, translator } from "@mxlang/target-html";
import { afterAll, describe, expect, it, vi } from "vitest";
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
  builtinLookup,
  builtinTargets,
  defaultTarget,
  hostFilterKey,
  hostModuleSegment,
  hostValues,
  moduleSegments,
  resolveTargetPolicy,
  resolveTargetPolicyDetailed,
  scanCached,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The built-in lookup, built once for this file. */
const lookup = builtinLookup();
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

/** A function's text with vitest's per-module import aliases (`__vite_ssr_import_3__`) numbered alike, and the print differences between Bun's bundle and vitest's transform removed. */
const sourceText = (fn: unknown) =>
  String(fn)
    .replace(/__vite_ssr_import_\d+__/g, "__import__")
    // Bun prints an `() => undefined` arrow as `() => { return; }`, the
    // transform vitest applies to source prints it as `() => void 0`.
    .replace(/\{\s*return;\s*\}/g, "void 0")
    // Bun re-indents the bundled function body.
    .replace(/\s+/g, "");

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

describe("mx.host values", () => {
  it("are the targets' hosts, with the hostless target named by its legacy value", () => {
    // What `HOST_NAMES` used to list, read off the table instead: the host of
    // each target, and the one target that has none (named by its own
    // non-deprecated legacy `mx.host` value).
    expect(hostValues().filter((value) => value !== "translator")).toEqual(
      builtinTargets.map((t) => t.host?.name ?? "html"),
    );
  });

  it("mx.host accepts the hosts plus the one deprecated legacy value", () => {
    expect(hostValues()).toEqual([
      "html",
      "translator",
      "astro",
      "solid",
      "preact",
      "react",
      "hono",
      "angular",
    ]);
    expect(
      hostValues().filter((v) => lookup.hostTarget(v)?.deprecated === true),
    ).toEqual(["translator"]);
  });

  it("every accepted mx.host value resolves through the policy resolver", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const value of hostValues()) {
      const selected = lookup.hostTarget(value);
      const expectedHost = selected && lookup.hostOf(selected.target);
      const resolved = resolveTargetPolicy(project({ mx: { host: value } }));
      expect(resolved.host, value).toBe(expectedHost);
      expect(resolved.target, value).toBe(selected?.target);
    }
    vi.restoreAllMocks();
  });

  it("warns for exactly the deprecated value, and for nothing else", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const value of hostValues()) {
      warn.mockClear();
      resolveTargetPolicy(project({ mx: { host: value } }));
      const deprecated = lookup.hostTarget(value)?.deprecated === true;
      expect(warn.mock.calls.length > 0, value).toBe(deprecated);
    }
    vi.restoreAllMocks();
  });

  it("the unknown-host message lists the same values, byte-identically", () => {
    // The text every existing project sees. The list is every non-deprecated
    // value the lookup accepts, in registration order, with the deprecated one
    // named apart — which is exactly what the closed list produced (decision 07
    // Q9: the wording does not change).
    const { diagnostics } = resolveTargetPolicyDetailed(
      project({ mx: { host: "bogus" } }),
    );
    expect(diagnostics[0]?.message).toBe(
      `unknown mx.host "bogus"; valid hosts: ${hostValues()
        .filter((v) => lookup.hostTarget(v)?.deprecated !== true)
        .join(
          ", ",
        )} ('translator' is a deprecated alias for html). Ignoring it; the host is taken from the @mxlang dependencies instead.`,
    );
    expect(diagnostics[0]?.message).toContain(
      "valid hosts: html, astro, solid, preact, react, hono, angular ('translator' is a deprecated alias for html)",
    );
  });

  it("the malformed-package.json message still names the default target", () => {
    const dir = join(work, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{ not json");
    const { diagnostics } = resolveTargetPolicyDetailed(join(dir, "a.mx"));
    expect(diagnostics[0]?.code).toBe("malformed-package-json");
    expect(diagnostics[0]?.message).toContain(
      'using the default "html" host for the files under',
    );
    expect(defaultTarget()).toBe("html");
  });
});

describe("packages and rule 2 (the single target dependency)", () => {
  it.each(builtinTargets.map((t) => [t.name, t.packageName] as const))(
    "a project with only %s's package picks that target",
    (name, pkg) => {
      expect(lookup.fromPackage(pkg)).toBe(name);
      const resolved = resolveTargetPolicy(
        project({ dependencies: { [pkg]: "*" } }),
      );
      expect(resolved.target).toBe(name);
      expect(resolved.host).toBe(lookup.hostOf(name));
    },
  );

  it("every built-in target declares a distinct package", () => {
    expect(builtinTargets.map((t) => t.packageName).sort()).toEqual([
      "@mxlang/host-angular",
      "@mxlang/host-astro",
      "@mxlang/host-hono",
      "@mxlang/host-preact",
      "@mxlang/host-react",
      "@mxlang/host-solid",
      "@mxlang/target-html",
    ]);
  });

  it("a package no target declares picks nothing, so the default applies", () => {
    // `@mxlang/core` is a dependency of every target package and declares no
    // target itself; a project's own package does the same.
    expect(lookup.fromPackage("@mxlang/core")).toBeUndefined();
    expect(lookup.fromPackage("@mxlang/tsx-bridge")).toBeUndefined();
    const resolved = resolveTargetPolicy(
      project({ dependencies: { "@mxlang/core": "*" } }),
    );
    expect(resolved.target).toBe(defaultTarget());
  });

  it("two target packages are ambiguous and fall back to the default", () => {
    const resolved = resolveTargetPolicy(
      project({
        dependencies: { "@mxlang/host-solid": "*", "@mxlang/host-react": "*" },
      }),
    );
    expect(resolved.target).toBe(defaultTarget());
  });

  it("the filter key is the host name, or a hostless target's legacy value", () => {
    for (const t of builtinTargets) {
      expect(hostFilterKey(t.name), t.name).toBe(
        t.host?.name ?? (t.name === "html" ? "html" : undefined),
      );
    }
    // The value every existing `mx.tags[].hosts: ["html"]` entry matches.
    expect(hostFilterKey("html")).toBe("html");
  });
});

describe("attr-tag sources (what the callee reader asks the lookup)", () => {
  it("is every registered target's package, deduped", () => {
    // The reader adds `@mxlang/core` itself; the lookup reports the packages a
    // target declares, which is the set the closed list produced.
    expect([...lookup.attrTagSources()].sort()).toEqual(
      [
        "@mxlang/host-angular",
        "@mxlang/host-astro",
        "@mxlang/host-hono",
        "@mxlang/target-html",
        "@mxlang/host-preact",
        "@mxlang/host-react",
        "@mxlang/host-solid",
      ].sort(),
    );
  });
});

describe("module segments (the file kinds the lookup holds)", () => {
  it("are the file-kind segments of the targets, in registration order", () => {
    expect([...moduleSegments()].sort()).toEqual([
      "astro",
      "hono",
      "ng",
      "preact",
      "react",
      "solid",
    ]);
  });

  it("hostModuleSegment over the built-in set answers for a file kind only", () => {
    expect(hostModuleSegment("card.ng.mx")).toBe("ng");
    expect(hostModuleSegment("card.solid.mx")).toBe("solid");
    expect(hostModuleSegment("card.astro.mx")).toBe("astro");
    // A dotted name whose segment no target declares is not a module file.
    expect(hostModuleSegment("card.icon.mx")).toBeUndefined();
    expect(hostModuleSegment("card.mx")).toBeUndefined();
    expect(hostModuleSegment("card.ts")).toBeUndefined();
  });
});

describe("scanCached over the built-in set", () => {
  it("reports a bare unknown word in mx.tags[].hosts and stays quiet for a package specifier", () => {
    const dir = join(work, "restrictions");
    mkdirSync(join(dir, "extra-tags"), { recursive: true });
    writeFileSync(join(dir, "extra-tags", "thing.mx"), "<p/>\n");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        mx: {
          tags: [
            { dir: "extra-tags", hosts: ["html"] },
            { dir: "extra-tags", hosts: ["bogus"] },
            { dir: "extra-tags", hosts: ["@acme/mx-vue"] },
          ],
        },
      }),
    );
    const scan = scanCached(join(dir, "page.mx"));
    expect([...scan.tags.keys()]).toEqual(["thing"]);
    expect(
      scan.diagnostics
        .filter((d) => /unknown host/.test(d.message))
        .map((d) => d.message),
    ).toEqual(["`mx.tags` names an unknown host in `hosts`: bogus"]);
  });
});

describe("callee readers are installed from the table at registry creation", () => {
  it("a callee probe reaches a file kind's extension without importing its host", () => {
    // The #216 ordering hazard: `.solid.mx` was probed only once
    // `@mxlang/host-solid` had been imported for its side effect, so a second copy
    // of core in the process never saw the reader. The registry registers every
    // file kind's reader into its own core at creation, so importing *only* the
    // registry is enough. Proven in a fresh process, because the reader
    // registry is module state this test file has already populated.
    // Beside the package, not in the temp dir: a file outside the
    // workspace cannot resolve `@mxlang/*` at all.
    const probe = join(here, `.probe-${process.pid}.ts`);
    writeFileSync(
      probe,
      [
        'import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        "// The registry only: no `@mxlang/host-solid` import anywhere in this file.",
        'import { builtinLookup } from "@mxlang/targets";',
        'import { readCalleeInput } from "@mxlang/core";',
        'const dir = mkdtempSync(join(tmpdir(), "mx-probe-"));',
        "mkdirSync(dir, { recursive: true });",
        'writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p" }));',
        'writeFileSync(join(dir, "caller.mx"), "<c/>\\n");',
        'writeFileSync(join(dir, "card.solid.mx"), "export class C {}\\n");',
        "const result = readCalleeInput(",
        '  { kind: "name", name: "Card" },',
        "  {",
        '    importer: join(dir, "caller.mx"),',
        '    imports: new Map([["Card", "./card"]]),',
        "    targets: builtinLookup(),",
        "  },",
        ");",
        "console.log(JSON.stringify(result.input));",
      ].join("\n"),
    );
    try {
      const run = spawnSync("bun", [probe], { encoding: "utf8", cwd: here });
      expect(run.status, run.stderr).toBe(0);
      // Probed and read: the `.solid.mx` candidate resolved, so the extension
      // is in core's probe list without the host package having been imported.
      expect(run.stdout.trim()).not.toContain('"kind":"unresolved"');
      expect(run.stdout.trim()).toContain("card.solid.mx");
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

describe("registered file-kind language ids and diagnostic sources", () => {
  it("solid's, preact's, react's and hono's ids are the language server's region ids, and solid's matches the TS plugin", () => {
    const [solid] = target("solid-jsx").host?.fileKinds ?? [];
    const [preact] = target("preact-jsx").host?.fileKinds ?? [];
    const [react] = target("react-jsx").host?.fileKinds ?? [];
    const [hono] = target("hono-jsx").host?.fileKinds ?? [];
    expect(
      new Set([
        ...(solid?.languageIds ?? []),
        ...(preact?.languageIds ?? []),
        ...(react?.languageIds ?? []),
        ...(hono?.languageIds ?? []),
      ]),
    ).toEqual(SOLID_MX_LANGUAGE_IDS);
    expect(solid?.languageIds).toContain(SOLID_MX_LANGUAGE_ID);
  });

  it.each([
    ["react-jsx", ".react.mx"],
    ["preact-jsx", ".preact.mx"],
    ["hono-jsx", ".hono.mx"],
  ])("%s's first id is VS Code's language id for %s", (name, extension) => {
    const [kind] = target(name).host?.fileKinds ?? [];
    const contributes = JSON.parse(
      readFileSync(join(here, "../../editors/vscode/package.json"), "utf8"),
    ).contributes.languages as { id: string; extensions?: string[] }[];
    const vscode = contributes.find((l) => l.extensions?.includes(extension));
    expect(vscode?.id).toBe(kind?.languageIds?.[0]);
  });

  it("angular's id matches the TS plugin", () => {
    const [kind] = target("angular-template").host?.fileKinds ?? [];
    expect(kind?.languageIds).toEqual([NG_MX_LANGUAGE_ID]);
  });

  it("astro's id matches the TS plugin and VS Code", () => {
    const [kind] = target("astro-html").host?.fileKinds ?? [];
    expect(kind?.languageIds).toEqual([AMX_LANGUAGE_ID]);
    expect(kind?.languageIds).toEqual(["astromx"]);
    const contributes = JSON.parse(
      readFileSync(join(here, "../../editors/vscode/package.json"), "utf8"),
    ).contributes.languages as { id: string; extensions?: string[] }[];
    const vscode = contributes.find((l) => l.extensions?.includes(".astro.mx"));
    expect(vscode?.id).toBe(kind?.languageIds?.[0]);
  });

  it("the registry exposes the diagnostic source for each file kind", () => {
    expect(
      Object.fromEntries(
        builtinFileKinds.map((k) => [k.segment, k.diagnosticSource]),
      ),
    ).toEqual({
      solid: "solidmx",
      preact: "preactmx",
      react: "reactmx",
      hono: "honomx",
      ng: "ngmx",
      astro: "astromx",
    });
  });
});

describe("strict (language-server/src/diagnose.ts:188 resolveStrict, typescript-plugin/src/mx-language.ts:240)", () => {
  it("only astro is always strict", () => {
    for (const t of builtinTargets) {
      expect(t.strict === "always", t.name).toBe(t.name === "astro-html");
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
    "%s: dist/descriptor.js is no older than src/descriptor.ts and everything it reaches",
    (host) => {
      const group = host === "html" ? "targets" : "hosts";
      const src = join(here, `../../${group}/${host}/src`);
      const dist = join(src, "../dist/descriptor.js");
      expect(
        existsSync(dist),
        `rebuild: dist older than src (packages/${group}/${host} dist/descriptor.js is missing)`,
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
    const { compileSolidMx } = await import("@mxlang/host-solid");
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
