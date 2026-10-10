/**
 * The cold-start guard (the `perf/core-cold-start` work): importing
 * `@mxlang/core` and lowering a plain (TypeScript-free) file must not load
 * the dependencies only heavier paths need — no wall-clock thresholds, which
 * flake, but a module-registry probe in a fresh child process, which is
 * deterministic.
 *
 * Two pins:
 *
 * - **The built `dist`** (what a registry install loads) under Node: a child
 *   process preloaded with a `Module._load` hook imports `dist/index.js`,
 *   lowers a plain file, and the test reads the hook's log. Lazy loading must
 *   survive bundling, so the dist is the artifact that matters; the test
 *   skips (visibly) when no dist has been built yet.
 * - **The sources**: no `src` module may statically import (as a value) any
 *   of the lazy dependencies, which is what keeps a rebuild lazy too —
 *   `import type` is fine, and `marko-frontend.ts` requires its pieces by
 *   hand already.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "index.js");

/** A dependency list entry in `Module._load` terms: the request string. */
function loadedRequests(log: string): string[] {
  return log
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(line.indexOf("ms ") + 3));
}

/** Runs `import(dist); lowerSource(plain)` in a fresh Node, returns the requests `Module._load` saw. */
function probe(entry: string, mode: "import" | "plain" | "dialect"): string[] {
  const dir = mkdtempSync(join(tmpdir(), "mx-cold-start-"));
  try {
    const log = join(dir, "loads.txt");
    writeFileSync(log, "");
    const hook = join(dir, "hook.cjs");
    writeFileSync(
      hook,
      `const Module = require("node:module");
const fs = require("node:fs");
const out = ${JSON.stringify(log)};
const orig = Module._load;
Module._load = function (request) {
  fs.appendFileSync(out, "0ms " + request + "\\n");
  return orig.apply(this, arguments);
};
`,
    );
    const probe = join(dir, "probe.mjs");
    const plain =
      '<div class="a">text and an ' +
      "'" +
      "${" +
      '"<b>hi</b>"' +
      "}" +
      "'" +
      " expression</div>";
    // A non-default table (one `&`-member expression trigger, a built-in
    // node kind, never used by the source), so resolving the dialect
    // validates it — the path that must not load `marko-frontend.cjs`.
    const member = {
      id: "member",
      chars: "&",
      match: "&[a-zA-Z_$][a-zA-Z0-9_$]*",
      standIn: "identifier",
      node: "identifier",
    };
    const dialect = JSON.stringify({
      id: "probe",
      name: "Probe",
      table: { expressionTriggers: [member] },
      tagRules: "none",
    });
    const options =
      mode === "dialect" ? `{ dialect: ${dialect}, tagRules: "none" }` : "{}";
    writeFileSync(
      probe,
      `const core = await import(${JSON.stringify(entry)});
if (${JSON.stringify(mode !== "import")}) {
  const result = core.lowerSource(${JSON.stringify(plain)}, "probe.mx", ${options});
  if (result.ir === undefined) {
    throw new Error("lowerSource failed: " + JSON.stringify(result.diagnostics));
  }
}
`,
    );
    const run = spawnSync(process.execPath, ["--require", hook, probe], {
      encoding: "utf8",
      cwd: dir,
    });
    if (run.status !== 0) {
      throw new Error(
        `probe failed (${run.status}): ${run.stderr}${run.stdout}`,
      );
    }
    return loadedRequests(readFileSync(log, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The external packages a dist entry imports statically, by specifier: every
 * `import … from`, side-effect `import "…"`, and `export … from` form, across
 * every `dist/*.js` entry. The bundler emits each on its own line, so the
 * scan is line-anchored — free-text matches inside generated string literals
 * must not count.
 */
function staticImportsOfDist(): string[] {
  const distDir = join(here, "..", "dist");
  const imports: string[] = [];
  for (const name of readdirSync(distDir)) {
    if (!name.endsWith(".js")) continue;
    for (const raw of readFileSync(join(distDir, name), "utf8").split("\n")) {
      const line = raw.trim().replace(/;$/, "");
      const forms = [
        /^import\s+"([^"]+)"$/,
        /^import\s[^;]*?from\s+"([^"]+)"$/,
        /^export\s[^;]*?from\s+"([^"]+)"$/,
      ];
      for (const form of forms) {
        const match = form.exec(line);
        if (
          match?.[1] &&
          !match[1].startsWith("node:") &&
          !match[1].startsWith(".")
        ) {
          imports.push(match[1]);
        }
      }
    }
  }
  return imports;
}

