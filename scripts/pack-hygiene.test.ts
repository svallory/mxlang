import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RELOCATABLE_BANNER, RELOCATABLE_DEFINE } from "./bundled-build.ts";
import {
  babelFlagReads,
  bakedBuildPaths,
  declarationFiles,
  declaredNames,
  entryTargets,
  escapesRoot,
  forkNoticeProblems,
  isBuiltin,
  moduleSpecifiers,
  PACKED_PACKAGES,
  packageNameOf,
  packedFiles,
  partitionPinned,
  pkgDirOf,
  privateWorkspaceImports,
  readPackageJson,
  repoRoot,
  runtimeSpecifiers,
  undeclaredRuntimeImports,
  workspacePrivacy,
} from "./pack-hygiene.ts";
import {
  BABEL_FORK_MARKER,
  forkCarriers,
  NOTICES_FILE,
  writeThirdPartyNotices,
} from "./third-party-notices.ts";

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
    expect(packageNameOf("@mxlang/target-html/types/marko")).toBe(
      "@mxlang/target-html",
    );
  });
});

describe("privateWorkspaceImports", () => {
  const privacy = new Map([
    ["@mxlang/parser", true],
    ["@mxlang/core", false],
  ]);
  const isPrivate = (name: string) => privacy.get(name) === true;

  it("flags a private workspace specifier, not a public, third-party, relative or builtin one", () => {
    const refs = [
      "@mxlang/parser/lexer",
      "@mxlang/core",
      "typescript",
      "./x.js",
      "node:fs",
    ].map((specifier) => ({ specifier, file: "/d/index.d.ts" }));
    expect(privateWorkspaceImports(refs, isPrivate)).toEqual([
      { specifier: "@mxlang/parser/lexer", file: "/d/index.d.ts" },
    ]);
  });

  it("reads each workspace package's own `private` flag", () => {
    const real = workspacePrivacy();
    expect(real.get("@mxlang/parser")).toBe(true);
    expect(real.get("@mxlang/babel")).toBe(true);
    expect(real.get("@mxlang/core")).toBe(false);
    expect(real.get("@mxlang/web-elements")).toBe(false);
  });
});

