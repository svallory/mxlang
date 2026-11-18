import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
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
  isBuiltin,
  moduleSpecifiers,
  noticeProblems,
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
  unrewrittenWorkspaceRanges,
  workspacePrivacy,
} from "./pack-hygiene.ts";
import {
  BABEL_FORK_MARKER,
  inlinedThirdParty,
  NOTICES_FILE,
  thirdPartyCarriers,
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

describe("unrewrittenWorkspaceRanges", () => {
  it("reports each workspace: range a consumer installs, one entry per range", () => {
    expect(
      unrewrittenWorkspaceRanges({
        name: "@mxlang/a",
        dependencies: {
          "@mxlang/core": "workspace:*",
          "@babel/parser": "7.29.8",
        },
        optionalDependencies: { "@mxlang/opt": "workspace:~" },
        peerDependencies: {
          "@mxlang/x": "workspace:^",
          "@types/bun": ">=1.3",
        },
      }),
    ).toEqual([
      "dependencies.@mxlang/core: workspace:*",
      "optionalDependencies.@mxlang/opt: workspace:~",
      "peerDependencies.@mxlang/x: workspace:^",
    ]);
  });

  it("passes a rewritten manifest, ignoring devDependencies and file: ranges", () => {
    expect(
      unrewrittenWorkspaceRanges({
        name: "@mxlang/b",
        dependencies: {
          "@mxlang/core": "0.1.0-alpha.38",
          "@mxlang/web-elements": "file:../web-elements",
        },
        devDependencies: { "@mxlang/babel": "workspace:*" },
      }),
    ).toEqual([]);
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

    it("packs a THIRD-PARTY-NOTICES.md covering everything each JS file inlines", () => {
      expect(noticeProblems(dir, packed)).toEqual([]);
    });

    it("names exactly its dir's carriers in each packed notice, and the fork's upstream tag beside a fork carrier", () => {
      const carriers = thirdPartyCarriers(dir, packed, dir);
      const tag = /^- Tag: `(v[^`]+)`/m.exec(
        readFileSync(join(repoRoot, "packages/babel/UPSTREAM.md"), "utf8"),
      )?.[1];
      expect(tag).toMatch(/^v\d/);
      const forkHeading = `@babel/parser ${tag?.slice(1)} (vendored as \`@mxlang/babel\`)`;
      for (const notice of packed.filter(
        (f) => posix.basename(f) === NOTICES_FILE,
      )) {
        const here = carriers.filter(
          (c) => posix.dirname(c) === posix.dirname(notice),
        );
        const text = readFileSync(join(dir, notice), "utf8");
        expect(text.split("\n")[0]).toBe(
          `# Third-party code in ${here.map((c) => posix.basename(c)).join(", ")}`,
        );
        const forkHere = here.some((c) =>
          inlinedThirdParty(join(dir, c), dir).some(
            (e) => e.heading === forkHeading,
          ),
        );
        if (forkHere) {
          expect(text).toContain(`## ${forkHeading}`);
          expect(text).toContain(`tag \`${tag}\``);
        }
      }
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

describe("third-party notices", () => {
  const scratch = mkdtempSync(join(tmpdir(), "third-party-notices-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const marked = `class P { ${BABEL_FORK_MARKER}(startLoc) {} }`;
  const write = (at: string, text: string) => {
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, text);
  };
  /** A scratch repository: a root `LICENSE`, two npm packages, workspace dirs. */
  const repo = mkdtempSync(join(scratch, "repo-"));
  const rootLicence = "MX licence\n";
  write(join(repo, "LICENSE"), rootLicence);
  const store = join(repo, "node_modules/.bun");
  write(
    join(store, "foo@1.2.3/node_modules/foo/package.json"),
    '{ "name": "foo", "version": "1.2.3" }',
  );
  write(join(store, "foo@1.2.3/node_modules/foo/LICENSE-MIT.txt"), "foo MIT\n");
  write(join(store, "foo@1.2.3/node_modules/foo/README.md"), "not a licence");
  write(join(store, "foo@1.2.3/node_modules/foo/lib/index.js"), "");
  write(
    join(store, "@s+bar@2.0.0/node_modules/@s/bar/package.json"),
    '{ "name": "@s/bar", "version": "2.0.0" }',
  );
  write(join(store, "@s+bar@2.0.0/node_modules/@s/bar/LICENSE"), "bar ISC\n");
  write(join(store, "@s+bar@2.0.0/node_modules/@s/bar/index.js"), "");
  // Another package's built dist, one level deeper than the carriers.
  write(join(repo, "packages/group/dep/package.json"), "{}");
  write(
    join(repo, "packages/group/dep/dist/index.js"),
    "// ../../../node_modules/.bun/foo@1.2.3/node_modules/foo/lib/index.js\n",
  );
  // MX's own code (a root-identical licence) and vendored code beside it.
  write(join(repo, "packages/lib/package.json"), "{}");
  write(join(repo, "packages/lib/LICENSE"), rootLicence);
  write(join(repo, "packages/lib/src/own.ts"), "");
  write(join(repo, "packages/lib/vendor/LICENSE"), "vendor BSD\n");
  write(join(repo, "packages/lib/vendor/x.ts"), "");

  const FOO =
    "// ../../node_modules/.bun/foo@1.2.3/node_modules/foo/lib/index.js";
  const BAR =
    "// ../../node_modules/.bun/@s+bar@2.0.0/node_modules/@s/bar/index.js";
  const OWN = "// ../lib/src/own.ts";
  const VENDOR = "// ../lib/vendor/x.ts";
  const MISSING = "// ../missing/x.js";
  /** A package dir `packages/<name>` whose `dist/` holds `files` (name -> lines). */
  const plant = (files: Record<string, string[]>) => {
    const dir = mkdtempSync(join(repo, "packages/pkg-"));
    write(join(dir, "package.json"), "{}");
    for (const [name, lines] of Object.entries(files)) {
      write(join(dir, "dist", name), `${lines.join("\n")}\n`);
    }
    return dir;
  };
  const NOTICE = "dist/THIRD-PARTY-NOTICES.md";
  const fromBabel = createRequire(
    join(repoRoot, "packages/babel/package.json"),
  );
  const versionOf = (name: string) =>
    (fromBabel(`${name}/package.json`) as { version: string }).version;
  const tag = /^- Tag: `(v[^`]+)`/m.exec(
    readFileSync(join(repoRoot, "packages/babel/UPSTREAM.md"), "utf8"),
  )?.[1];

  it("maps npm module comments to `name version` and the package's licen[cs]e file, scoped names included", () => {
    const dir = plant({ "a.js": [FOO, BAR, FOO, "var a = 1;"] });
    expect(inlinedThirdParty(join(dir, "dist/a.js"), dir, repo)).toEqual([
      { heading: "@s/bar 2.0.0", text: "bar ISC" },
      { heading: "foo 1.2.3", text: "foo MIT" },
    ]);
  });

  it("follows a comment naming another package's dist/ file, resolved against that package's dir", () => {
    const dir = plant({ "a.js": ["// ../group/dep/dist/index.js"] });
    expect(inlinedThirdParty(join(dir, "dist/a.js"), dir, repo)).toEqual([
      { heading: "foo 1.2.3", text: "foo MIT" },
    ]);
  });

  it("gives vendored workspace code under a foreign licence an entry, and MX's own code none", () => {
    const dir = plant({ "a.js": [OWN, VENDOR] });
    expect(inlinedThirdParty(join(dir, "dist/a.js"), dir, repo)).toEqual([
      { heading: "Vendored code in `packages/lib/vendor`", text: "vendor BSD" },
    ]);
    const own = plant({ "a.js": [OWN] });
    expect(inlinedThirdParty(join(own, "dist/a.js"), own, repo)).toEqual([]);
  });

  it("throws naming the file and the path when a module comment does not resolve", () => {
    const dir = plant({ "a.js": [FOO, MISSING] });
    const file = join(dir, "dist/a.js");
    expect(() => inlinedThirdParty(file, dir, repo)).toThrow(
      `${file}: module comment ../missing/x.js does not resolve from ${dir}`,
    );
  });

  it("thirdPartyCarriers skips a JS file covered by its own <stem>.NOTICES.md, unscanned", () => {
    const dir = plant({
      "front.cjs": [MISSING],
      "front.NOTICES.md": ["# front"],
      "a.js": [FOO],
      "b.cjs": ["module.exports = 1;"],
    });
    const files = ["front.cjs", "front.NOTICES.md", "a.js", "b.cjs"];
    expect(thirdPartyCarriers(join(dir, "dist"), files, dir, repo)).toEqual([
      "a.js",
    ]);
  });

  describe("noticeProblems", () => {
    const carrier = { "a.js": [FOO, BAR], "b.cjs": [OWN] };
    const clean = {
      "b.cjs": [OWN, "module.exports = 1;"],
      "c.d.ts": [FOO, `declare function ${BABEL_FORK_MARKER}(): void;`],
    };
    const packedOf = (files: object) =>
      Object.keys(files).map((f) => `dist/${f}`);

    it("flags a carrier whose notice is not packed", () => {
      const dir = plant(carrier);
      expect(noticeProblems(dir, packedOf(carrier), repo)).toEqual([
        "dist/a.js: inlines third-party code but dist/THIRD-PARTY-NOTICES.md is not packed",
      ]);
    });

    it("flags a section the notice lacks and one nothing beside it inlines", () => {
      const lacking = {
        ...carrier,
        "THIRD-PARTY-NOTICES.md": ["# x", "## @s/bar 2.0.0", "bar ISC"],
      };
      const dir = plant(lacking);
      expect(noticeProblems(dir, packedOf(lacking), repo)).toEqual([
        `${NOTICE}: no section for foo 1.2.3, which dist/a.js inlines`,
      ]);
      const extra = {
        ...carrier,
        "THIRD-PARTY-NOTICES.md": [
          "## @s/bar 2.0.0",
          "## foo 1.2.3",
          "## baz 0.1.0",
        ],
      };
      const stale = plant(extra);
      expect(noticeProblems(stale, packedOf(extra), repo)).toEqual([
        `${NOTICE}: section baz 0.1.0 is inlined by no JS beside it`,
      ]);
    });

    it("flags a notice with no carrier beside it, ignoring a .d.ts", () => {
      const files = { ...clean, "THIRD-PARTY-NOTICES.md": ["## foo 1.2.3"] };
      const dir = plant(files);
      expect(noticeProblems(dir, packedOf(files), repo)).toEqual([
        `${NOTICE}: packed but no JS beside it inlines third-party code`,
      ]);
    });

    it("passes a matching notice and a clean dir with none", () => {
      const files = {
        ...carrier,
        "THIRD-PARTY-NOTICES.md": ["## @s/bar 2.0.0", "", "## foo 1.2.3"],
      };
      const dir = plant(files);
      expect(noticeProblems(dir, packedOf(files), repo)).toEqual([]);
      const none = plant(clean);
      expect(noticeProblems(none, packedOf(clean), repo)).toEqual([]);
    });
  });

  describe("writeThirdPartyNotices", () => {
    const clean = { "b.cjs": [OWN, "module.exports = 1;"] };

    it("throws naming the dir when required and nothing is inlined", () => {
      const dir = plant(clean);
      const dist = join(dir, "dist");
      expect(() =>
        writeThirdPartyNotices(dist, {
          required: true,
          baseDir: dir,
          repoRoot: repo,
        }),
      ).toThrow(`no JS file in ${dist} inlines third-party code`);
      expect(existsSync(join(dist, NOTICES_FILE))).toBe(false);
    });

    it("writes nothing and returns [] when not required", () => {
      const dir = plant(clean);
      const dist = join(dir, "dist");
      expect(
        writeThirdPartyNotices(dist, {
          required: false,
          baseDir: dir,
          repoRoot: repo,
        }),
      ).toEqual([]);
      expect(existsSync(join(dist, NOTICES_FILE))).toBe(false);
    });

    it("writes the carriers' heading, then the fork, vendored and npm sections", () => {
      const dir = plant({
        ...clean,
        "a.js": [FOO, VENDOR, OWN],
        "d.mjs": [marked, BAR],
      });
      const dist = join(dir, "dist");
      expect(
        writeThirdPartyNotices(dist, {
          required: true,
          baseDir: dir,
          repoRoot: repo,
        }),
      ).toEqual(["a.js", "d.mjs"]);
      const lines = readFileSync(join(dist, NOTICES_FILE), "utf8").split("\n");
      expect(lines.slice(0, 3)).toEqual([
        "# Third-party code in a.js, d.mjs",
        "",
        "`a.js`, `d.mjs` bundle the code below. Each is distributed under its own licence.",
      ]);
      expect(lines.filter((l) => l.startsWith("## "))).toEqual([
        `## @babel/parser ${tag?.slice(1)} (vendored as \`@mxlang/babel\`)`,
        "## Vendored code in `packages/lib/vendor`",
        `## @babel/helper-validator-identifier ${versionOf("@babel/helper-validator-identifier")}`,
        "## @s/bar 2.0.0",
        `## charcodes ${versionOf("charcodes")}`,
        "## foo 1.2.3",
      ]);
      expect(lines.slice(-4)).toEqual(["## foo 1.2.3", "", "foo MIT", ""]);
    });
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
