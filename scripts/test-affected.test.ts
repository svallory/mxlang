import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import { createVitest } from "vitest/node";
import {
  DOC_READERS,
  FIXTURE_CONSUMERS,
  fixtureConsumers,
  hasVitestTests,
  isProjectDoc,
  isRelatedSource,
  isWide,
  laneFor,
  nonSourceProjects,
  ownRunnerDirs,
  ownRunnerPlan,
  PROBE_CONSUMER,
  probeConsumers,
  projectDirs,
  projectFor,
  projectsFor,
  relatedPassWithNoTests,
  relatedSources,
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
      relatedSources(["packages/tooling/typescript-plugin/AGENTS.md"], dirs),
    ).toEqual([CORPUS]);
    expect(
      relatedSources(
        [
          "packages/core/README.md",
          "packages/hosts/solid/src/emitter.ts",
          "packages/parser/src/template/corpus-equivalence.test.ts",
          "packages/core/CHANGELOG.md",
        ],
        dirs,
      ),
    ).toEqual(["packages/hosts/solid/src/emitter.ts", CORPUS, PROBE_CONSUMER]);
  });

  it("a root doc or a source-only change adds no Markdown reader", () => {
    expect(relatedSources(["docs/a.md"], dirs)).toEqual([]);
    expect(relatedSources(["packages/core/src/core.ts"], dirs)).toEqual([
      "packages/core/src/core.ts",
    ]);
  });
});
