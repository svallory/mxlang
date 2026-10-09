import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors the root package.json `workspaces` globs.
const WORKSPACE_PARENTS = ["packages", "packages/*", "examples", "apps"];
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
] as const;

function listDirs(parent: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(repoRoot, parent))) {
    if (name === "node_modules") continue;
    const rel = join(parent, name);
    if (statSync(join(repoRoot, rel)).isDirectory()) out.push(rel);
  }
  return out;
}

function workspaceDirs(): string[] {
  const dirs: string[] = [];
  for (const glob of WORKSPACE_PARENTS) {
    const parents = glob.endsWith("/*") ? listDirs(glob.slice(0, -2)) : [glob];
    for (const parent of parents) {
      // `packages` and `examples`/`apps` list their children; `packages/*`
      // lists the grandchildren, so the group directories themselves count
      // only when they hold a package.json.
      for (const dir of listDirs(parent)) dirs.push(dir);
    }
  }
  return dirs;
}

/** name -> workspace names it depends on (`workspace:` ranges only). */
function workspaceGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const dir of workspaceDirs()) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(
        readFileSync(join(repoRoot, dir, "package.json"), "utf8"),
      );
    } catch {
      continue;
    }
    const name = pkg.name;
    if (typeof name !== "string") continue;
    const deps = new Set<string>();
    for (const field of DEP_FIELDS) {
      const block = pkg[field] as Record<string, string> | undefined;
      for (const [dep, range] of Object.entries(block ?? {})) {
        if (typeof range === "string" && range.startsWith("workspace:")) {
          deps.add(dep);
        }
      }
    }
    graph.set(name, [...deps].sort());
  }
  return new Map([...graph].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Cycles that predate the babel/tsx-bridge split and are not this check's to
 * fix. Each needs an architectural decision (see the report for the PR that
 * added this file); the test fails if one disappears (delete it here) or if
 * any other cycle appears.
 */
const KNOWN_CYCLES = [
  "@mxlang/astro -> @mxlang/vite-plugin -> @mxlang/target-registry -> @mxlang/astro",
];

/** Every distinct cycle found by DFS, each as `a -> b -> a`. */
function findCycles(graph: Map<string, string[]>): string[] {
  const cycles = new Set<string>();
  const done = new Set<string>();
  const visit = (node: string, path: string[]) => {
    const at = path.indexOf(node);
    if (at !== -1) {
      cycles.add([...path.slice(at), node].join(" -> "));
      return;
    }
    if (done.has(node)) return;
    for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
    done.add(node);
  };
  for (const node of graph.keys()) visit(node, []);
  return [...cycles].sort();
}

function adjacencyList(graph: Map<string, string[]>): string {
  return [...graph]
    .map(([name, deps]) => `${name}: ${deps.join(", ") || "-"}`)
    .join("\n");
}

describe("workspace dependency graph", () => {
  const graph = workspaceGraph();

  it("reads every workspace package", () => {
    expect(graph.has("@mxlang/core")).toBe(true);
    expect(graph.has("@mxlang/babel")).toBe(true);
    expect(graph.has("@mxlang/tsx-bridge")).toBe(true);
  });

  it("has no cycle beyond the known ones", () => {
    const cycles = findCycles(graph);
    expect(
      cycles.filter((c) => !KNOWN_CYCLES.includes(c)),
      `new workspace cycle (bun links these into a symlink loop):\n${adjacencyList(graph)}`,
    ).toEqual([]);
    expect(
      KNOWN_CYCLES.filter((c) => !cycles.includes(c)),
      "a known cycle is gone: remove it from KNOWN_CYCLES",
    ).toEqual([]);
  });

  it("keeps hosts and tooling out of babel and tsx-bridge", () => {
    const allowed = new Set(["@mxlang/core", "@mxlang/babel"]);
    for (const name of ["@mxlang/babel", "@mxlang/tsx-bridge"]) {
      const extra = (graph.get(name) ?? []).filter((d) => !allowed.has(d));
      expect(extra, `${name} depends on ${extra.join(", ")}`).toEqual([]);
    }
    // native-parser makes core -> parser -> babel, so babel -> core would be a cycle.
    expect(graph.get("@mxlang/babel")).toEqual([]);
  });

  it("lets core use the parser as a devDependency only (decision 182)", () => {
    // Core resolves `package.json#mx.syntax` and runs the syntax table's
    // pre-pass with MX's template parser: from source through the workspace
    // package, in the dist through the bundled front end, so no published
    // `.d.ts` or runtime import names it. Parser port PR 4 needs this edge.
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages/core/package.json"), "utf8"),
    ) as Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>>;
    expect(manifest.devDependencies?.["@mxlang/parser"]).toBe("workspace:*");
    expect(manifest.dependencies?.["@mxlang/parser"]).toBeUndefined();
    expect(manifest.peerDependencies?.["@mxlang/parser"]).toBeUndefined();
  });

  it("points every host at tsx-bridge, never at the parser package", () => {
    for (const [name, deps] of graph) {
      if (name === "@mxlang/parser") continue;
      // Private test package of the parser port (PR 2 to PR 6): it compares
      // the parser's front end with today's Marko tree and is never published.
      if (name === "@mxlang/parse-differential") continue;
      // Private reference package: it compares stock htmljs-parser events with
      // the parser's front end and is never published.
      if (name === "@mxlang/stock-marko") continue;
      // Decision 182 (PR C): core may use the parser as a devDependency
      // only; "lets core use the parser as a devDependency only" pins it.
      if (name === "@mxlang/core") continue;
      expect(deps, `${name} depends on @mxlang/parser`).not.toContain(
        "@mxlang/parser",
      );
    }
  });
});