describe("partitionPinned", () => {
  const dirs = new Map([
    ["@mxlang/core", "/r/packages/core"],
    ["@mxlang/host-solid", "/r/packages/hosts/solid"],
    ["@mxlang/web-elements", "/r/packages/web-elements"],
    ["@mxlang/targets", "/r/packages/target-registry"],
  ]);
  const manifests = new Map<string, { private?: boolean }>([
    ["/r/packages/core", {}],
    ["/r/packages/hosts/solid", { private: true }],
    ["/r/packages/web-elements", { private: false }],
    ["/r/packages/target-registry", { private: true }],
  ]);
  const read = (dir: string) => manifests.get(dir) ?? {};

  it("stubs a private package and packs a public one, in the given order", () => {
    expect(
      partitionPinned(
        [
          "@mxlang/core",
          "@mxlang/host-solid",
          "@mxlang/web-elements",
          "@mxlang/targets",
        ],
        (name) => dirs.get(name),
        read,
      ),
    ).toEqual({
      pack: ["@mxlang/core", "@mxlang/web-elements"],
      stub: ["@mxlang/host-solid", "@mxlang/targets"],
    });
  });

  it("throws naming a package that has no workspace dir", () => {
    expect(() =>
      partitionPinned(
        ["@mxlang/core", "@mxlang/gone"],
        (name) => dirs.get(name),
        read,
      ),
    ).toThrow("pinned workspace dependency @mxlang/gone has no workspace dir");
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
    const allowedTop = new Set([
      "package.json",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
    ]);
    // `dist/` for most packages; an assets package names its own top levels.
    const shippedTop = p.assets
      ? p.assets.files.map((f) => f.split("/")[0] ?? f)
      : ["dist", ...p.extraTopLevel];

    it("declares a `files` allowlist", () => {
      expect(pkg.files).toEqual(
        p.assets?.files ?? [
          "dist",
          ...p.extraTopLevel,
          "README.md",
          "CHANGELOG.md",
        ],
      );
    });

    // A private package is never published, so it needs no licence file; every
    // package that can be published ships its MIT text (npm adds `LICENSE`
    // to a tarball whatever `files` says, so only the file's existence counts).
    if (!(pkg as { private?: boolean }).private) {
      it("packs a LICENSE", () => {
        expect(packed).toContain("LICENSE");
      });
    }

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

    it("reads no Babel build flag (process.env.BABEL_8_BREAKING, IS_PUBLISH) in shipped JS", () => {
      expect(babelFlagReads(dir, packed)).toEqual([]);
    });

    it("packs THIRD-PARTY-NOTICES.md beside every file that bundles the Babel fork", () => {
      expect(forkNoticeProblems(dir, packed)).toEqual([]);
    });

    const carriers = forkCarriers(dir, packed);
    if (carriers.length > 0) {
      it("names every fork carrier and the fork's upstream tag in each packed notice", () => {
        const tag = /^- Tag: `(v[^`]+)`/m.exec(
          readFileSync(join(repoRoot, "packages/babel/UPSTREAM.md"), "utf8"),
        )?.[1];
        expect(tag).toMatch(/^v\d/);
        const notices = packed.filter(
          (f) => posix.basename(f) === NOTICES_FILE,
        );
        expect(notices.length).toBeGreaterThan(0);
        for (const notice of notices) {
          const here = carriers
            .filter((c) => posix.dirname(c) === posix.dirname(notice))
            .map((c) => posix.basename(c));
          const text = readFileSync(join(dir, notice), "utf8");
          expect(text.split("\n")[0]).toBe(
            `# Third-party code in ${here.join(", ")}`,
          );
          expect(text).toContain(`@babel/parser ${tag?.slice(1)}`);
          expect(text).toContain(`tag \`${tag}\``);
        }
      });
    }

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

    if (pkg.private !== true) {
      it("names no private workspace package", () => {
        const privacy = workspacePrivacy();
        expect(
          privateWorkspaceImports(
            files.flatMap((file) => moduleSpecifiers(file)),
            (name) => privacy.get(name) === true,
          ).map(
            ({ file, specifier }) =>
              `${file.slice(dir.length + 1)}: ${specifier}`,
          ),
        ).toEqual([]);
      });
    }

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

describe("@mxlang/target-html ambient `*.mx` declaration", () => {
  const dir = pkgDirOf(
    PACKED_PACKAGES.find((p) => p.name === "@mxlang/target-html") ?? never(),
  );
  const pkg = readPackageJson(dir);

  it("is reachable through the exports map as `@mxlang/target-html/types/marko`", () => {
    expect((pkg.exports as Record<string, unknown>)["./types/marko"]).toBe(
      "./types/marko.d.ts",
    );
    expect(packedFiles(dir)).toContain("types/marko.d.ts");
  });
});

