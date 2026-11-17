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
  parserBuildNeeded,
  probeConsumers,
  projectDirs,
  projectFor,
  projectsFor,
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
    expect(relatedSources(changed, dirs)).toEqual([
      "packages/web-elements/src/index.ts",
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

describe("parserBuildNeeded", () => {
  it("asks for the rebuild when a parser:build input changed", () => {
    for (const f of [
      "packages/babel/src/tokenizer/index.ts",
      "packages/babel/package.json",
      "packages/parser/src/frontend/babel.ts",
      "packages/parser/package.json",
    ])
      expect(parserBuildNeeded([f]), f).toBe(true);
  });
  it("does not for any other change", () => {
    for (const f of [
      "packages/parser/src/frontend/parse.ts",
      "packages/core/src/babel.ts",
      "packages/babel/README.md",
      "packages/parser/moon.yml",
    ])
      expect(parserBuildNeeded([f]), f).toBe(false);
    expect(parserBuildNeeded([])).toBe(false);
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
      return asPath({ kind: "template", head: posix.join(dir, rel.head) });
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
 * The source-text reads of each test in `sources` (repo-relative path to
 * text), against `targets` (the sources a comment-only edit can leave out),
 * deduped per test and sorted. One program over every file; `noResolve`, so
 * an imported binding is unknown.
 */
function scanSourceReads(
  sources: ReadonlyMap<string, string>,
  targets: ReadonlySet<string>,
): SourceRead[] {
  const files = [...sources.keys()].sort();
  const sorted = [...targets].sort();
  const under = (dir: string) =>
    dir.split("/").includes("src")
      ? sorted.filter((t) => t.startsWith(`${dir}/`))
      : [];
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
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.endsWith("?raw")
      ) {
        raw(node.moduleSpecifier.text);
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
          if (
            first !== undefined &&
            ts.isStringLiteralLike(first) &&
            first.text.endsWith("?raw")
          ) {
            raw(first.text);
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

/** Whether a row lists the read's test and matches a file the read reaches. */
function coveredRead(
  read: SourceRead,
  rows: typeof SOURCE_TEXT_READERS,
): boolean {
  return rows.some(
    (row) =>
      row.consumers.includes(read.test) &&
      read.files.some((f) => row.path.test(f)),
  );
}

/** One sorted, deduped message per read neither covered by `rows` nor exempt. */
function uncovered(
  reads: readonly SourceRead[],
  rows: typeof SOURCE_TEXT_READERS,
  exempt: readonly { test: string }[],
): string[] {
  const messages = reads
    .filter(
      (r) => !exempt.some((e) => e.test === r.test) && !coveredRead(r, rows),
    )
    .map((r) => `${r.test} reads ${r.path} with no SOURCE_TEXT_READERS row`);
  return [...new Set(messages)].sort();
}

/** Detected readers whose result cannot change on a comment-only edit. */
const EXEMPT: readonly { test: string; reason: string }[] = [
  // Hashes declarations printed with `removeComments: true`: comments never reach the hash.
  {
    test: "packages/core/src/ir-entry/ir-version.test.ts",
    reason: "hashes declarations printed without comments",
  },
  // Its `here` walk reads only the .mx files under src/fixtures/host-dispatch, no source.
  {
    test: "packages/tooling/tsc/src/host-dispatch-golden.test.ts",
    reason: "reads only fixture .mx files",
  },
];

describe("SOURCE_TEXT_READERS guard", () => {
  const ROOT = resolve(import.meta.dirname, "..");
  let repoReads: SourceRead[] | undefined;
  /** The repository's reads: git's file list, sorted; computed once. */
  const scanRepo = (): SourceRead[] => {
    if (repoReads !== undefined) return repoReads;
    const listed = spawnSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    if (listed.status !== 0) throw new Error(listed.stderr);
    const all = [...new Set(listed.stdout.split("\n").filter(Boolean))]
      .filter((f) => existsSync(resolve(ROOT, f)))
      .sort();
    const sources = new Map<string, string>();
    for (const f of all.filter((f) => VITEST_TEST_FILE.test(f))) {
      const text = readFileSync(resolve(ROOT, f), "utf8");
      if (/readFileSync|readFile\b|Bun\.file|\?raw/.test(text)) {
        sources.set(f, text);
      }
    }
    const targets = new Set(
      all.filter(
        (f) =>
          /\.tsx?$/.test(f) &&
          f.split("/").includes("src") &&
          !/\.(?:test|spec)\.|\.d\.ts$/.test(f) &&
          isRelatedSource(f),
      ),
    );
    repoReads = scanSourceReads(sources, targets);
    return repoReads;
  };

  it("every detected reader of a source's text has a row or an exemption", () => {
    expect(uncovered(scanRepo(), SOURCE_TEXT_READERS, EXEMPT)).toEqual([]);
  });

  it("catches #823's miss: the vocabulary guard without its core-row entry", () => {
    const guard = "packages/core/src/message-vocabulary-guard.test.ts";
    const rows = SOURCE_TEXT_READERS.map((row) => ({
      ...row,
      consumers: row.consumers.filter((c) => c !== guard),
    }));
    expect(uncovered(scanRepo(), rows, EXEMPT)).toEqual([
      "packages/core/src/message-vocabulary-guard.test.ts reads packages/core/src/ with no SOURCE_TEXT_READERS row",
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
          "const SRC = import.meta.dirname;",
          'function read(name: string) { return readFileSync(join(SRC, name), "utf8"); }',
        ].join("\n"),
      ],
      [`${dir}/raw.test.ts`, 'import t from "./a.ts?raw";'],
      [`${dir}/bun.test.ts`, 'Bun.file(join(import.meta.dirname, "a.ts"));'],
      [
        `${dir}/walk.test.ts`,
        [
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
          "const here = import.meta.dirname;",
          'readFileSync(join(here, "fixtures", "a.ts"), "utf8");',
        ].join("\n"),
      ],
      [
        `${dir}/json.test.ts`,
        [
          "const here = import.meta.dirname;",
          'readFileSync(join(here, "../package.json"), "utf8");',
        ].join("\n"),
      ],
      [
        `${dir}/temp.test.ts`,
        [
          'const tmp = mkdtempSync(join(tmpdir(), "x-"));',
          'writeFileSync(join(tmp, "index.ts"), "export {};");',
          'readFileSync(join(tmp, "index.ts"), "utf8");',
        ].join("\n"),
      ],
      [`${dir}/import.test.ts`, 'import { a } from "./a.ts";'],
      [
        `${dir}/imported.test.ts`,
        [
          'import { imported } from "./paths.ts";',
          'readFileSync(join(imported, "a.ts"), "utf8");',
        ].join("\n"),
      ],
    ]);
    const targets = new Set([`${dir}/a.ts`, `${dir}/b/c.ts`]);
    expect(
      scanSourceReads(sources, targets).map((r) => [r.test, r.path, r.files]),
    ).toEqual([
      [
        "packages/x/src/bun.test.ts",
        "packages/x/src/a.ts",
        ["packages/x/src/a.ts"],
      ],
      [
        "packages/x/src/named.test.ts",
        "packages/x/src/",
        ["packages/x/src/a.ts", "packages/x/src/b/c.ts"],
      ],
      [
        "packages/x/src/raw.test.ts",
        "packages/x/src/a.ts",
        ["packages/x/src/a.ts"],
      ],
      [
        "packages/x/src/url.test.ts",
        "packages/x/src/a.ts",
        ["packages/x/src/a.ts"],
      ],
      [
        "packages/x/src/walk.test.ts",
        "packages/x/src/",
        ["packages/x/src/a.ts", "packages/x/src/b/c.ts"],
      ],
    ]);
  });
});