describe("cold start: the built dist loads the heavy dependencies lazily", () => {
  it.skipIf(!existsSync(dist))(
    "importing core loads no Babel package and no cosmiconfig",
    () => {
      // Static ESM imports bypass `Module._load`, so the dist's own import
      // lines are checked directly: every external import is a failure.
      expect(staticImportsOfDist()).toEqual([]);
      // And nothing may be required on import alone.
      for (const request of probe(dist, "import")) {
        expect(
          request.startsWith("@babel/") || request === "cosmiconfig",
          `${request} loaded on import`,
        ).toBe(false);
      }
    },
  );

  it.skipIf(!existsSync(dist))(
    "lowering a plain file still loads no cosmiconfig",
    () => {
      const requests = probe(dist, "plain");
      // `@babel/core` (traverse/types), `@babel/parser` and the TS strip
      // plugin are the lowering path's own cost — the strip runs for every
      // payload, TypeScript or not (it is not a no-op on TS-free programs).
      // cosmiconfig is only a config read's cost, and a plain file reads none.
      expect(requests).toContain("@babel/core");
      expect(requests.filter((r) => r === "cosmiconfig")).toEqual([]);
    },
  );

  it.skipIf(!existsSync(dist))(
    "lowering under a dialect loads no marko-frontend bundle",
    () => {
      // Validating a dialect's syntax table uses the template parser the
      // dist already inlines (`mxTemplateParser`); loading the whole
      // `marko-frontend.cjs` for it was ~50 ms of a dialect's first call.
      const requests = probe(dist, "dialect");
      expect(requests.filter((r) => r.includes("marko-frontend"))).toEqual([]);
    },
  );
});

describe("cold start: no source module statically imports a lazy dependency", () => {
  it("every src import of them is type-only or a hand-rolled require", async () => {
    const statSync = (await import("node:fs")).statSync;
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "fixtures") walk(path);
        } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
          sources.push(path);
        }
      }
    };
    walk(here);
    const lazy = [
      "cosmiconfig",
      "@babel/parser",
      "@babel/core",
      "@babel/generator",
      "@babel/code-frame",
      "@babel/plugin-transform-typescript",
    ];
    for (const path of sources) {
      const text = readFileSync(path, "utf8");
      for (const dependency of lazy) {
        const escaped = dependency.replace("/", "\\/");
        // Every import form loads the module — named/default values,
        // side-effect `import "…"`, and `export … from` — except a whole
        // `import type … from "…"`, which is erased. Line-anchored, so prose
        // in comments never matches.
        const clauses = [
          ...text.matchAll(
            new RegExp(
              `^\\s*import\\s+([^;\\n]*?)\\s*from\\s*"${escaped}"`,
              "gm",
            ),
          ),
          ...text.matchAll(new RegExp(`^\\s*import\\s+"${escaped}"`, "gm")),
          ...text.matchAll(
            new RegExp(`^\\s*export\\s+[^;\\n]*?from\\s*"${escaped}"`, "gm"),
          ),
        ].map((match) => (match[1] ?? "").trim());
        for (const clause of clauses) {
          expect(
            clause === "type" || clause.startsWith("type "),
            `${relative(here, path)} value-imports ${dependency}`,
          ).toBe(true);
        }
      }
    }
  });
});