function never(): never {
  throw new Error("@mxlang/target-html is not in PACKED_PACKAGES");
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

describe("babelFlagReads", () => {
  it("flags each Babel build flag read, only in JS files", () => {
    const dir = mkdtempSync(join(tmpdir(), "babel-flags-"));
    try {
      writeFileSync(
        join(dir, "a.js"),
        "const x = process.env.BABEL_8_BREAKING ? 1 : 0;",
      );
      writeFileSync(
        join(dir, "b.cjs"),
        "if (!process.env.IS_PUBLISH) throw new Error();",
      );
      writeFileSync(join(dir, "c.mjs"), "const x = false ? 1 : 0;");
      writeFileSync(
        join(dir, "d.d.ts"),
        "declare const x: typeof process.env.BABEL_8_BREAKING;",
      );
      expect(babelFlagReads(dir, ["a.js", "b.cjs", "c.mjs", "d.d.ts"])).toEqual(
        ["a.js", "b.cjs"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Babel fork notices", () => {
  const scratch = mkdtempSync(join(tmpdir(), "fork-notices-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const marked = `class P { ${BABEL_FORK_MARKER}(startLoc) {} }`;
  /** A package dir whose `dist/` holds `files` (name -> text). */
  const plant = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(scratch, "pkg-"));
    mkdirSync(join(dir, "dist"));
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, "dist", name), text);
    }
    return dir;
  };
  const carrierFiles = {
    "a.js": marked,
    "b.cjs": "module.exports = 1;",
    "c.d.ts": `declare function ${BABEL_FORK_MARKER}(): void;`,
  };
  const cleanFiles = {
    "b.cjs": "module.exports = 1;",
    "c.d.ts": `declare function ${BABEL_FORK_MARKER}(): void;`,
  };

  it("forkNoticeProblems flags a carrier whose notice is not packed", () => {
    const dir = plant(carrierFiles);
    expect(
      forkNoticeProblems(dir, ["dist/a.js", "dist/b.cjs", "dist/c.d.ts"]),
    ).toEqual([
      "dist/a.js: carries the Babel fork but dist/THIRD-PARTY-NOTICES.md is not packed",
    ]);
  });

  it("forkNoticeProblems passes a carrier with its notice", () => {
    const dir = plant({ ...carrierFiles, "THIRD-PARTY-NOTICES.md": "x" });
    expect(
      forkNoticeProblems(dir, [
        "dist/a.js",
        "dist/b.cjs",
        "dist/c.d.ts",
        "dist/THIRD-PARTY-NOTICES.md",
      ]),
    ).toEqual([]);
  });

  it("forkNoticeProblems flags a notice with no carrier and ignores a marked .d.ts", () => {
    const dir = plant({ ...cleanFiles, "THIRD-PARTY-NOTICES.md": "x" });
    expect(
      forkNoticeProblems(dir, [
        "dist/b.cjs",
        "dist/c.d.ts",
        "dist/THIRD-PARTY-NOTICES.md",
      ]),
    ).toEqual([
      "dist/THIRD-PARTY-NOTICES.md: packed but no JS beside it carries the Babel fork",
    ]);
  });

  it("forkNoticeProblems passes a clean dir with no notice", () => {
    const dir = plant(cleanFiles);
    expect(forkNoticeProblems(dir, ["dist/b.cjs", "dist/c.d.ts"])).toEqual([]);
  });

  it("writeThirdPartyNotices throws naming the dir when required and nothing carries the fork", () => {
    const dist = join(plant(cleanFiles), "dist");
    expect(() => writeThirdPartyNotices(dist, { required: true })).toThrow(
      `no JS file in ${dist} carries the Babel fork`,
    );
    expect(existsSync(join(dist, "THIRD-PARTY-NOTICES.md"))).toBe(false);
  });

  it("writeThirdPartyNotices writes nothing and returns [] when not required", () => {
    const dist = join(plant(cleanFiles), "dist");
    expect(writeThirdPartyNotices(dist, { required: false })).toEqual([]);
    expect(existsSync(join(dist, "THIRD-PARTY-NOTICES.md"))).toBe(false);
  });

  it("writeThirdPartyNotices writes a heading listing exactly the carriers", () => {
    const dist = join(plant({ ...carrierFiles, "d.mjs": marked }), "dist");
    expect(writeThirdPartyNotices(dist, { required: true })).toEqual([
      "a.js",
      "d.mjs",
    ]);
    const lines = readFileSync(
      join(dist, "THIRD-PARTY-NOTICES.md"),
      "utf8",
    ).split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "# Third-party code in a.js, d.mjs",
      "",
      "`a.js`, `d.mjs` bundle the code below. Each is distributed under its own licence.",
    ]);
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
