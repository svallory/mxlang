import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import { createVitest } from "vitest/node";
import {
  commandLog,
  commentOnly,
  commentOnlySplit,
  DIST_PACKAGES,
  type DistPackage,
  DOC_READERS,
  distBuilds,
  distEntries,
  FIXTURE_CONSUMERS,
  fixtureConsumers,
  hasVitestTests,
  isManifest,
  isProjectDoc,
  isRelatedSource,
  isWide,
  laneFor,
  manifestMetadataOnly,
  manifestSplit,
  nonSourceProjects,
  ownRunnerDirs,
  ownRunnerPlan,
  PROBE_CONSUMER,
  probeConsumers,
  projectDirs,
  projectFor,
  projectsFor,
  readersOnly,
  relatedPassWithNoTests,
  relatedSources,
  SOURCE_TEXT_READERS,
  splitDocs,
  testScript,
  VITEST_TEST_FILE,
} from "./test-affected.ts";

describe("laneFor", () => {
  it("names the slow-lane packages a change touches", () => {
    expect(
      laneFor([
        "packages/tooling/tsc/src/watch.test.ts",
        "packages/core/src/x.ts",
      ]),
    ).toEqual(["packages/tooling/tsc"]);
    expect(
      laneFor([
        "packages/tooling/tsc/src/a.ts",
        "packages/tooling/typescript-plugin/src/b.ts",
      ]),
    ).toEqual(["packages/tooling/tsc", "packages/tooling/typescript-plugin"]);
  });

  it("is empty when no slow-lane package changed", () => {
    expect(laneFor(["packages/core/src/x.ts", "docs/a.md"])).toEqual([]);
  });
});

describe("isWide", () => {
  it("flags the wide files at the repo root", () => {
    expect(isWide("vitest.config.ts")).toBe(true);
    expect(isWide("package.json")).toBe(true);
    expect(isWide("bun.lock")).toBe(true);
    expect(isWide("tsconfig.base.json")).toBe(true);
    expect(isWide("scripts/vitest-lanes.ts")).toBe(true);
  });

  it("flags a per-package vitest config but not ordinary sources", () => {
    expect(isWide("packages/core/vitest.config.ts")).toBe(true);
    expect(isWide("packages/core/src/core.ts")).toBe(false);
    expect(isWide("packages/core/package.json")).toBe(false);
  });
});

describe("isRelatedSource (what vitest related can see)", () => {
  it("js/ts sources outside fixtures are related sources", () => {
    expect(isRelatedSource("packages/core/src/core.ts")).toBe(true);
    expect(isRelatedSource("packages/web-elements/src/index.ts")).toBe(true);
  });

  it(".mx files are never related sources (tests read them through fs)", () => {
    expect(isRelatedSource("examples/mx-vite/src/page.mx")).toBe(false);
    expect(
      isRelatedSource(
        "packages/oracle/fixtures/angular/tag-define-shadow/input.mx",
      ),
    ).toBe(false);
  });

  it("a fixtures-style directory wins over the extension", () => {
    expect(isRelatedSource("packages/oracle/fixtures-custom-tags/run.ts")).toBe(
      false,
    );
    expect(isRelatedSource("packages/parser/test/fixtures/a.ts")).toBe(false);
    expect(isRelatedSource("packages/parser/test-fixtures/a.ts")).toBe(false);
    expect(isRelatedSource("packages/parser/src/a.test.ts")).toBe(true);
  });

  it("a vitest/vite config is not a related source; look-alikes and the vitest scripts still are", () => {
    expect(isRelatedSource("vitest.config.ts")).toBe(false);
    expect(isRelatedSource("packages/hosts/preact/vitest.config.ts")).toBe(
      false,
    );
    expect(isRelatedSource("scripts/vitest.config.ts")).toBe(false);
    expect(isRelatedSource("examples/mx-vite/vite.config.ts")).toBe(false);
    expect(isRelatedSource("packages/x/vitest.config.mts")).toBe(false);
    expect(isRelatedSource("scripts/vitest-lanes.ts")).toBe(true);
    expect(isRelatedSource("packages/x/src/myvitest.config.ts")).toBe(true);
    expect(isRelatedSource("packages/x/src/vitest.config.test.ts")).toBe(true);
  });

  it("a lone .mx fixture selects its whole owning project, not related", () => {
    const changed = [
      "packages/oracle/fixtures/angular/tag-define-shadow/input.mx",
    ];
    expect(changed.filter(isRelatedSource)).toEqual([]);
    expect(
      changed.filter((f) => !isRelatedSource(f)).map((f) => projectFor(f)),
    ).toEqual(["@mxlang/oracle"]);
  });

  it("the r2 mixed case: a .mx fixture beside a source with a test keeps both covered", () => {
    const changed = [
      "packages/oracle/fixtures/angular/tag-define-shadow/input.mx",
      "packages/web-elements/src/index.ts",
    ];
    expect(changed.filter(isRelatedSource)).toEqual([
      "packages/web-elements/src/index.ts",
    ]);
    expect(
      changed.filter((f) => !isRelatedSource(f)).map((f) => projectFor(f)),
    ).toEqual(["@mxlang/oracle"]);
  });

  it("a config change runs its project, the root one is unmapped, and neither is related", () => {
    const dirs = projectDirs();
    const changed = [
      "vitest.config.ts",
      "packages/web-elements/vitest.config.ts",
      "packages/web-elements/src/index.ts",
    ];
    expect(relatedSources(changed)).toEqual([
      "packages/web-elements/src/index.ts",
      ...WEB_ELEMENTS_DIST,
      ...CORE_DIST,
      ...VITE_PLUGIN_DIST,
      ...TS_PLUGIN_DIST,
    ]);
    const { byProject, unmapped } = nonSourceProjects(
      changed.filter((f) => !isRelatedSource(f)),
      dirs,
    );
    expect(byProject).toEqual(
      new Map([
        ["@mxlang/web-elements", ["packages/web-elements/vitest.config.ts"]],
      ]),
    );
    expect(unmapped).toEqual(["vitest.config.ts"]);
  });
});

describe("projectsFor", () => {
  const dirs = projectDirs();

  it("a core file selects both core projects", () => {
    expect(projectsFor("packages/core/src/fixtures/a.json", dirs)).toEqual([
      "@mxlang/core",
      "@mxlang/core-isolated",
    ]);
  });

  it("a package with no sibling selects only its own project", () => {
    expect(projectsFor("packages/parser/test/fixtures/e.html", dirs)).toEqual([
      "@mxlang/parser",
    ]);
    expect(projectsFor("docs/a.md", dirs)).toEqual([]);
  });
});

