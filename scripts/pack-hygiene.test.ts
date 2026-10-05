import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RELOCATABLE_BANNER, RELOCATABLE_DEFINE } from "./bundled-build.ts";
import {
  bakedBuildPaths,
  declarationFiles,
  declaredNames,
  entryTargets,
  escapesRoot,
  isBuiltin,
  moduleSpecifiers,
  PACKED_PACKAGES,
  packageNameOf,
  packedFiles,
  pkgDirOf,
  readPackageJson,
  repoRoot,
  runtimeSpecifiers,
  undeclaredRuntimeImports,
} from "./pack-hygiene.ts";

// One block per package that ships (or will ship) a tarball. Needs a built
// `dist/` (`bun run build`), like `packages/tsx-bridge/src/pack-contents.test.ts`.
// The `skipLibCheck: false` consumer probe is `scripts/pack-probe.ts`, run
// from `verify`, not here.

describe("packageNameOf", () => {
  it("reduces a specifier to its package name, scope-aware", () => {
    expect(packageNameOf("bun")).toBe("bun");
    expect(packageNameOf("vscode-languageserver/node")).toBe(
      "vscode-languageserver",
    );
    expect(packageNameOf("@mxlang/core")).toBe("@mxlang/core");
    expect(packageNameOf("@mxlang/html/types/marko")).toBe("@mxlang/html");
  });
});

describe("isBuiltin", () => {
  it("flags node: and bare builtin specifiers", () => {
    expect(isBuiltin("node:fs")).toBe(true);
    expect(isBuiltin("fs")).toBe(true);
    expect(isBuiltin("fs/promises")).toBe(true);
    expect(isBuiltin("magic-string")).toBe(false);
    expect(isBuiltin("bun")).toBe(false);
  });
});

