import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
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
  runtimeSpecifiers,
  undeclaredRuntimeImports,
} from "./pack-hygiene.ts";

// One block per package that ships (or will ship) a tarball. Needs a built
// `dist/` (`bun run build`), like `packages/parser/src/pack-contents.test.ts`.
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
    const packed = packedFiles(dir);
    const allowedTop = new Set(["package.json", "README.md", "LICENSE"]);

    it("declares a `files` allowlist", () => {
      expect(pkg.files).toEqual(["dist", ...p.extraTopLevel, "README.md"]);
    });

    it("packs only package.json, README, dist/** and its named extras", () => {
      const stray = packed.filter((f) => {
        if (allowedTop.has(f)) return false;
        const top = f.split("/")[0] ?? f;
        return top !== "dist" && !p.extraTopLevel.includes(top);
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
          /(^|\/)(src|fixtures?|test)\//.test(f) ||
          /\.test\.[cm]?[jt]s(\.map)?$/.test(f) ||
          /\.d\.ts\.map$/.test(f) ||
          /(^|\/)(moon\.yml|tsconfig[^/]*\.json)$/.test(f),
      );
      expect(junk).toEqual([]);
    });

    it("packs every main/types/bin/exports target, none into src", () => {
      const targets = entryTargets(pkg);
      expect(targets.length).toBeGreaterThan(0);
      expect(
        targets.filter((t) => t.startsWith("src/") || t.includes("/src/")),
      ).toEqual([]);
      expect(targets.filter((t) => !packed.includes(t))).toEqual([]);
    });

    if (p.declarations) {
      it("points `types` at an emitted declaration", () => {
        expect(pkg.types).toMatch(/^dist\/.*\.d\.ts$/);
      });
    } else {
      it("has no `types` entry (no declarations are emitted)", () => {
        expect(pkg.types).toBeUndefined();
      });
    }
  });

  describe(`${p.name} shipped runtime`, () => {
    it("imports only declared deps, its own name or node builtins", () => {
      expect(undeclaredRuntimeImports(dir, pkg, p.name)).toEqual([]);
    });
  });

  if (!p.declarations) continue;

  describe(`${p.name} emitted declarations`, () => {
    const distDir = join(dir, "dist");
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

    it("never reach outside dist/", () => {
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