describe("FIXTURE_CONSUMERS (fixtures read from another project)", () => {
  const dirs = projectDirs();
  const projectsOf = (file: string) =>
    [...nonSourceProjects([file], dirs).byProject.keys()].sort();

  it("an oracle angular fixture selects the oracle and host-angular projects", () => {
    expect(
      projectsOf("packages/oracle/fixtures/angular/x/input.ng.mx"),
    ).toEqual(["@mxlang/host-angular", "@mxlang/oracle"]);
  });

  it("a tree-sitter-mx corpus file selects core beside its own project", () => {
    expect(
      projectsOf("packages/editors/tree-sitter-mx/test/corpus/tags.txt"),
    ).toEqual(["@mxlang/core", "@mxlang/tree-sitter-mx"]);
  });

  it("core's atom fixture selects the hosts that load it", () => {
    expect(
      projectsOf("packages/core/src/fixtures/syntax/atom-fixture.ts"),
    ).toEqual([
      "@mxlang/core",
      "@mxlang/core-isolated",
      "@mxlang/host-preact",
      "@mxlang/host-solid",
      "@mxlang/target-html",
    ]);
  });

  it("tsc's alias-html fixture selects the typescript-plugin project", () => {
    expect(
      projectsOf(
        "packages/tooling/tsc/src/fixtures/host-dispatch/alias-html/Card-html.mx",
      ),
    ).toEqual(["@mxlang/tsc", "@mxlang/typescript-plugin"]);
  });

  it("core's member fixture selects target-html", () => {
    expect(
      projectsOf("packages/core/src/fixtures/syntax/member-fixture.ts"),
    ).toEqual(["@mxlang/core", "@mxlang/core-isolated", "@mxlang/target-html"]);
  });

  it("a root fixtures/ file (in no project) selects solid and the oracle", () => {
    expect(projectsOf("fixtures/counter/template.mx")).toEqual([
      "@mxlang/host-solid",
      "@mxlang/oracle",
    ]);
  });

  it("a body-whitespace case file selects core and every host that reads it", () => {
    expect(projectsOf("test-fixtures/body-whitespace/cases.json")).toEqual([
      "@mxlang/core",
      "@mxlang/host-angular",
      "@mxlang/host-astro",
      "@mxlang/host-hono",
      "@mxlang/host-preact",
      "@mxlang/host-react",
      "@mxlang/host-solid",
      "@mxlang/target-html",
    ]);
  });

  it("a third-party-targets fixture selects its readers' projects", () => {
    expect(projectsOf("test-fixtures/third-party-targets/support.ts")).toEqual([
      "@mxlang/core",
      "@mxlang/targets",
      "@mxlang/tsc",
      "@mxlang/typescript-plugin",
    ]);
  });

  it("a dialects fixture selects its readers' projects", () => {
    expect(projectsOf("test-fixtures/dialects/ok/package.json")).toEqual([
      "@mxlang/language-server",
      "@mxlang/targets",
      "@mxlang/tsc",
      "@mxlang/typescript-plugin",
      "@mxlang/vite-plugin",
    ]);
  });

  it("a related source under a row sends its readers to vitest related", () => {
    expect(
      relatedSources(["packages/editors/tree-sitter-mx/test/corpus/read.mts"]),
    ).toEqual([
      "packages/editors/tree-sitter-mx/test/corpus/read.mts",
      "packages/core/src/ir-entry/conformance.test.ts",
    ]);
  });

  it("an unrelated fixture selects only its own project", () => {
    expect(projectsOf("packages/oracle/fixtures/marko/x/input.mx")).toEqual([
      "@mxlang/oracle",
    ]);
    expect(projectsOf("packages/parser/test/fixtures/e.html")).toEqual([
      "@mxlang/parser",
    ]);
    expect(
      fixtureConsumers("packages/core/src/fixtures/syntax/declares-fixture.ts"),
    ).toEqual([]);
  });

  it("readersOnly: every matching row flagged, else false", () => {
    const rows = [
      { path: /^a\//, consumers: ["a/x.test.ts"], readersOnly: true as const },
      { path: /^a\/b\//, consumers: ["a/y.test.ts"] },
    ];
    expect(readersOnly("a/c.txt", rows)).toBe(true);
    expect(readersOnly("a/b/c.txt", rows)).toBe(false);
    expect(readersOnly("z/c.txt", rows)).toBe(false);
    expect(readersOnly("apps/docs/docs/specification.md")).toBe(true);
    expect(
      readersOnly("packages/core/src/message-vocabulary-guard.allowlist.txt"),
    ).toBe(true);
    expect(readersOnly("fixtures/counter/template.mx")).toBe(false);
    expect(readersOnly("packages/core/package.json")).toBe(false);
  });

  it("a file in no project with no reader stays unmapped", () => {
    expect(nonSourceProjects(["test-fixtures/README.md"], dirs)).toEqual({
      byProject: new Map(),
      unmapped: ["test-fixtures/README.md"],
    });
  });

  it("every consumer is an existing test file in a vitest project", () => {
    for (const consumers of [
      ...FIXTURE_CONSUMERS.map((row) => row.consumers),
      DOC_READERS,
      ...SOURCE_TEXT_READERS.map((r) => r.consumers),
    ]) {
      for (const consumer of consumers) {
        expect(
          existsSync(resolve(import.meta.dirname, "..", consumer)),
          consumer,
        ).toBe(true);
        expect(projectFor(consumer, dirs), consumer).toBeDefined();
      }
    }
  });
});

describe("projectFor", () => {
  const dirs = projectDirs();

  it("lists the real vitest project dirs, including nested packages", () => {
    expect(dirs).toContain("packages/tooling/tsc/");
    expect(dirs).toContain("packages/hosts/angular/");
    expect(dirs).toContain("scripts/");
  });

  it("maps a fixture change to its package's project name", () => {
    expect(projectFor("packages/tooling/tsc/fixtures/a.json", dirs)).toBe(
      "@mxlang/tsc",
    );
    expect(
      projectFor("packages/parser/test/fixtures/expected.html", dirs),
    ).toBe("@mxlang/parser");
    expect(
      projectFor("packages/oracle/fixtures-custom-tags/run.ts", dirs),
    ).toBe("@mxlang/oracle");
  });

  it("prefers the nearest enclosing project", () => {
    expect(projectFor("packages/hosts/angular/test/x.json", dirs)).toBe(
      "@mxlang/host-angular",
    );
    // a file directly under packages/ is in no project
    expect(projectFor("packages/readme.md", dirs)).toBeUndefined();
  });

  it("returns undefined for files outside every project", () => {
    expect(projectFor("docs/a.md", dirs)).toBeUndefined();
    expect(projectFor("apps/docs/docs/x.md", dirs)).toBeUndefined();
    expect(projectFor("AGENTS.md", dirs)).toBeUndefined();
  });

  it("falls back to the dir name when a project has no package.json name", () => {
    expect(projectFor("scripts/some-tool.ts", dirs)).toBe("scripts");
    expect(projectFor("patches/foo.ts", dirs)).toBe("patches");
  });

  it("names a nested dir with no package.json by its basename, as vitest does", () => {
    // A package dir a rename left behind holding only ignored files
    // (node_modules, a .test-ran marker) has no package.json; vitest still
    // globs it as a project and names it basename(dir).
    expect(
      projectFor("packages/editors/gone/probe.json", [
        "packages/editors/gone/",
      ]),
    ).toBe("gone");
  });

  it("every mapped project name exists in Vitest's resolved root projects", async () => {
    // Resolve the actual root configuration without collecting or running any
    // tests. This also guards the shared PROJECT_GLOBS against naming drift.
    const ctx = await createVitest("test", {
      root: resolve(import.meta.dirname, ".."),
      watch: false,
    });
    try {
      const names = ctx.projects.map((p) => p.name);
      const mapped = new Set<string>();
      for (const dir of dirs) {
        for (const n of projectsFor(`${dir}probe.json`, dirs)) {
          expect(names, dir).toContain(n);
          mapped.add(n);
        }
      }
      // And the other direction: no vitest project is unreachable, so an
      // inline split that skips SIBLING_PROJECTS is caught.
      for (const n of names) expect([...mapped], n).toContain(n);
    } finally {
      await ctx.close();
    }
  });

  it("uses the vitest config's test.name when it differs from package.json (vscode)", () => {
    expect(projectFor("packages/editors/vscode/probe-fixture.json", dirs)).toBe(
      "@mxlang/vscode",
    );
  });
});

describe("probeConsumers", () => {
  it("selects the oracle attribute test for a host source or the probe", () => {
    for (const f of [
      "packages/hosts/solid/src/emitter.ts",
      "packages/hosts/astro/src/astro-template.ts",
      "scripts/attribute-value-probe.ts",
    ])
      expect(probeConsumers([f]), f).toEqual([PROBE_CONSUMER]);
  });
  it("selects nothing for other files", () => {
    expect(
      probeConsumers([
        "packages/hosts/angular/src/x.ts",
        "packages/core/src/x.ts",
        "scripts/other.ts",
      ]),
    ).toEqual([]);
  });
});

const PARSER = "packages/parser";
const WEB_ELEMENTS = "packages/web-elements";
const CORE = "packages/core";
const TSX_BRIDGE = "packages/tsx-bridge";
const HTML = "packages/targets/html";
const ANGULAR = "packages/hosts/angular";
const VITE_PLUGIN = "packages/tooling/vite-plugin";
const ANGULAR_CHECKER = "packages/tooling/angular-checker";
const TS_PLUGIN = "packages/tooling/typescript-plugin";

/** Each row's dist entries, as literals. */
const PARSER_DIST = ["packages/parser/dist/babel.js"];
const WEB_ELEMENTS_DIST = ["packages/web-elements/dist/index.js"];
const CORE_DIST = ["packages/core/dist/index.js"];
const TSX_BRIDGE_DIST = ["packages/tsx-bridge/dist/index.js"];
const HTML_DIST = [
  "packages/targets/html/dist/index.js",
  "packages/targets/html/dist/descriptor.js",
  "packages/targets/html/dist/runtime.js",
];
const ANGULAR_DIST = [
  "packages/hosts/angular/dist/index.js",
  "packages/hosts/angular/dist/descriptor.js",
];
const VITE_PLUGIN_DIST = ["packages/tooling/vite-plugin/dist/index.js"];
const TS_PLUGIN_DIST = ["packages/tooling/typescript-plugin/dist/index.cjs"];

describe("distBuilds", () => {
  const dirs = (files: string[]) => distBuilds(files).map((r) => r.dir);

  it("rebuilds a changed input's dist and every dist that bundles it, in table order", () => {
    const cases: [string, string[]][] = [
      [
        "packages/web-elements/src/index.ts",
        [WEB_ELEMENTS, CORE, VITE_PLUGIN, TS_PLUGIN],
      ],
      [
        "packages/tsx-bridge/src/index.ts",
        [TSX_BRIDGE, ANGULAR, VITE_PLUGIN, TS_PLUGIN],
      ],
      [
        "packages/babel/src/tokenizer/index.ts",
        [PARSER, CORE, TSX_BRIDGE, ANGULAR, VITE_PLUGIN, TS_PLUGIN],
      ],
      ["packages/parser/src/frontend/babel.ts", [PARSER, CORE]],
      // typescript-plugin's inputs miss targets/*/src: only its bundles edge
      // reaches it from html's sources.
      ["packages/targets/html/src/index.ts", [HTML, VITE_PLUGIN, TS_PLUGIN]],
      // A manifest matches no bundler's inputs: only the bundles edges reach
      // vite-plugin and typescript-plugin.
      ["packages/targets/html/package.json", [HTML, VITE_PLUGIN, TS_PLUGIN]],
      [
        "packages/hosts/angular/package.json",
        [ANGULAR, VITE_PLUGIN, TS_PLUGIN],
      ],
      ["packages/core/src/lower.ts", [CORE, VITE_PLUGIN]],
      ["packages/hosts/preact/src/emitter.ts", [VITE_PLUGIN, TS_PLUGIN]],
      [
        "packages/tooling/angular-checker/src/index.ts",
        [ANGULAR_CHECKER, TS_PLUGIN],
      ],
      [
        "bun.lock",
        [
          PARSER,
          WEB_ELEMENTS,
          CORE,
          TSX_BRIDGE,
          HTML,
          ANGULAR,
          VITE_PLUGIN,
          ANGULAR_CHECKER,
          TS_PLUGIN,
        ],
      ],
    ];
    for (const [f, want] of cases) expect(dirs([f]), f).toEqual(want);
  });

  it("rebuilds nothing for a test file, a fixture, a file in no row, or no change", () => {
    for (const f of [
      "packages/core/src/lower.test.ts",
      "packages/core/src/fixtures/syntax/member-fixture.ts",
      "packages/tooling/language-server/src/diagnose.ts",
      "packages/tooling/tsc/src/index.ts",
      "packages/parser/moon.yml",
      "packages/hosts/angular/test/cli.test.ts",
    ])
      expect(dirs([f]), f).toEqual([]);
    expect(dirs([])).toEqual([]);
  });

  it("keeps #883's parser and core cases as dir lists", () => {
    const cases: [string, string[]][] = [
      // Former parserBuildNeeded true cases.
      ["packages/babel/package.json", [PARSER, CORE]],
      ["packages/parser/package.json", [PARSER, CORE]],
      ["packages/parser/tsconfig.json", [PARSER]],
      [
        "tsconfig.base.json",
        [
          PARSER,
          WEB_ELEMENTS,
          CORE,
          TSX_BRIDGE,
          HTML,
          ANGULAR,
          VITE_PLUGIN,
          ANGULAR_CHECKER,
          TS_PLUGIN,
        ],
      ],
      // Former parserBuildNeeded false cases.
      ["packages/parser/src/frontend/parse.ts", [CORE]],
      ["packages/core/src/babel.ts", [CORE, VITE_PLUGIN]],
      ["packages/babel/README.md", []],
      ["packages/core/tsconfig.json", [CORE]],
      ["apps/docs/bun.lock", []],
      // Former coreBuildNeeded true cases.
      ["packages/core/build/frontend.ts", [CORE]],
      ["packages/parser/src/template/index.ts", [CORE]],
      ["packages/core/package.json", [CORE]],
      [
        "scripts/third-party-notices.ts",
        [CORE, TSX_BRIDGE, ANGULAR, VITE_PLUGIN, TS_PLUGIN],
      ],
      // Former coreBuildNeeded false cases.
      ["packages/core/AGENTS.md", []],
    ];
    for (const [f, want] of cases) expect(dirs([f]), f).toEqual(want);
  });

  /** A; B bundles A; C bundles B. */
  const table: DistPackage[] = [
    { dir: "a", inputs: [/^a\//], entries: ["a/dist/a.js"], bundles: [] },
    { dir: "b", inputs: [/^b\//], entries: ["b/dist/b.js"], bundles: ["a"] },
    { dir: "c", inputs: [/^c\//], entries: ["c/dist/c.js"], bundles: ["b"] },
  ];

  it("cascades through a fixture table's bundle chain, in table order", () => {
    expect(distBuilds(["a/x.ts"], table).map((r) => r.dir)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(distEntries(["a/x.ts"], table)).toEqual([
      "a/dist/a.js",
      "b/dist/b.js",
      "c/dist/c.js",
    ]);
    expect(distBuilds(["c/x.ts"], table).map((r) => r.dir)).toEqual(["c"]);
    expect(distEntries(["c/x.ts"], table)).toEqual(["c/dist/c.js"]);
    expect(distBuilds(["a/package.json"], table).map((r) => r.dir)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(distEntries(["a/package.json"], table)).toEqual([]);
  });

  it("the table is well formed: bundles name earlier rows, entries are published entries", () => {
    const seen: string[] = [];
    for (const row of DIST_PACKAGES) {
      for (const d of row.bundles)
        expect(seen, `${row.dir} bundles ${d}`).toContain(d);
      seen.push(row.dir);
      const manifest = JSON.parse(
        readFileSync(
          resolve(import.meta.dirname, "..", row.dir, "package.json"),
          "utf8",
        ),
      ) as {
        main?: string;
        exports?: Record<string, string | { default?: string }>;
      };
      const published = [
        ...Object.values(manifest.exports ?? {}).map((e) =>
          typeof e === "string" ? e : e.default,
        ),
        manifest.main,
      ]
        .filter((e): e is string => e !== undefined)
        .map((e) => posix.join(row.dir, e));
      for (const entry of row.entries)
        expect(published, `${row.dir}: ${entry}`).toContain(entry);
    }
    expect(seen).toEqual([
      PARSER,
      WEB_ELEMENTS,
      CORE,
      TSX_BRIDGE,
      HTML,
      ANGULAR,
      VITE_PLUGIN,
      ANGULAR_CHECKER,
      TS_PLUGIN,
    ]);
  });
});

describe("dist consumers", () => {
  /** The test files `project` selects for `related`, filtered by `filter`. Needs built dists (CI and verify build first). */
  const selected = async (
    project: string,
    filter: string,
    related: string[],
  ): Promise<string[]> => {
    const ctx = await createVitest("test", {
      root: resolve(import.meta.dirname, ".."),
      watch: false,
      project: [project],
      related: related.map((f) => resolve(import.meta.dirname, "..", f)),
    });
    try {
      await ctx.init();
      const specs = await ctx.getRelevantTestSpecifications([filter]);
      return specs.map((s) =>
        posix.relative(ctx.config.root, s.moduleId.replaceAll("\\", "/")),
      );
    } finally {
      await ctx.close();
    }
  };

  it("a test that reaches core only through its dist is selected by core's entry, not by a core source", async () => {
    expect(
      await selected("@mxlang/host-preact", "region-errors", CORE_DIST),
    ).toEqual(["packages/hosts/preact/src/region-errors.test.ts"]);
    expect(
      await selected("@mxlang/host-preact", "region-errors", [
        "packages/core/src/custom-tags.ts",
      ]),
    ).toEqual([]);
  });

  it("a test that reaches a CJS dist only by name is selected by its entry, not by the package's source", async () => {
    expect(
      await selected("@mxlang/tsc", "shorthand-mappings", TS_PLUGIN_DIST),
    ).toEqual(["packages/tooling/tsc/src/shorthand-mappings.test.ts"]);
    expect(
      await selected("@mxlang/tsc", "shorthand-mappings", [
        "packages/tooling/typescript-plugin/src/index.ts",
      ]),
    ).toEqual([]);
  });
});

describe("ownRunnerDirs", () => {
  const dirs = [
    "packages/core/",
    "packages/editors/zed/",
    "packages/editors/tree-sitter-mx/",
  ];
  const TS = "packages/editors/tree-sitter-mx/";
  const ZED = "packages/editors/zed/";

  it("keeps the owner dirs without vitest tests, deduped and sorted", () => {
    expect(
      ownRunnerDirs(
        [
          "packages/editors/zed/src/lib.rs",
          "packages/core/src/core.ts",
          "packages/editors/tree-sitter-mx/grammar.js",
          "packages/editors/tree-sitter-mx/src/parser.c",
          "packages/editors/zed/extension.toml",
          "docs/a.md",
        ],
        dirs,
        (d) => d === "packages/core/",
      ),
    ).toEqual([TS, ZED]);
    expect(
      ownRunnerDirs(
        ["packages/core/src/core.ts", "docs/a.md"],
        dirs,
        (d) => d === "packages/core/",
      ),
    ).toEqual([]);
  });

  it("relatedPassWithNoTests is true only when every changed related source is owned", () => {
    const own = [TS];
    expect(
      relatedPassWithNoTests(
        ["packages/editors/tree-sitter-mx/grammar.js"],
        own,
        dirs,
      ),
    ).toBe(true);
    expect(
      relatedPassWithNoTests(
        [
          "packages/editors/tree-sitter-mx/grammar.js",
          "packages/core/src/core.ts",
        ],
        own,
        dirs,
      ),
    ).toBe(false);
    expect(
      relatedPassWithNoTests(
        ["packages/editors/tree-sitter-mx/src/parser.c", "docs/a.md"],
        own,
        dirs,
      ),
    ).toBe(false);
  });

  it("hasVitestTests: the grammar and Zed have none, core and scripts do", () => {
    expect(hasVitestTests("packages/editors/tree-sitter-mx/")).toBe(false);
    expect(hasVitestTests("packages/editors/zed/")).toBe(false);
    expect(hasVitestTests("packages/core/")).toBe(true);
    expect(hasVitestTests("scripts/")).toBe(true);
  });

  it("ownRunnerPlan drops owned projects and runs each own dir's test script", () => {
    const scripts: Record<string, string> = { [TS]: "./scripts/test.sh" };
    const names: Record<string, string> = {
      [TS]: "@mxlang/tree-sitter-mx",
      [ZED]: "@mxlang/zed",
    };
    expect(
      ownRunnerPlan(
        [TS, ZED],
        [
          "@mxlang/core",
          "@mxlang/core-isolated",
          "@mxlang/tree-sitter-mx",
          "@mxlang/zed",
        ],
        (d) => scripts[d],
        (d) => names[d] ?? d,
      ),
    ).toEqual({
      projects: ["@mxlang/core", "@mxlang/core-isolated"],
      runs: [
        {
          dir: TS,
          name: "@mxlang/tree-sitter-mx",
          cmd: ["bun", "run", "--cwd", TS, "test"],
        },
        { dir: ZED, name: "@mxlang/zed" },
      ],
    });
  });

  it("testScript reads the package's test script, undefined without one", () => {
    expect(testScript(TS)).toBe("./scripts/test.sh");
    expect(testScript(ZED)).toBeUndefined();
    expect(testScript("packages/editors/")).toBeUndefined();
  });

  it("VITEST_TEST_FILE mirrors vitest's default include", () => {
    expect(configDefaults.include).toEqual([
      "**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ]);
    for (const f of ["a.test.ts", "a.spec.mjs", "a.test.tsx"]) {
      expect(VITEST_TEST_FILE.test(f), f).toBe(true);
    }
    for (const f of ["a.bun-test.mts", "a.ts"]) {
      expect(VITEST_TEST_FILE.test(f), f).toBe(false);
    }
  });
});

describe("Markdown selection", () => {
  const dirs = projectDirs();
  const CORPUS = "packages/parser/src/template/corpus-equivalence.test.ts";

  it("a .md inside a project dir is a project doc", () => {
    for (const f of [
      "packages/tooling/typescript-plugin/AGENTS.md",
      "packages/core/README.md",
      "packages/core/CHANGELOG.md",
      "packages/editors/tree-sitter-solid/test/COVERAGE.md",
      "scripts/AGENTS.md",
    ])
      expect(isProjectDoc(f, dirs), f).toBe(true);
  });

  it("a root doc, a fixture doc, a FIXTURE_CONSUMERS doc or a source is not", () => {
    for (const f of [
      "AGENTS.md",
      "docs/a.md",
      "packages/oracle/fixtures/angular/README.md",
      // A fixtures-style dir on no FIXTURE_CONSUMERS row.
      "packages/oracle/fixtures/marko/README.md",
      "packages/editors/tree-sitter-mx/test/corpus/README.md",
      "packages/core/src/a.ts",
    ])
      expect(isProjectDoc(f, dirs), f).toBe(false);
  });

  it("PR #800's case: a package AGENTS.md selects no whole project", () => {
    const { docs, rest } = splitDocs(
      ["packages/tooling/typescript-plugin/AGENTS.md"],
      dirs,
    );
    expect(docs).toEqual(["packages/tooling/typescript-plugin/AGENTS.md"]);
    expect(rest).toEqual([]);
    expect(
      nonSourceProjects(
        rest.filter((f) => !isRelatedSource(f)),
        dirs,
      ),
    ).toEqual({ byProject: new Map(), unmapped: [] });
  });

  it("a doc beside a core fixture still selects core's two projects", () => {
    const { docs, rest } = splitDocs(
      [
        "packages/tooling/typescript-plugin/AGENTS.md",
        "packages/core/src/fixtures/a.json",
      ],
      dirs,
    );
    expect(docs).toEqual(["packages/tooling/typescript-plugin/AGENTS.md"]);
    expect(rest).toEqual(["packages/core/src/fixtures/a.json"]);
    expect([
      ...nonSourceProjects(
        rest.filter((f) => !isRelatedSource(f)),
        dirs,
      ).byProject.keys(),
    ]).toEqual(["@mxlang/core", "@mxlang/core-isolated"]);
  });

  it("a readers-only file leaves rest, so it reaches no whole project", () => {
    const split = splitDocs(
      [
        "apps/docs/docs/specification.md",
        "packages/core/README.md",
        "packages/core/src/message-vocabulary-guard.allowlist.txt",
        "packages/core/src/fixtures/a.json",
      ],
      dirs,
    );
    expect(split).toEqual({
      docs: ["packages/core/README.md"],
      readersOnly: [
        "apps/docs/docs/specification.md",
        "packages/core/src/message-vocabulary-guard.allowlist.txt",
      ],
      rest: ["packages/core/src/fixtures/a.json"],
    });
    expect([...nonSourceProjects(split.rest, dirs).byProject.keys()]).toEqual([
      "@mxlang/core",
      "@mxlang/core-isolated",
    ]);
    expect(nonSourceProjects([], dirs)).toEqual({
      byProject: new Map(),
      unmapped: [],
    });
  });

  it("a grammar package's doc triggers no own runner; its grammar.js does", () => {
    const own = [
      "packages/core/",
      "packages/editors/zed/",
      "packages/editors/tree-sitter-mx/",
    ];
    const hasTests = (d: string) => d === "packages/core/";
    expect(
      ownRunnerDirs(
        splitDocs(["packages/editors/tree-sitter-mx/UPSTREAM.md"], own).rest,
        own,
        hasTests,
      ),
    ).toEqual([]);
    expect(
      ownRunnerDirs(
        splitDocs(
          [
            "packages/editors/tree-sitter-mx/UPSTREAM.md",
            "packages/editors/tree-sitter-mx/grammar.js",
          ],
          own,
        ).rest,
        own,
        hasTests,
      ),
    ).toEqual(["packages/editors/tree-sitter-mx/"]);
  });

  it("a project doc adds the Markdown readers to vitest related", () => {
    expect(
      relatedSources(["packages/tooling/typescript-plugin/AGENTS.md"]),
    ).toEqual([CORPUS]);
    expect(
      relatedSources([
        "packages/core/README.md",
        "packages/hosts/solid/src/emitter.ts",
        "packages/parser/src/template/corpus-equivalence.test.ts",
        "packages/core/CHANGELOG.md",
      ]),
    ).toEqual([
      "packages/hosts/solid/src/emitter.ts",
      CORPUS,
      PROBE_CONSUMER,
      "packages/parser/src/frontend/boundary.test.ts",
      ...VITE_PLUGIN_DIST,
      ...TS_PLUGIN_DIST,
    ]);
  });

  it("a readers-only file sends only its readers to vitest related", () => {
    expect(relatedSources(["apps/docs/docs/specification.md"])).toEqual([
      "packages/core/src/ir-entry/partial.test.ts",
      "packages/core/src/parents.test.ts",
      "packages/parser/src/template/corpus-equivalence.test.ts",
    ]);
    expect(
      relatedSources([
        "packages/core/src/message-vocabulary-guard.allowlist.txt",
      ]),
    ).toEqual(["packages/core/src/message-vocabulary-guard.test.ts"]);
  });

  /** The core row's readers, in row order. */
  const CORE_READERS = [
    "packages/core/src/diagnostic-code-sites.test.ts",
    "packages/core/src/cold-start.test.ts",
    "packages/tooling/language-server/src/bundled-deps.test.ts",
    "packages/tooling/typescript-plugin/src/bundled-deps.test.ts",
    "packages/core/src/message-vocabulary-guard.test.ts",
  ];

  it("any corpus input adds the Markdown readers; a source change adds none of them", () => {
    expect(relatedSources(["docs/a.md"])).toEqual([CORPUS]);
    expect(
      relatedSources(["packages/oracle/fixtures/marko/x/input.mx"]),
    ).toEqual([CORPUS]);
    expect(relatedSources(["packages/core/src/core.ts"])).toEqual([
      "packages/core/src/core.ts",
      ...CORE_READERS,
      ...CORE_DIST,
      ...VITE_PLUGIN_DIST,
    ]);
  });

  it("a token edit to a source a row matches adds the tests that read its text (mx-qo73)", () => {
    expect(relatedSources(["packages/core/src/lower.ts"])).toEqual([
      "packages/core/src/lower.ts",
      ...CORE_READERS,
      ...CORE_DIST,
      ...VITE_PLUGIN_DIST,
    ]);
    expect(relatedSources(["packages/tsx-bridge/src/public.d.ts"])).toEqual([
      "packages/tsx-bridge/src/public.d.ts",
      "packages/tsx-bridge/src/pack-contents.test.ts",
      ...TSX_BRIDGE_DIST,
      ...ANGULAR_DIST,
      ...VITE_PLUGIN_DIST,
      ...TS_PLUGIN_DIST,
    ]);
  });

  it("a source two rows match adds both rows' readers; shared readers are listed once", () => {
    expect(relatedSources(["packages/core/src/ir-entry/index.ts"])).toEqual([
      "packages/core/src/ir-entry/index.ts",
      ...CORE_READERS,
      "packages/core/src/ir-entry/partial.test.ts",
      ...CORE_DIST,
      ...VITE_PLUGIN_DIST,
    ]);
    expect(
      relatedSources([
        "packages/core/src/lower.ts",
        "packages/core/src/core.ts",
      ]),
    ).toEqual([
      "packages/core/src/lower.ts",
      "packages/core/src/core.ts",
      ...CORE_READERS,
      ...CORE_DIST,
      ...VITE_PLUGIN_DIST,
    ]);
  });

  /** What `relatedSources` appends after the changed source and its readers. */
  const distTail = (f: string) =>
    relatedSources([f]).filter((e) => /\/dist\//.test(e));

  it("a source bundled into a dist adds that dist's entries and its bundlers', last and in table order", () => {
    expect(distTail("packages/web-elements/src/index.ts")).toEqual([
      ...WEB_ELEMENTS_DIST,
      ...CORE_DIST,
      ...VITE_PLUGIN_DIST,
      ...TS_PLUGIN_DIST,
    ]);
    expect(distTail("packages/babel/src/tokenizer/index.ts")).toEqual([
      ...PARSER_DIST,
      ...CORE_DIST,
      ...TSX_BRIDGE_DIST,
      ...ANGULAR_DIST,
      ...VITE_PLUGIN_DIST,
      ...TS_PLUGIN_DIST,
    ]);
    expect(distTail("packages/tsx-bridge/src/index.ts")).toEqual([
      ...TSX_BRIDGE_DIST,
      ...ANGULAR_DIST,
      ...VITE_PLUGIN_DIST,
      ...TS_PLUGIN_DIST,
    ]);
    expect(distTail("packages/targets/html/src/index.ts")).toEqual([
      ...HTML_DIST,
      ...VITE_PLUGIN_DIST,
      ...TS_PLUGIN_DIST,
    ]);
    expect(
      relatedSources(["packages/parser/src/template/index.ts"]).at(-1),
    ).toBe(CORE_DIST[0]);
    expect(distTail("scripts/bundled-build.ts")).toEqual([
      ...VITE_PLUGIN_DIST,
      ...TS_PLUGIN_DIST,
    ]);
  });

  it("a test file, fixture, manifest, tsconfig, lockfile or build-only script adds no dist entry", () => {
    for (const f of [
      "packages/core/src/lower.test.ts",
      "packages/core/src/fixtures/syntax/member-fixture.ts",
      "packages/core/package.json",
      "packages/core/tsconfig.json",
      "bun.lock",
      "scripts/third-party-notices.ts",
      "packages/tsx-bridge/scripts/emit-declarations.ts",
    ])
      expect(distTail(f), f).toEqual([]);
  });
});

describe("commandLog", () => {
  it("prints a command over 200 characters in full", () => {
    // 295 characters joined; the DOC_READERS entry starts at character 210.
    const cmd = [
      "bunx",
      "vitest",
      "related",
      "packages/hosts/angular/src/emitter.ts",
      "packages/hosts/preact/src/emitter.ts",
      "packages/hosts/solid/src/emitter.ts",
      "packages/hosts/angular/src/mapping.ts",
      "packages/hosts/angular/src/page-class.ts",
      "packages/parser/src/template/corpus-equivalence.test.ts",
      "--run",
      "--passWithNoTests=false",
    ];
    expect(commandLog(cmd, "all")).toBe(
      "test:affected: MX_TEST_LANE=all bunx vitest related packages/hosts/angular/src/emitter.ts packages/hosts/preact/src/emitter.ts packages/hosts/solid/src/emitter.ts packages/hosts/angular/src/mapping.ts packages/hosts/angular/src/page-class.ts packages/parser/src/template/corpus-equivalence.test.ts --run --passWithNoTests=false",
    );
  });

  it("has no MX_TEST_LANE= prefix without a lane", () => {
    const cmd = [
      "bunx",
      "vitest",
      "run",
      "--project",
      "parser",
      "--passWithNoTests=false",
    ];
    expect(commandLog(cmd)).toBe(
      "test:affected: bunx vitest run --project parser --passWithNoTests=false",
    );
  });
});

const VITEST_ENV = ["@vitest", "environment"].join("-");

describe("commentOnly", () => {
  it.each([
    [
      "a line comment reworded",
      "a.ts",
      "// add one\nconst a = 1;\n",
      "// adds one to nothing\nconst a = 1;\n",
    ],
    [
      "a one-line block comment added before a statement on its line",
      "a.ts",
      "const a = 1;\nf(a);\n",
      "const a = 1;\n/* call it */ f(a);\n",
    ],
    [
      "a JSDoc block rewritten",
      "a.ts",
      "/** Adds. */\nexport function f(a: number) {\n  return a + 1;\n}\n",
      "/**\n * Adds one.\n * @param a the number\n */\nexport function f(a: number) {\n  return a + 1;\n}\n",
    ],
    [
      "indentation and trailing spaces changed",
      "a.ts",
      "if (a) {\n  b();\n}\n",
      "if (a) {   \n\t\t  b( ) ;\n}  \n",
    ],
    [
      "a plain comment edited beside an unchanged // @ts-expect-error",
      "a.ts",
      "// old note\n// @ts-expect-error\nconst a: number = 'x';\n",
      "// new note\n// @ts-expect-error\nconst a: number = 'x';\n",
    ],
  ])("%s: comment-only", (_name, file, before, after) => {
    expect(commentOnly(file, before, after)).toBe(true);
  });

  it.each([
    ["an identifier renamed", "a.ts", "const a = 1;\n", "const b = 1;\n"],
    [
      'a string "// x" changed to "// y"',
      "a.ts",
      'const s = "// x";\n',
      'const s = "// y";\n',
    ],
    [
      "template text changed",
      "a.ts",
      "const s = `a${b}c`;\n",
      "const s = `a${b}d`;\n",
    ],
    [
      "a regex literal changed",
      "a.ts",
      "const r = /a\\/*b/;\n",
      "const r = /a\\/*c/;\n",
    ],
    [
      "JSX text changed",
      "a.tsx",
      "const e = <p>hi</p>;\n",
      "const e = <p>ho</p>;\n",
    ],
    [
      "leading spaces of JSX text removed",
      "a.tsx",
      "const e = <p>  hi</p>;\n",
      "const e = <p>hi</p>;\n",
    ],
    [
      "a line break inserted between two tokens",
      "a.ts",
      "function f() {\n  return x;\n}\n",
      "function f() {\n  return\n  x;\n}\n",
    ],
  ])("%s: not comment-only", (_name, file, before, after) => {
    expect(commentOnly(file, before, after)).toBe(false);
  });

  it.each([
    [
      "// @ts-expect-error added",
      "const a: number = 'x';\n",
      "// @ts-expect-error\nconst a: number = 'x';\n",
    ],
    [
      "// @ts-expect-error removed",
      "// @ts-expect-error\nconst a: number = 'x';\n",
      "const a: number = 'x';\n",
    ],
    [
      "// @ts-expect-error edited",
      "// @ts-expect-error\nconst a: number = 'x';\n",
      "// @ts-expect-error wrong type on purpose\nconst a: number = 'x';\n",
    ],
    [
      "/* @vite-ignore */ added",
      "await import(url);\n",
      "await import(/* @vite-ignore */ url);\n",
    ],
    [
      "// biome-ignore edited",
      "// biome-ignore lint/x: y\nf();\n",
      "// biome-ignore lint/x: z\nf();\n",
    ],
    [
      "/*#__PURE__*/ added on the call's line",
      "const a = f();\n",
      "const a = /*#__PURE__*/ f();\n",
    ],
    [
      "a same-line biome-ignore edited",
      "a(); // biome-ignore lint/x: y\nb();\n",
      "a(); // biome-ignore lint/x: z\nb();\n",
    ],
    [
      // Split so vitest does not read the literal as this file's environment.
      `// ${VITEST_ENV} edited`,
      `// ${VITEST_ENV} node\nf();\n`,
      `// ${VITEST_ENV} jsdom\nf();\n`,
    ],
    [
      "a blank line inserted between // @ts-expect-error and its line",
      "// @ts-expect-error\nconst a: number = 'x';\n",
      "// @ts-expect-error\n\nconst a: number = 'x';\n",
    ],
  ])("marker %s: not comment-only", (_name, before, after) => {
    expect(commentOnly("a.ts", before, after)).toBe(false);
  });
});

describe("commentOnlySplit", () => {
  const LOWER = "packages/core/src/lower.ts";
  const IR_INDEX = "packages/core/src/ir-entry/index.ts";
  const before: Record<string, string> = {
    [LOWER]: "// lowers\nexport const lower = 1;\n",
    [IR_INDEX]: "// entry\nexport const ir = 1;\n",
    "packages/x/src/fixtures/a.ts": "// a\nexport const a = 1;\n",
    "vitest.config.ts": "// c\nexport default {};\n",
    "a.mx": "// m\n<p/>\n",
    "packages/x/src/token.ts": "export const t = 1;\n",
    "packages/x/src/comment.ts": "// one\nexport const c = 1;\n",
  };
  const after: Record<string, string> = {
    [LOWER]: "// lowers the tree\nexport const lower = 1;\n",
    [IR_INDEX]: "// the IR entry\nexport const ir = 1;\n",
    "packages/x/src/fixtures/a.ts": "// b\nexport const a = 1;\n",
    "vitest.config.ts": "// d\nexport default {};\n",
    "a.mx": "// n\n<p/>\n",
    "packages/x/src/new.ts": "/* new */",
    "packages/x/src/token.ts": "export const t = 2;\n",
    "packages/x/src/comment.ts": "// two\nexport const c = 1;\n",
  };

  it("picks only eligible comment-only files and adds their source-text readers", () => {
    expect(
      commentOnlySplit(
        [
          "packages/x/src/fixtures/a.ts",
          LOWER,
          "vitest.config.ts",
          "a.mx",
          "packages/x/src/new.ts",
          "packages/x/src/token.ts",
          "packages/x/src/comment.ts",
          IR_INDEX,
        ],
        (f) => before[f],
        (f) => after[f] ?? "",
      ),
    ).toEqual({
      commentOnly: [LOWER, "packages/x/src/comment.ts", IR_INDEX],
      kept: [
        "packages/x/src/fixtures/a.ts",
        "vitest.config.ts",
        "a.mx",
        "packages/x/src/new.ts",
        "packages/x/src/token.ts",
      ],
      readers: [
        "packages/core/src/diagnostic-code-sites.test.ts",
        "packages/core/src/cold-start.test.ts",
        "packages/tooling/language-server/src/bundled-deps.test.ts",
        "packages/tooling/typescript-plugin/src/bundled-deps.test.ts",
        "packages/core/src/message-vocabulary-guard.test.ts",
        "packages/core/src/ir-entry/partial.test.ts",
      ],
    });
  });
});

describe("manifestMetadataOnly", () => {
  const BASE = `{
  "name": "@mxlang/core",
  "version": "1.0.0",
  "license": "MIT",
  "engines": { "bun": ">=1.3" },
  "dependencies": { "a": "1.0.0" }
}
`;

  it("is true for #844's engines.bun bump", () => {
    expect(
      manifestMetadataOnly(
        '{ "name": "@mxlang/core", "type": "module", "engines": { "bun": ">=1.3" }, "dependencies": { "a": "1.0.0" } }',
        '{ "name": "@mxlang/core", "type": "module", "engines": { "bun": ">=1.4" }, "dependencies": { "a": "1.0.0" } }',
      ),
    ).toBe(true);
  });

  it.each([
    ["engines", { node: ">=20" }],
    ["description", "The MX compiler"],
    ["keywords", ["mx", "marko"]],
    ["author", "someone"],
    ["license", "Apache-2.0"],
    ["repository", { type: "git", url: "https://example.com/mx.git" }],
    ["homepage", "https://example.com"],
    ["bugs", { url: "https://example.com/issues" }],
    ["funding", "https://example.com/fund"],
  ])("is true when only %s changes", (key, value) => {
    expect(
      manifestMetadataOnly(
        '{ "name": "a", "engines": { "bun": ">=1.3" }, "description": "d", "keywords": ["k"], "author": "x", "license": "MIT", "repository": "r", "homepage": "h", "bugs": "b", "funding": "f" }',
        JSON.stringify({
          name: "a",
          engines: { bun: ">=1.3" },
          description: "d",
          keywords: ["k"],
          author: "x",
          license: "MIT",
          repository: "r",
          homepage: "h",
          bugs: "b",
          funding: "f",
          [key]: value,
        }),
      ),
    ).toBe(true);
  });

  it("is true when license is removed or funding is added", () => {
    expect(
      manifestMetadataOnly(
        BASE,
        '{ "name": "@mxlang/core", "version": "1.0.0", "engines": { "bun": ">=1.3" }, "dependencies": { "a": "1.0.0" } }',
      ),
    ).toBe(true);
    expect(
      manifestMetadataOnly(
        BASE,
        '{ "name": "@mxlang/core", "version": "1.0.0", "license": "MIT", "engines": { "bun": ">=1.3" }, "dependencies": { "a": "1.0.0" }, "funding": "https://example.com/fund" }',
      ),
    ).toBe(true);
  });

  it("is true for whitespace, top-level key order and key order inside repository", () => {
    expect(
      manifestMetadataOnly(
        BASE,
        '{"dependencies":{"a":"1.0.0"},"engines":{"bun":">=1.3"},"license":"MIT","version":"1.0.0","name":"@mxlang/core"}',
      ),
    ).toBe(true);
    expect(
      manifestMetadataOnly(
        '{ "name": "a", "repository": { "type": "git", "url": "u", "directory": "packages/a" } }',
        '{ "name": "a", "repository": { "directory": "packages/a", "url": "u", "type": "git" } }',
      ),
    ).toBe(true);
  });

  it.each([
    ["dependencies", '{ "a": "1.0.0" }', '{ "a": "1.1.0" }'],
    ["exports", '"./dist/index.js"', '{ ".": "./dist/index.js" }'],
    ["scripts", '{ "test": "vitest" }', '{ "test": "vitest run" }'],
    ["version", '"1.0.0"', '"1.0.1"'],
    ["files", '["dist"]', '["dist", "src"]'],
  ])("is false when only %s changes", (key, from, to) => {
    expect(
      manifestMetadataOnly(
        `{ "name": "a", "license": "MIT", "${key}": ${from} }`,
        `{ "name": "a", "license": "MIT", "${key}": ${to} }`,
      ),
    ).toBe(false);
  });

  it("is false when engines and dependencies change together", () => {
    expect(
      manifestMetadataOnly(
        BASE,
        '{ "name": "@mxlang/core", "version": "1.0.0", "license": "MIT", "engines": { "bun": ">=1.4" }, "dependencies": { "a": "2.0.0" } }',
      ),
    ).toBe(false);
  });

  it("is false for invalid JSON, an array or null on either side", () => {
    expect(manifestMetadataOnly('{ "name": "a",', '{ "name": "a" }')).toBe(
      false,
    );
    expect(manifestMetadataOnly('{ "name": "a" }', '{ "name": "a",')).toBe(
      false,
    );
    expect(manifestMetadataOnly('["a"]', '["a"]')).toBe(false);
    expect(manifestMetadataOnly('{ "name": "a" }', "null")).toBe(false);
    expect(manifestMetadataOnly("null", '{ "name": "a" }')).toBe(false);
  });
});

describe("manifestSplit", () => {
  const CORE = "packages/core/package.json";
  const VSCODE = "packages/editors/vscode/package.json";
  const FIXTURE = "packages/tooling/tsc/src/fixtures/x/package.json";
  const NEW = "packages/x/package.json";
  const DEPS = "packages/hosts/react/package.json";
  const SOURCE = "packages/core/src/core.ts";
  const before = new Map<string, string>([
    [CORE, '{ "name": "@mxlang/core", "engines": { "bun": ">=1.3" } }'],
    [VSCODE, '{ "name": "mx-vscode", "engines": { "vscode": "^1.90.0" } }'],
    ["package.json", '{ "name": "mx", "engines": { "bun": ">=1.3" } }'],
    [FIXTURE, '{ "name": "x", "engines": { "bun": ">=1.3" } }'],
    [DEPS, '{ "name": "r", "dependencies": { "a": "1" } }'],
    [SOURCE, "export const a = 1;\n"],
  ]);
  const after = new Map<string, string>([
    [CORE, '{ "name": "@mxlang/core", "engines": { "bun": ">=1.4" } }'],
    [VSCODE, '{ "name": "mx-vscode", "engines": { "vscode": "^1.95.0" } }'],
    ["package.json", '{ "name": "mx", "engines": { "bun": ">=1.4" } }'],
    [FIXTURE, '{ "name": "x", "engines": { "bun": ">=1.4" } }'],
    [NEW, '{ "name": "x", "engines": { "bun": ">=1.4" } }'],
    [DEPS, '{ "name": "r", "dependencies": { "a": "2" } }'],
    [SOURCE, "export const a = 2;\n"],
  ]);
  const split = (changed: string[]) =>
    manifestSplit(
      changed,
      (f) => before.get(f),
      (f) => after.get(f) ?? "",
    );

  it("an engines-only edit of core's manifest runs only its readers (#844)", () => {
    expect(split([CORE])).toEqual({
      metadataOnly: [CORE],
      kept: [],
      readers: [
        "scripts/pack-hygiene.test.ts",
        "scripts/workspace-cycles.test.ts",
      ],
    });
  });

  it("the vscode and root manifests bring their readers", () => {
    const vscode = split([VSCODE]);
    expect(vscode.metadataOnly).toEqual([VSCODE]);
    expect(vscode.readers).toContain(
      "packages/target-registry/src/parity.test.ts",
    );
    expect(vscode.readers).toContain(
      "packages/editors/vscode/src/manifest.test.ts",
    );
    const rootManifest = split(["package.json"]);
    expect(rootManifest.metadataOnly).toEqual(["package.json"]);
    expect(rootManifest.readers).toContain(
      "packages/stock-marko/src/marko.test.ts",
    );
  });

  it("keeps a fixture manifest, a new manifest, a dependencies change and a source", () => {
    expect(split([FIXTURE, NEW, DEPS, SOURCE])).toEqual({
      metadataOnly: [],
      kept: [FIXTURE, NEW, DEPS, SOURCE],
      readers: [],
    });
  });

  it("isManifest: package.json outside fixtures-style dirs", () => {
    expect(
      [
        "package.json",
        "packages/core/package.json",
        "apps/docs/package.json",
        "packages/tooling/tsc/src/fixtures/x/package.json",
        "test-fixtures/dialects/a/package.json",
        "packages/core/package.json.bak",
        "tsconfig.json",
      ].map(isManifest),
    ).toEqual([true, true, true, false, false, false, false]);
  });
});

/*
 * The SOURCE_TEXT_READERS guard: finds the test files that read a package
 * source's text and checks each has a row. TypeScript parses the tests and its
 * checker resolves identifiers; `evaluatePath` turns the path expressions the
 * tests use into a repo-relative path, a directory prefix with an unknown
 * tail, or unknown.
 */

/** A value the path evaluator gives an expression. */
type PathValue =
  | { kind: "string"; text: string }
  | { kind: "template"; head: string }
  | { kind: "path"; path: string }
  | { kind: "prefix"; dir: string }
  | { kind: "unknown" };

/** A test file reading a target (`path`) or a directory of targets (`path` ends `/`). */
interface SourceRead {
  test: string;
  path: string;
  /** The targets the read can reach: the file, or every target under the directory. */
  files: readonly string[];
}

const UNKNOWN: PathValue = { kind: "unknown" };
const PATH_QUALIFIERS = new Set(["path", "posix", "url"]);
const WALK_CALLS = new Set(["readdirSync", "readdir", "globSync", "glob"]);
const READ_CALLS = new Set(["readFileSync", "readFile"]);

/** `p` without a trailing slash (`.` and `/` stay). */
function bare(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** A string used as a path is relative to the repository root (vitest's cwd). */
function asPath(v: PathValue): PathValue {
  if (v.kind === "string")
    return { kind: "path", path: posix.normalize(v.text) };
  if (v.kind === "template") {
    const head = posix.normalize(v.head || ".");
    return {
      kind: "prefix",
      dir: head.endsWith("/") ? bare(head) : posix.dirname(head),
    };
  }
  return v;
}

/** The called name of `callee` when bare or qualified by `path.`, `posix.` or `url.`. */
function pathCallName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const obj = callee.expression;
  const qualified =
    (ts.isIdentifier(obj) && PATH_QUALIFIERS.has(obj.text)) ||
    (ts.isPropertyAccessExpression(obj) && obj.name.text === "posix");
  return qualified ? callee.name.text : undefined;
}

/** The name a call's callee ends in: `f` for `f(...)` and `x.y.f(...)`. */
function lastName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

interface EvalContext {
  checker: ts.TypeChecker;
  /** The test file and its directory, repo-relative. */
  file: string;
  dir: string;
}

function evaluatePath(
  node: ts.Expression,
  ctx: EvalContext,
  seen: Set<ts.Node>,
): PathValue {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return evaluatePath(node.expression, ctx, seen);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "string", text: node.text };
  }
  if (ts.isTemplateExpression(node)) {
    return { kind: "template", head: node.head.text };
  }
  if (ts.isIdentifier(node)) {
    if (node.text === "__dirname") return { kind: "path", path: ctx.dir };
    const decl = ctx.checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (
      decl === undefined ||
      !ts.isVariableDeclaration(decl) ||
      !ts.isIdentifier(decl.name) ||
      decl.initializer === undefined ||
      !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) ||
      seen.has(decl)
    ) {
      return UNKNOWN;
    }
    seen.add(decl);
    const value = evaluatePath(decl.initializer, ctx, seen);
    seen.delete(decl);
    return value;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const name = node.name.text;
    if (
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      if (name === "dirname") return { kind: "path", path: ctx.dir };
      if (name === "url") return { kind: "path", path: ctx.file };
      return UNKNOWN;
    }
    if (name === "pathname" || name === "href") {
      return evaluatePath(node.expression, ctx, seen);
    }
    return UNKNOWN;
  }
  if (ts.isNewExpression(node)) {
    const [href, baseArg, ...extra] = node.arguments ?? [];
    if (
      !ts.isIdentifier(node.expression) ||
      node.expression.text !== "URL" ||
      href === undefined ||
      baseArg === undefined ||
      extra.length > 0
    ) {
      return UNKNOWN;
    }
    const base = asPath(evaluatePath(baseArg, ctx, seen));
    if (base.kind !== "path") return UNKNOWN;
    const dir = base.path.endsWith("/") ? base.path : posix.dirname(base.path);
    const rel = evaluatePath(href, ctx, seen);
    if (rel.kind === "string") {
      return { kind: "path", path: posix.join(dir, rel.text) };
    }
    if (rel.kind === "template") {
      // As URL resolution does: the head's partial last segment names no
      // directory, so the prefix is the directory that holds it (an empty
      // head or `./` gives b's directory).
      return {
        kind: "prefix",
        dir: posix.dirname(posix.join(dir, `${rel.head}x`)),
      };
    }
    return { kind: "prefix", dir: bare(dir) };
  }
  if (ts.isCallExpression(node)) {
    const name = pathCallName(node.expression);
    const [first, ...rest] = node.arguments;
    if (first === undefined) return UNKNOWN;
    if (name === "fileURLToPath" || name === "String") {
      return evaluatePath(first, ctx, seen);
    }
    if (name === "dirname") {
      const v = asPath(evaluatePath(first, ctx, seen));
      if (v.kind === "path") {
        return { kind: "path", path: posix.dirname(bare(v.path)) };
      }
      return v.kind === "prefix" ? v : UNKNOWN;
    }
    if (name === "join" || name === "resolve") {
      let acc = asPath(evaluatePath(first, ctx, seen));
      for (const arg of rest) {
        if (acc.kind !== "path") break;
        const v = evaluatePath(arg, ctx, seen);
        acc =
          v.kind === "string"
            ? { kind: "path", path: posix.join(acc.path, v.text) }
            : { kind: "prefix", dir: bare(acc.path) };
      }
      return acc.kind === "path" || acc.kind === "prefix" ? acc : UNKNOWN;
    }
  }
  return UNKNOWN;
}

/**
 * The reads of `targets` by each test in `sources` (repo-relative path to
 * text), deduped per test and sorted. One program over every file;
 * `noResolve`, so an imported binding is unknown. With `imports`, a relative
 * static or dynamic import or `export ... from` specifier is a read too (the
 * fixture guard; for sources, imports are the import graph's job).
 */
function scanSourceReads(
  sources: ReadonlyMap<string, string>,
  targets: ReadonlySet<string>,
  { imports }: { imports: boolean } = { imports: false },
): SourceRead[] {
  const files = [...sources.keys()].sort();
  const sorted = [...targets].sort();
  const under = (dir: string) => sorted.filter((t) => t.startsWith(`${dir}/`));
  const relName = (name: string) =>
    name.startsWith("/") ? name.slice(1) : name;
  const host: ts.CompilerHost = {
    getSourceFile: (name, language) => {
      const text = sources.get(relName(name));
      return text === undefined
        ? undefined
        : ts.createSourceFile(name, text, language, true);
    },
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => sources.has(relName(name)),
    readFile: (name) => sources.get(relName(name)),
  };
  const program = ts.createProgram(
    files.map((f) => `/${f}`),
    { noResolve: true, noLib: true, allowJs: true, types: [], noEmit: true },
    host,
  );
  const checker = program.getTypeChecker();
  const reads = new Map<string, SourceRead>();
  for (const file of files) {
    const sf = program.getSourceFile(`/${file}`);
    if (sf === undefined) continue;
    const ctx: EvalContext = { checker, file, dir: posix.dirname(file) };
    const add = (path: string, reached: readonly string[]) => {
      reads.set(`${file}\0${path}`, { test: file, path, files: reached });
    };
    const record = (value: PathValue) => {
      if (value.kind === "path" && targets.has(bare(value.path))) {
        add(bare(value.path), [bare(value.path)]);
      } else if (value.kind === "prefix") {
        const reached = under(value.dir);
        if (reached.length > 0) add(`${value.dir}/`, reached);
      }
      return value.kind === "unknown";
    };
    const raw = (specifier: string) =>
      record({
        kind: "path",
        path: posix.join(ctx.dir, specifier.slice(0, -"?raw".length)),
      });
    /** A module specifier: `?raw` always reads; a relative one with `imports`. */
    const specifier = (text: string) => {
      if (text.endsWith("?raw")) raw(text);
      else if (imports && text.startsWith(".")) {
        record({ kind: "path", path: posix.join(ctx.dir, text) });
      }
    };
    let unknownRead = false;
    let walks = false;
    let tsLiteral = false;
    const consts: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        if (/\.tsx?$/.test(node.text)) tsLiteral = true;
      } else if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifier(node.moduleSpecifier.text);
      } else if (
        imports &&
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !node.moduleSpecifier.text.endsWith("?raw")
      ) {
        specifier(node.moduleSpecifier.text);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const
      ) {
        consts.push(node.initializer);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const first = node.arguments[0];
        const name = lastName(callee);
        if (callee.kind === ts.SyntaxKind.ImportKeyword) {
          if (first !== undefined && ts.isStringLiteralLike(first)) {
            specifier(first.text);
          }
        } else if (name !== undefined && WALK_CALLS.has(name)) {
          walks = true;
        } else if (
          first !== undefined &&
          ((name !== undefined && READ_CALLS.has(name)) ||
            (ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression) &&
              callee.expression.text === "Bun" &&
              name === "file"))
        ) {
          if (record(asPath(evaluatePath(first, ctx, new Set())))) {
            unknownRead = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (unknownRead && walks && tsLiteral) {
      for (const init of consts) {
        const value = asPath(evaluatePath(init, ctx, new Set()));
        if (value.kind !== "path") continue;
        const dir = bare(value.path);
        const reached = under(dir);
        if (reached.length > 0) add(`${dir}/`, reached);
      }
    }
  }
  const key = (r: SourceRead) => `${r.test}\0${r.path}`;
  return [...reads.values()].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
}

/** A table of path rows and the tests that read what they match. */
type ReaderRows = readonly { path: RegExp; consumers: readonly string[] }[];

/** Whether a row lists the read's test and matches a file the read reaches. */
function coveredRead(read: SourceRead, rows: ReaderRows): boolean {
  return rows.some(
    (row) =>
      row.consumers.includes(read.test) &&
      read.files.some((f) => row.path.test(f)),
  );
}

/** An exemption: every read by `test`, or with `path` only a read whose files all match it. */
type Exemption = { test: string; path?: RegExp };

/** Whether `e` exempts `read`. */
function exempts(e: Exemption, read: SourceRead): boolean {
  return (
    e.test === read.test &&
    (e.path === undefined || read.files.every((f) => e.path?.test(f)))
  );
}

/** One sorted, deduped message per read neither covered by `rows` (named `table`) nor exempt. */
function uncovered(
  reads: readonly SourceRead[],
  rows: ReaderRows,
  exempt: readonly Exemption[],
  table: string,
): string[] {
  const messages = reads
    .filter((r) => !exempt.some((e) => exempts(e, r)) && !coveredRead(r, rows))
    .map((r) => `${r.test} reads ${r.path} with no ${table} row`);
  return [...new Set(messages)].sort();
}

/** The reads whose test is in a vitest project, narrowed to the files that project does not own. */
function crossProject(
  reads: readonly SourceRead[],
  projectOf: (file: string) => string | undefined,
  ownersOf: (file: string) => readonly string[],
): SourceRead[] {
  return reads.flatMap((read) => {
    const project = projectOf(read.test);
    if (project === undefined) return [];
    const files = read.files.filter((f) => !ownersOf(f).includes(project));
    return files.length > 0 ? [{ ...read, files }] : [];
  });
}

/** The source guard's targets: what `commentOnlySplit` can leave out, minus vitest test files. */
function sourceTargets(listed: readonly string[]): string[] {
  return listed.filter(
    (f) => isRelatedSource(f) && !isWide(f) && !VITEST_TEST_FILE.test(f),
  );
}

/**
 * The FIXTURE_CONSUMERS guard's targets: every non-test file whose change
 * takes the non-source, doc or unmapped path (fixtures, `.mx`, docs,
 * manifests, patches, the lockfile, root config), plus files a row matches.
 */
function fixtureTargets(listed: readonly string[]): string[] {
  return listed.filter(
    (f) =>
      !VITEST_TEST_FILE.test(f) &&
      (!isRelatedSource(f) ||
        FIXTURE_CONSUMERS.some((row) => row.path.test(f))),
  );
}

/**
 * The projects whose selection a change to `file` runs: none for a project
 * doc or a readers-only file (`readersOnly`), which runs only its rows'
 * readers, so a same-project reader of it is checked like a cross-project one.
 */
function readOwners(file: string, dirs: readonly string[]): string[] {
  return isProjectDoc(file, dirs) || readersOnly(file) || isManifest(file)
    ? []
    : projectsFor(file, dirs);
}

/**
 * Detected readers that need no row: no edit to a file they read can change
 * their result unless the import graph already selects them, so
 * `vitest related` runs them whenever their result can change.
 */
const EXEMPT: readonly { test: string; reason: string }[] = [
  // Imports `../index.ts`, which value-re-exports from ir.ts (`IR_VERSION`), mapping.ts, template-tag.ts and
  // ir-entry/index.ts, which value-imports ./spans.ts: vitest related selects it for any edit to the four files
  // it reads. It hashes their declarations printed with `removeComments: true`.
  {
    test: "packages/core/src/ir-entry/ir-version.test.ts",
    reason:
      "imports every file it reads through ../index.ts; hashes declarations printed without comments",
  },
  // Its `here` walk reads only the .mx files under src/fixtures/host-dispatch, no source.
  {
    test: "packages/tooling/tsc/src/host-dispatch-golden.test.ts",
    reason: "reads only fixture .mx files",
  },
  // Reads only the corpus `.txt` files (`.filter((f) => f.endsWith(".txt"))`), not the corpus scripts.
  {
    test: "packages/core/src/ir-entry/conformance.test.ts",
    reason: "reads only the corpus .txt files",
  },
];

/** Core's message-vocabulary allowlist, a readers-only file. */
const ALLOWLIST =
  /^packages\/core\/src\/message-vocabulary-guard\.allowlist\.txt$/;

/**
 * Detected readers that read no file a FIXTURE_CONSUMERS row would need. An
 * entry with `path` exempts only a read whose files all match it.
 */
const FIXTURE_EXEMPT: readonly (Exemption & { reason: string })[] = [
  // Their walk skips `fixtures` directories (`if (name !== "fixtures") walk(path)`) and reads only `.ts`.
  {
    test: "packages/tooling/language-server/src/bundled-deps.test.ts",
    reason: "walk skips fixtures directories",
  },
  {
    test: "packages/tooling/typescript-plugin/src/bundled-deps.test.ts",
    reason: "walk skips fixtures directories",
  },
  // Its `template/` walk reads only `.ts` (`path.endsWith(".ts")`); the read reaches only PROVENANCE.md, a project doc.
  // Its `package.json` read has a FIXTURE_CONSUMERS row.
  {
    test: "packages/parser/src/frontend/boundary.test.ts",
    path: /\.md$/,
    reason: "template walk reads only .ts files",
  },
  // Excluded from html's vitest project (its vitest.config.ts `exclude`); `test:bun` runs it, `test:affected` never does.
  {
    test: "packages/targets/html/src/example.bun.test.ts",
    reason: "not a vitest test; runs under test:bun",
  },
  // Core tests whose `packages/core/src/` read reaches the readers-only
  // allowlist (no owner in the guard) but never opens it.
  {
    test: "packages/core/src/cold-start.test.ts",
    path: ALLOWLIST,
    reason:
      'its src walk keeps only `name.endsWith(".ts") && !name.endsWith(".test.ts")`',
  },
  {
    test: "packages/core/src/diagnostic-code-sites.test.ts",
    path: ALLOWLIST,
    reason:
      'its src walk keeps only `entry.endsWith(".ts") && !entry.endsWith(".test.ts")`',
  },
  {
    test: "packages/core/src/ir-entry/ir-version.test.ts",
    path: ALLOWLIST,
    reason:
      'its `join(import.meta.dirname, "..", file)` reads only the named `.ts` files (`declarations("ir.ts")`)',
  },
];

const ROOT = resolve(import.meta.dirname, "..");
let repoFiles: { listed: string[]; tests: Map<string, string> } | undefined;
/**
 * The repository: git's file list (sorted) and the text of every vitest test
 * file that may read a file (the prefilter); computed once for both guards.
 */
const scanInputs = () => {
  if (repoFiles !== undefined) return repoFiles;
  const out = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (out.status !== 0) throw new Error(out.stderr);
  const listed = [...new Set(out.stdout.split("\n").filter(Boolean))]
    .filter((f) => existsSync(resolve(ROOT, f)))
    .sort();
  const tests = new Map<string, string>();
  for (const f of listed.filter((f) => VITEST_TEST_FILE.test(f))) {
    const text = readFileSync(resolve(ROOT, f), "utf8");
    if (/readFileSync|readFile\b|Bun\.file|\?raw|["'`]\.\.\//.test(text)) {
      tests.set(f, text);
    }
  }
  repoFiles = { listed, tests };
  return repoFiles;
};

describe("SOURCE_TEXT_READERS guard", () => {
  let repoReads: SourceRead[] | undefined;
  /** The repository's source reads; computed once. */
  const scanRepo = (): SourceRead[] => {
    if (repoReads !== undefined) return repoReads;
    const { listed, tests } = scanInputs();
    repoReads = scanSourceReads(tests, new Set(sourceTargets(listed)));
    return repoReads;
  };

  it("every detected reader of a source's text has a row or an exemption", () => {
    expect(
      uncovered(scanRepo(), SOURCE_TEXT_READERS, EXEMPT, "SOURCE_TEXT_READERS"),
    ).toEqual([]);
  });

  it("catches #823's miss: the vocabulary guard without its core-row entry", () => {
    const guard = "packages/core/src/message-vocabulary-guard.test.ts";
    const rows = SOURCE_TEXT_READERS.map((row) => ({
      ...row,
      consumers: row.consumers.filter((c) => c !== guard),
    }));
    expect(uncovered(scanRepo(), rows, EXEMPT, "SOURCE_TEXT_READERS")).toEqual([
      "packages/core/src/message-vocabulary-guard.test.ts reads packages/core/src/ with no SOURCE_TEXT_READERS row",
    ]);
  });

  it("catches a reader outside src/: the angular example without its row", () => {
    const reader = "packages/hosts/angular/test/example-app.test.ts";
    const rows = SOURCE_TEXT_READERS.map((row) => ({
      ...row,
      consumers: row.consumers.filter((c) => c !== reader),
    }));
    expect(uncovered(scanRepo(), rows, EXEMPT, "SOURCE_TEXT_READERS")).toEqual([
      "packages/hosts/angular/test/example-app.test.ts reads examples/angular-app/ with no SOURCE_TEXT_READERS row",
    ]);
  });

  it("every exemption is detected and covered by no row", () => {
    const reads = scanRepo();
    expect(
      EXEMPT.filter((e) => !reads.some((r) => r.test === e.test)).map(
        (e) => e.test,
      ),
    ).toEqual([]);
    expect(
      reads
        .filter(
          (r) =>
            EXEMPT.some((e) => e.test === r.test) &&
            coveredRead(r, SOURCE_TEXT_READERS),
        )
        .map((r) => r.test),
    ).toEqual([]);
  });

  it("targets what a comment-only edit can leave out, and fixtures", () => {
    const listed = [
      "packages/x/src/a.ts",
      "packages/x/src/types.d.ts",
      "packages/x/scripts/gen.mjs",
      "packages/x/src/a.test.ts",
      "scripts/vitest-lanes.ts",
      "packages/x/src/fixtures/f.ts",
      "packages/x/src/page.mx",
      "packages/editors/tree-sitter-mx/test/corpus/a.txt",
      "apps/docs/docs/x.md",
      "bun.lock",
      "packages/x/package.json",
      "packages/x/vitest.config.ts",
    ];
    expect(sourceTargets(listed)).toEqual([
      "packages/x/src/a.ts",
      "packages/x/src/types.d.ts",
      "packages/x/scripts/gen.mjs",
    ]);
    expect(fixtureTargets(listed)).toEqual([
      "packages/x/src/fixtures/f.ts",
      "packages/x/src/page.mx",
      "packages/editors/tree-sitter-mx/test/corpus/a.txt",
      "apps/docs/docs/x.md",
      "bun.lock",
      "packages/x/package.json",
      "packages/x/vitest.config.ts",
    ]);
  });

  it("detects the path forms tests use, and only reads of targets", () => {
    const dir = "packages/x/src";
    const sources = new Map<string, string>([
      [
        `${dir}/url.test.ts`,
        `readFileSync(new URL("./a.ts", import.meta.url), "utf8");`,
      ],
      [
        `${dir}/named.test.ts`,
        [
          "export {};",
          "const SRC = import.meta.dirname;",
          'function read(name: string) { return readFileSync(join(SRC, name), "utf8"); }',
        ].join("\n"),
      ],
      [`${dir}/raw.test.ts`, 'import t from "./a.ts?raw";'],
      [`${dir}/bun.test.ts`, 'Bun.file(join(import.meta.dirname, "a.ts"));'],
      [
        `${dir}/walk.test.ts`,
        [
          "export {};",
          "const here = import.meta.dirname;",
          "function walk(dir: string) {",
          "  for (const name of readdirSync(dir)) {",
          '    if (name.endsWith(".ts")) readFileSync(join(dir, name), "utf8");',
          "  }",
          "}",
          "walk(here);",
        ].join("\n"),
      ],
      [
        `${dir}/fixture.test.ts`,
        [
          "export {};",
          "const here = import.meta.dirname;",
          'readFileSync(join(here, "fixtures", "a.ts"), "utf8");',
        ].join("\n"),
      ],
      [
        `${dir}/json.test.ts`,
        [
          "export {};",
          "const here = import.meta.dirname;",
          'readFileSync(join(here, "../package.json"), "utf8");',
        ].join("\n"),
      ],
      [
        `${dir}/temp.test.ts`,
        [
          "export {};",
          'const tmp = mkdtempSync(join(tmpdir(), "x-"));',
          'writeFileSync(join(tmp, "index.ts"), "export {};");',
          'readFileSync(join(tmp, "index.ts"), "utf8");',
        ].join("\n"),
      ],
      [
        `${dir}/urlname.test.ts`,
        [
          "export {};",
          "function read(name: string) { return readFileSync(new URL(`${name}.ts`, import.meta.url)); }",
        ].join("\n"),
      ],
      [
        `${dir}/urldocs.test.ts`,
        [
          "export {};",
          "function read(p: string) { return readFileSync(new URL(`../../../apps/docs/docs/${p}`, import.meta.url)); }",
        ].join("\n"),
      ],
      [`${dir}/import.test.ts`, 'import { a } from "./a.ts";'],
      [
        `${dir}/outside.test.ts`,
        'readFileSync(join(import.meta.dirname, "../scripts/gen.mjs"));',
      ],
      [
        `${dir}/dts.test.ts`,
        'readFileSync(new URL("./types.d.ts", import.meta.url));',
      ],
      [
        `${dir}/up.test.ts`,
        [
          "export {};",
          'const up = join(import.meta.dirname, "..");',
          'function read(n: string) { return readFileSync(join(up, "scripts", n)); }',
        ].join("\n"),
      ],
      [
        `${dir}/imported.test.ts`,
        [
          'import { imported } from "./paths.ts";',
          'readFileSync(join(imported, "a.ts"), "utf8");',
        ].join("\n"),
      ],
    ]);
    const targets = new Set([
      `${dir}/a.ts`,
      `${dir}/b/c.ts`,
      `${dir}/types.d.ts`,
      "packages/x/scripts/gen.mjs",
    ]);
    expect(
      scanSourceReads(sources, targets).map((r) => [r.test, r.path, r.files]),
    ).toEqual([
      [
        "packages/x/src/bun.test.ts",
        "packages/x/src/a.ts",
        ["packages/x/src/a.ts"],
      ],
      [
        "packages/x/src/dts.test.ts",
        "packages/x/src/types.d.ts",
        ["packages/x/src/types.d.ts"],
      ],
      [
        "packages/x/src/named.test.ts",
        "packages/x/src/",
        [
          "packages/x/src/a.ts",
          "packages/x/src/b/c.ts",
          "packages/x/src/types.d.ts",
        ],
      ],
      [
        "packages/x/src/outside.test.ts",
        "packages/x/scripts/gen.mjs",
        ["packages/x/scripts/gen.mjs"],
      ],
      [
        "packages/x/src/raw.test.ts",
        "packages/x/src/a.ts",
        ["packages/x/src/a.ts"],
      ],
      [
        "packages/x/src/up.test.ts",
        "packages/x/scripts/",
        ["packages/x/scripts/gen.mjs"],
      ],
      [
        "packages/x/src/url.test.ts",
        "packages/x/src/a.ts",
        ["packages/x/src/a.ts"],
      ],
      [
        "packages/x/src/urlname.test.ts",
        "packages/x/src/",
        [
          "packages/x/src/a.ts",
          "packages/x/src/b/c.ts",
          "packages/x/src/types.d.ts",
        ],
      ],
      [
        "packages/x/src/walk.test.ts",
        "packages/x/src/",
        [
          "packages/x/src/a.ts",
          "packages/x/src/b/c.ts",
          "packages/x/src/types.d.ts",
        ],
      ],
    ]);
  });
});

describe("FIXTURE_CONSUMERS guard", () => {
  let repoReads: SourceRead[] | undefined;
  /** The repository's cross-project and project-doc reads of non-source files; computed once. */
  const scanRepo = (): SourceRead[] => {
    if (repoReads !== undefined) return repoReads;
    const { listed, tests } = scanInputs();
    const dirs = projectDirs();
    const owners = new Map<string, string[]>();
    const ownersOf = (f: string) => {
      const known = owners.get(f);
      if (known !== undefined) return known;
      const ps = readOwners(f, dirs);
      owners.set(f, ps);
      return ps;
    };
    repoReads = crossProject(
      scanSourceReads(tests, new Set(fixtureTargets(listed)), {
        imports: true,
      }),
      (f) => projectFor(f, dirs),
      ownersOf,
    );
    return repoReads;
  };

  it("every detected cross-project non-source file reader has a row or an exemption", () => {
    expect(
      uncovered(
        scanRepo(),
        FIXTURE_CONSUMERS,
        FIXTURE_EXEMPT,
        "FIXTURE_CONSUMERS",
      ),
    ).toEqual([]);
  });

  it("catches the angular mapping invariant without its oracle-fixture row", () => {
    const reader =
      "packages/hosts/angular/test/ng-mx-mapping-invariant.test.ts";
    const rows = FIXTURE_CONSUMERS.map((row) => ({
      ...row,
      consumers: row.consumers.filter((c) => c !== reader),
    }));
    expect(
      uncovered(scanRepo(), rows, FIXTURE_EXEMPT, "FIXTURE_CONSUMERS"),
    ).toEqual([
      "packages/hosts/angular/test/ng-mx-mapping-invariant.test.ts reads packages/oracle/fixtures/angular/ with no FIXTURE_CONSUMERS row",
    ]);
  });

  it("catches a patch reader: stock-marko's vendor test without its patch row", () => {
    const reader = "packages/stock-marko/src/vendor.test.ts";
    const rows = FIXTURE_CONSUMERS.map((row) =>
      row.path.test("patches/htmljs-parser@5.18.0.patch")
        ? { ...row, consumers: row.consumers.filter((c) => c !== reader) }
        : row,
    );
    expect(
      uncovered(scanRepo(), rows, FIXTURE_EXEMPT, "FIXTURE_CONSUMERS"),
    ).toEqual([
      "packages/stock-marko/src/vendor.test.ts reads patches/htmljs-parser@5.18.0.patch with no FIXTURE_CONSUMERS row",
    ]);
  });

  it("catches a same-project readers-only read: the vocabulary guard without its allowlist row", () => {
    const reader = "packages/core/src/message-vocabulary-guard.test.ts";
    const rows = FIXTURE_CONSUMERS.map((row) =>
      row.path.test("packages/core/src/message-vocabulary-guard.allowlist.txt")
        ? { ...row, consumers: row.consumers.filter((c) => c !== reader) }
        : row,
    );
    expect(
      uncovered(scanRepo(), rows, FIXTURE_EXEMPT, "FIXTURE_CONSUMERS"),
    ).toEqual([
      "packages/core/src/message-vocabulary-guard.test.ts reads packages/core/src/ with no FIXTURE_CONSUMERS row",
      "packages/core/src/message-vocabulary-guard.test.ts reads packages/core/src/message-vocabulary-guard.allowlist.txt with no FIXTURE_CONSUMERS row",
    ]);
  });

  it("catches a same-project manifest read: manifest.test.ts without its row", () => {
    const reader = "packages/editors/vscode/src/manifest.test.ts";
    const rows = FIXTURE_CONSUMERS.map((row) =>
      row.path.test("packages/editors/vscode/package.json")
        ? { ...row, consumers: row.consumers.filter((c) => c !== reader) }
        : row,
    );
    expect(
      uncovered(scanRepo(), rows, FIXTURE_EXEMPT, "FIXTURE_CONSUMERS"),
    ).toEqual([
      "packages/editors/vscode/src/manifest.test.ts reads packages/editors/vscode/ with no FIXTURE_CONSUMERS row",
      "packages/editors/vscode/src/manifest.test.ts reads packages/editors/vscode/package.json with no FIXTURE_CONSUMERS row",
    ]);
  });

  it("a path-scoped exemption covers only reads whose files all match it", () => {
    const allow = "packages/core/src/message-vocabulary-guard.allowlist.txt";
    const reads: SourceRead[] = [
      {
        test: "packages/core/src/a.test.ts",
        path: "packages/core/src/",
        files: [allow],
      },
      {
        test: "packages/core/src/b.test.ts",
        path: "packages/core/src/",
        files: [allow, "packages/core/src/x.json"],
      },
    ];
    const exempt = [
      { test: "packages/core/src/a.test.ts", path: ALLOWLIST },
      { test: "packages/core/src/b.test.ts", path: ALLOWLIST },
    ];
    expect(uncovered(reads, [], exempt, "FIXTURE_CONSUMERS")).toEqual([
      "packages/core/src/b.test.ts reads packages/core/src/ with no FIXTURE_CONSUMERS row",
    ]);
  });

  it("catches a same-project project-doc read: the parser boundary test without its exemption", () => {
    const exempt = FIXTURE_EXEMPT.filter(
      (e) => e.test !== "packages/parser/src/frontend/boundary.test.ts",
    );
    expect(
      uncovered(scanRepo(), FIXTURE_CONSUMERS, exempt, "FIXTURE_CONSUMERS"),
    ).toEqual([
      "packages/parser/src/frontend/boundary.test.ts reads packages/parser/src/template/ with no FIXTURE_CONSUMERS row",
    ]);
  });

  it("a project doc, a readers-only file or a manifest has no owner; any other file keeps its projects", () => {
    const dirs = projectDirs();
    expect(readOwners("packages/core/README.md", dirs)).toEqual([]);
    expect(readOwners("apps/docs/docs/specification.md", dirs)).toEqual([]);
    expect(
      readOwners(
        "packages/core/src/message-vocabulary-guard.allowlist.txt",
        dirs,
      ),
    ).toEqual([]);
    expect(readOwners("packages/core/package.json", dirs)).toEqual([]);
    expect(
      readOwners(
        "packages/core/src/fixtures/host-policy/peer-only/package.json",
        dirs,
      ),
    ).toEqual(["@mxlang/core", "@mxlang/core-isolated"]);
    expect(readOwners("packages/babel/UPSTREAM.md", dirs)).toEqual([
      "@mxlang/babel",
    ]);
    expect(
      readOwners("packages/oracle/fixtures/angular/README.md", dirs),
    ).toEqual(["@mxlang/oracle"]);
  });

  it("every exemption is detected and covered by no row", () => {
    const reads = scanRepo();
    expect(
      FIXTURE_EXEMPT.filter((e) => !reads.some((r) => exempts(e, r))).map(
        (e) => e.test,
      ),
    ).toEqual([]);
    expect(
      reads
        .filter(
          (r) =>
            FIXTURE_EXEMPT.some((e) => exempts(e, r)) &&
            coveredRead(r, FIXTURE_CONSUMERS),
        )
        .map((r) => r.test),
    ).toEqual([]);
  });

  it("counts relative imports as reads, and only reads of another project", () => {
    const dir = "packages/b/src";
    const importForms: [string, string][] = [
      [
        `${dir}/json.test.ts`,
        'import cases from "../../../test-fixtures/ws/cases.json";',
      ],
      [
        `${dir}/dynamic.test.ts`,
        [
          "export {};",
          'const m = () => import("../../a/src/fixtures/probe.ts");',
        ].join("\n"),
      ],
      [
        `${dir}/reexport.test.ts`,
        'export { x } from "../../a/src/fixtures/probe.ts";',
      ],
    ];
    const sources = new Map<string, string>([
      ...importForms,
      [
        `${dir}/dir.test.ts`,
        [
          "export {};",
          'function read(name: string) { return readFileSync(join(import.meta.dirname, "../../a/src/fixtures", name)); }',
        ].join("\n"),
      ],
      [
        `${dir}/own.test.ts`,
        'readFileSync(join(import.meta.dirname, "fixtures/own.mx"));',
      ],
      [`${dir}/source.test.ts`, 'import { f } from "../../a/src/index.ts";'],
    ]);
    const targets = new Set([
      "test-fixtures/ws/cases.json",
      "packages/a/src/fixtures/probe.ts",
      "packages/b/src/fixtures/own.mx",
    ]);
    const projectOf = (f: string) =>
      f.startsWith("packages/a/")
        ? "a"
        : f.startsWith("packages/b/")
          ? "b"
          : undefined;
    const ownersOf = (f: string) => {
      const p = projectOf(f);
      return p === undefined ? [] : [p];
    };
    expect(
      crossProject(
        scanSourceReads(sources, targets, { imports: true }),
        projectOf,
        ownersOf,
      ).map((r) => [r.test, r.path, r.files]),
    ).toEqual([
      [
        "packages/b/src/dir.test.ts",
        "packages/a/src/fixtures/",
        ["packages/a/src/fixtures/probe.ts"],
      ],
      [
        "packages/b/src/dynamic.test.ts",
        "packages/a/src/fixtures/probe.ts",
        ["packages/a/src/fixtures/probe.ts"],
      ],
      [
        "packages/b/src/json.test.ts",
        "test-fixtures/ws/cases.json",
        ["test-fixtures/ws/cases.json"],
      ],
      [
        "packages/b/src/reexport.test.ts",
        "packages/a/src/fixtures/probe.ts",
        ["packages/a/src/fixtures/probe.ts"],
      ],
    ]);
    expect(scanSourceReads(new Map(importForms), targets)).toEqual([]);
  });
});