for (const p of PACKED_PACKAGES) {
  const dir = pkgDirOf(p);
  const pkg = readPackageJson(dir);

  describe(`${p.name} tarball`, () => {
    const packed = p.assets
      ? [
          ...new Set([
            ...packedFiles(dir, { needsDist: false, ignoreScripts: true }),
            ...p.assets.built,
          ]),
        ]
      : packedFiles(dir);
    const allowedTop = new Set(["package.json", "README.md", "LICENSE"]);
    // `dist/` for most packages; an assets package names its own top levels.
    const shippedTop = p.assets
      ? p.assets.files.map((f) => f.split("/")[0] ?? f)
      : ["dist", ...p.extraTopLevel];

    it("declares a `files` allowlist", () => {
      expect(pkg.files).toEqual(
        p.assets?.files ?? ["dist", ...p.extraTopLevel, "README.md"],
      );
    });

    it("packs only package.json, README, dist/** and its named extras", () => {
      const stray = packed.filter((f) => {
        if (allowedTop.has(f) || shippedTop.includes(f)) return false;
        return !shippedTop.includes(f.split("/")[0] ?? f);
      });
      expect(stray).toEqual([]);
    });

    if (p.distFiles) {
      const allowedDist = p.distFiles;
      it("packs only the allowed dist/ files (no dev-only build entries)", () => {
        expect(packed.filter((f) => f.startsWith("dist/")).sort()).toEqual(
          [...allowedDist].sort(),
        );
      });
    }

    it("ships no tests, fixtures, source maps of declarations or config", () => {
      const junk = packed.filter(
        (f) =>
          // The assets package ships `src/`: it is the C sources Zed and
          // node-gyp compile, not TypeScript.
          (p.assets
            ? /(^|\/)(fixtures?|test)\//.test(f)
            : /(^|\/)(src|fixtures?|test)\//.test(f)) ||
          /\.test\.[cm]?[jt]s(\.map)?$/.test(f) ||
          /\.d\.ts\.map$/.test(f) ||
          /(^|\/)(moon\.yml|tsconfig[^/]*\.json)$/.test(f),
      );
      expect(junk).toEqual([]);
    });

    it("bakes no build-machine path (file:/// or the build root) into shipped JS", () => {
      expect(bakedBuildPaths(dir, packed)).toEqual([]);
    });

    it("packs every main/types/bin/exports target, none into src", () => {
      const targets = entryTargets(pkg);
      expect(targets.length).toBeGreaterThan(0);
      expect(
        targets.filter((t) => t.startsWith("src/") || t.includes("/src/")),
      ).toEqual([]);
      expect(targets.filter((t) => !packed.includes(t))).toEqual([]);
    });

    if (p.assets) {
      it("builds the wasm and the injected TypeScript grammar in `prepack`", () => {
        // A tarball without them throws on the first import of /docmd.
        const prepack = (pkg as { scripts?: Record<string, string> }).scripts
          ?.prepack;
        expect(prepack).toContain("build:wasm");
        expect(prepack).toContain("build:ts-grammar");
      });
    }

    if (p.declarations) {
      it("points `types` at an emitted declaration", () => {
        expect(pkg.types).toMatch(
          p.assets ? /^highlight\/.*\.d\.mts$/ : /^dist\/.*\.d\.ts$/,
        );
      });
    } else {
      it("has no `types` entry (no declarations are emitted)", () => {
        expect(pkg.types).toBeUndefined();
      });
    }
  });

  describe(`${p.name} shipped runtime`, () => {
    it("imports only declared deps, its own name or node builtins", () => {
      expect(
        undeclaredRuntimeImports(
          dir,
          pkg,
          p.name,
          p.assets?.runtimeDir ?? "dist",
        ),
      ).toEqual([]);
    });
  });

  if (!p.declarations) continue;

  describe(`${p.name} emitted declarations`, () => {
    const distDir = join(dir, p.assets?.runtimeDir ?? "dist");
    const files = declarationFiles(distDir);
    const declared = declaredNames(pkg);
    const aliases = p.specifierAliases ?? {};

    it("has declarations to check", () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it("only import bare specifiers the package declares", () => {
      const undeclared: string[] = [];
      for (const file of files) {
        for (const { specifier } of moduleSpecifiers(file)) {
          if (specifier.startsWith(".") || isBuiltin(specifier)) continue;
          const name = packageNameOf(specifier);
          const via = aliases[name] ?? name;
          if (!declared.has(via))
            undeclared.push(`${file.slice(dir.length + 1)}: ${specifier}`);
        }
      }
      expect(undeclared).toEqual([]);
    });

    it("import no node builtins", () => {
      const builtins = files.flatMap((file) =>
        moduleSpecifiers(file)
          .filter(({ specifier }) => isBuiltin(specifier))
          .map(
            ({ specifier }) => `${file.slice(dir.length + 1)}: ${specifier}`,
          ),
      );
      expect(builtins).toEqual([]);
    });

    it("never reach outside the shipped directory", () => {
      const escapes = files.flatMap((file) =>
        moduleSpecifiers(file)
          .filter(({ specifier }) => escapesRoot(file, specifier, distDir))
          .map(
            ({ specifier }) => `${file.slice(dir.length + 1)}: ${specifier}`,
          ),
      );
      expect(escapes).toEqual([]);
    });

    for (const [specifier, via] of Object.entries(aliases)) {
      it(`declares \`${via}\` (for \`${specifier}\`) as an optional peer`, () => {
        expect(pkg.peerDependencies?.[via]).toBeTruthy();
        expect(pkg.peerDependenciesMeta?.[via]?.optional).toBe(true);
      });
    }
  });
}

describe("@mxlang/html ambient `*.mx` declaration", () => {
  const dir = pkgDirOf(
    PACKED_PACKAGES.find((p) => p.name === "@mxlang/html") ?? never(),
  );
  const pkg = readPackageJson(dir);

  it("is reachable through the exports map as `@mxlang/html/types/marko`", () => {
    expect((pkg.exports as Record<string, unknown>)["./types/marko"]).toBe(
      "./types/marko.d.ts",
    );
    expect(packedFiles(dir)).toContain("types/marko.d.ts");
  });
});

function never(): never {
  throw new Error("@mxlang/html is not in PACKED_PACKAGES");
}

describe("the relocatable build flags", () => {
  // `bundledBuild` passes RELOCATABLE_* to Bun.build; the published CJS builds
  // pass the same as CLI flags. They are two spellings of one setting, so a
  // change to one must show up in the other.
  const flagged = [
    "packages/tooling/tsc",
    "packages/tooling/typescript-plugin",
  ];
  for (const dir of flagged) {
    it(`${dir}'s build script carries every RELOCATABLE_DEFINE and the banner`, () => {
      const { scripts } = readPackageJson(join(repoRoot, dir)) as unknown as {
        scripts: { build: string };
      };
      for (const [key, value] of Object.entries(RELOCATABLE_DEFINE)) {
        expect(scripts.build).toContain(`--define ${key}=${value}`);
      }
      expect(scripts.build).toContain(`--banner '${RELOCATABLE_BANNER}'`);
      expect(scripts.build).toContain("scripts/bundled-build.ts dist/*.cjs");
    });
  }
});

describe("bakedBuildPaths", () => {
  it("flags a file:/// literal and the build root, only in JS files", () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-"));
    try {
      writeFileSync(join(dir, "a.cjs"), 'createRequire("file:///b/x.ts")');
      writeFileSync(join(dir, "b.js"), 'const r = "/build/root/x";');
      writeFileSync(join(dir, "c.js"), "clean");
      writeFileSync(join(dir, "d.d.ts"), 'import "file:///ignored"');
      expect(
        bakedBuildPaths(
          dir,
          ["a.cjs", "b.js", "c.js", "d.d.ts"],
          "/build/root",
        ),
      ).toEqual(["a.cjs", "b.js"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runtime bare-import check", () => {
  const scratch = mkdtempSync(join(tmpdir(), "runtime-imports-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const pkg = {
    name: "@x/pkg",
    dependencies: { declared: "1" },
    peerDependencies: { "@p/peer": "1" },
  };
  /** Runs the check over a fresh `dist/` holding one file. */
  const check = (code: string) => {
    const dir = mkdtempSync(join(scratch, "pkg-"));
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "bin.js"), code);
    return undeclaredRuntimeImports(dir, pkg, "@x/pkg", "dist");
  };

  it("collects static, dynamic and require specifiers", () => {
    const file = join(scratch, "all.js");
    writeFileSync(
      file,
      'import a from "a";\nexport * from "b/sub";\nawait import("c");\nconst d = require("@s/d/x");\n',
    );
    expect(runtimeSpecifiers(file).map((r) => r.specifier)).toEqual([
      "a",
      "b/sub",
      "c",
      "@s/d/x",
    ]);
  });

  it("accepts declared deps, peers, builtins, relative paths and the package itself", () => {
    expect(
      check(
        'import "declared/sub"; import "@p/peer"; import "node:fs"; import "fs/promises"; import "./x.js"; import "@x/pkg/runtime";',
        "ok",
      ),
    ).toEqual([]);
  });

  it("fails a planted undeclared import, in every syntax", () => {
    for (const code of [
      'import x from "undeclared-a";',
      'export { y } from "undeclared-a";',
      'await import("undeclared-a");',
      'require("undeclared-a");',
    ]) {
      expect(check(code)).toEqual(["dist/bin.js: undeclared-a"]);
    }
  });
});
