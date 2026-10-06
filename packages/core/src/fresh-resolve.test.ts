import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A differential test: for each package shape, the truth is the runtime's own
// `require.resolve` in a process where the package was installed before it
// started (an empty resolver cache). `loadTargetDescriptor` must load that
// same file, or fail when the runtime fails, both in that process and in one
// where the same specifier missed before the install. Every shape runs on Bun
// and on Node, so a rule only one runtime follows is pinned per runtime.
//
// Each module file's descriptor `name` encodes its own path, so a loaded
// descriptor names the file the loader chose.

const loader = join(import.meta.dirname, "target-loader.ts");

interface Case {
  /** Files under the case root; the project is `app/`. */
  files: Record<string, string>;
  spec?: string;
  /** Pinned outcomes: a path under the case root, or `"ERR"`. */
  expect?: { bun?: string; node?: string };
}

const P = "app/node_modules/@fake/p";
const ESCAPED = "app/node_modules/@fake/escaped.cjs";

const cases: Record<string, Case> = {
  // main
  'main ""': {
    files: { [`${P}/package.json`]: '{"main":""}', [`${P}/index.js`]: "" },
    expect: { bun: `${P}/index.js`, node: `${P}/index.js` },
  },
  'main "."': {
    files: { [`${P}/package.json`]: '{"main":"."}', [`${P}/index.js`]: "" },
    expect: { bun: `${P}/index.js`, node: `${P}/index.js` },
  },
  'main "./"': {
    files: { [`${P}/package.json`]: '{"main":"./"}', [`${P}/index.js`]: "" },
    expect: { bun: `${P}/index.js`, node: `${P}/index.js` },
  },
  'main "" with only index.cjs': {
    files: { [`${P}/package.json`]: '{"main":""}', [`${P}/index.cjs`]: "" },
    expect: { bun: `${P}/index.cjs`, node: "ERR" },
  },
  "main leaving the package": {
    files: {
      [`${P}/package.json`]: '{"main":"../escaped.cjs"}',
      [ESCAPED]: "",
    },
    expect: { bun: ESCAPED, node: ESCAPED },
  },
  "main leaving the package, no extension": {
    files: { [`${P}/package.json`]: '{"main":"../escaped"}', [ESCAPED]: "" },
    expect: { bun: ESCAPED, node: "ERR" },
  },
  "absolute main": {
    files: {
      [`${P}/package.json`]:
        '{"main":"$ROOT/app/node_modules/@fake/escaped.cjs"}',
      [ESCAPED]: "",
    },
    expect: { bun: ESCAPED, node: ESCAPED },
  },
  "main m, only m.cjs": {
    files: { [`${P}/package.json`]: '{"main":"m"}', [`${P}/m.cjs`]: "" },
    expect: { bun: `${P}/m.cjs`, node: "ERR" },
  },
  "main m, only m.ts": {
    files: { [`${P}/package.json`]: '{"main":"m"}', [`${P}/m.ts`]: "" },
    expect: { bun: `${P}/m.ts`, node: "ERR" },
  },
  "main m, only m.json": {
    files: { [`${P}/package.json`]: '{"main":"m"}', [`${P}/m.json`]: "" },
  },
  "main m, m.js and m.cjs": {
    files: {
      [`${P}/package.json`]: '{"main":"m"}',
      [`${P}/m.js`]: "",
      [`${P}/m.cjs`]: "",
    },
  },
  "main m, m.cjs and m.ts (Bun's main order)": {
    files: {
      [`${P}/package.json`]: '{"main":"m"}',
      [`${P}/m.ts`]: "",
      [`${P}/m.cjs`]: "",
    },
    expect: { bun: `${P}/m.cjs`, node: "ERR" },
  },
  "main m is a directory with index.cjs": {
    files: { [`${P}/package.json`]: '{"main":"m"}', [`${P}/m/index.cjs`]: "" },
    expect: { bun: `${P}/m/index.cjs`, node: "ERR" },
  },
  "main m is a directory with its own package.json": {
    files: {
      [`${P}/package.json`]: '{"main":"m"}',
      [`${P}/m/package.json`]: '{"main":"z.js"}',
      [`${P}/m/z.js`]: "",
      [`${P}/m/index.js`]: "",
    },
    expect: { bun: `${P}/m/index.js`, node: `${P}/m/index.js` },
  },
  "main m.js beside a directory m": {
    files: {
      [`${P}/package.json`]: '{"main":"m"}',
      [`${P}/m.js`]: "",
      [`${P}/m/index.js`]: "",
    },
  },
  "main names a missing file: index.js": {
    files: {
      [`${P}/package.json`]: '{"main":"gone.cjs"}',
      [`${P}/index.js`]: "",
    },
    expect: { bun: `${P}/index.js`, node: `${P}/index.js` },
  },
  "main names a missing file: index.cjs": {
    files: {
      [`${P}/package.json`]: '{"main":"gone.cjs"}',
      [`${P}/index.cjs`]: "",
    },
  },
  "main names a missing file, no index": {
    files: { [`${P}/package.json`]: '{"main":"gone.cjs"}', [`${P}/x.js`]: "" },
    expect: { bun: "ERR", node: "ERR" },
  },
  "main is not a string": {
    files: { [`${P}/package.json`]: '{"main":42}', [`${P}/index.js`]: "" },
  },
  "main set after a miss, index.js present (Node's stale manifest)": {
    files: {
      [`${P}/package.json`]: '{"main":"lib/x.js"}',
      [`${P}/lib/x.js`]: "",
      [`${P}/index.js`]: "",
    },
    expect: { bun: `${P}/lib/x.js`, node: `${P}/lib/x.js` },
  },
  // no main
  "no main, index.cjs": {
    files: { [`${P}/package.json`]: "{}", [`${P}/index.cjs`]: "" },
  },
  "no main, index.json": {
    files: { [`${P}/package.json`]: "{}", [`${P}/index.json`]: "" },
  },
  "no main, index.ts": {
    files: { [`${P}/package.json`]: "{}", [`${P}/index.ts`]: "" },
  },
  "no package.json, index.js": { files: { [`${P}/index.js`]: "" } },
  "a file p.js beside the package directory": {
    files: {
      "app/node_modules/@fake/p.js": "",
      [`${P}/package.json`]: '{"main":"m.js"}',
      [`${P}/m.js`]: "",
    },
    expect: {
      bun: "app/node_modules/@fake/p.js",
      node: "app/node_modules/@fake/p.js",
    },
  },
  'main "." beside a file p.json': {
    files: {
      [`${P}/package.json`]: '{"main":"."}',
      "app/node_modules/@fake/p.json": "",
      [`${P}/index.js`]: "",
    },
  },
  // unusable manifests
  ...Object.fromEntries(
    (
      [
        ["null", "null"],
        ["an array", "[]"],
        ["a number", "42"],
        ["a string", '"x"'],
        ["malformed JSON", "{nope"],
      ] as const
    ).flatMap(([label, text]) => [
      [
        `a package.json that is ${label}, with index.js`,
        {
          files: { [`${P}/package.json`]: text, [`${P}/index.js`]: "" },
          expect: { bun: `${P}/index.js`, node: "ERR" },
        },
      ],
      [
        `a package.json that is ${label}, no index`,
        {
          files: { [`${P}/package.json`]: text, [`${P}/other.cjs`]: "" },
          expect: { bun: "ERR", node: "ERR" },
        },
      ],
    ]),
  ),
  // the walk
  "main missing here, the package in a parent node_modules": {
    files: {
      [`${P}/package.json`]: '{"main":"gone.js"}',
      "node_modules/@fake/p/package.json": '{"main":"i.js"}',
      "node_modules/@fake/p/i.js": "",
    },
    expect: { bun: "node_modules/@fake/p/i.js", node: "ERR" },
  },
  "a null package.json here, the package in a parent node_modules": {
    files: {
      [`${P}/package.json`]: "null",
      "node_modules/@fake/p/package.json": '{"main":"i.js"}',
      "node_modules/@fake/p/i.js": "",
    },
    expect: { bun: "node_modules/@fake/p/i.js", node: "ERR" },
  },
  "only a parent node_modules holds it": {
    files: {
      "node_modules/@fake/p/package.json": '{"main":"i.js"}',
      "node_modules/@fake/p/i.js": "",
    },
    expect: {
      bun: "node_modules/@fake/p/i.js",
      node: "node_modules/@fake/p/i.js",
    },
  },
  "exports here does not export it, a parent package would": {
    files: {
      [`${P}/package.json`]: '{"exports":{"./x":"./x.js"}}',
      "node_modules/@fake/p/package.json": '{"main":"i.js"}',
      "node_modules/@fake/p/i.js": "",
    },
    expect: { bun: "ERR", node: "ERR" },
  },
  // exports
  "exports string": {
    files: {
      [`${P}/package.json`]: '{"exports":"./e.cjs","main":"m.cjs"}',
      [`${P}/e.cjs`]: "",
      [`${P}/m.cjs`]: "",
    },
    expect: { bun: `${P}/e.cjs`, node: `${P}/e.cjs` },
  },
  "exports target with no extension is not probed": {
    files: { [`${P}/package.json`]: '{"exports":"./e"}', [`${P}/e.js`]: "" },
    expect: { bun: "ERR", node: "ERR" },
  },
  "exports names a missing file, main exists": {
    files: {
      [`${P}/package.json`]: '{"exports":"./gone.js","main":"index.js"}',
      [`${P}/index.js`]: "",
    },
    expect: { bun: "ERR", node: "ERR" },
  },
  "exports null, main used": {
    files: {
      [`${P}/package.json`]: '{"exports":null,"main":"m.cjs"}',
      [`${P}/m.cjs`]: "",
    },
  },
  "exports false": {
    files: {
      [`${P}/package.json`]: '{"exports":false}',
      [`${P}/index.js`]: "",
    },
    expect: { bun: "ERR", node: `${P}/index.js` },
  },
  "exports a number": {
    files: { [`${P}/package.json`]: '{"exports":42}', [`${P}/index.js`]: "" },
    expect: { bun: "ERR", node: `${P}/index.js` },
  },
  "exports {}": {
    files: { [`${P}/package.json`]: '{"exports":{}}', [`${P}/index.js`]: "" },
    expect: { bun: "ERR", node: "ERR" },
  },
  "exports top-level array": {
    files: {
      [`${P}/package.json`]: '{"exports":["./e.cjs"]}',
      [`${P}/e.cjs`]: "",
    },
  },
  "exports array, first entry import-only": {
    files: {
      [`${P}/package.json`]: '{"exports":[{"import":"./x.mjs"},"./e.cjs"]}',
      [`${P}/e.cjs`]: "",
    },
  },
  "exports '.' map": {
    files: {
      [`${P}/package.json`]: '{"exports":{".":{"default":"./e.cjs"}}}',
      [`${P}/e.cjs`]: "",
    },
  },
  "exports null target": {
    files: {
      [`${P}/package.json`]: '{"exports":{".":null}}',
      [`${P}/index.js`]: "",
    },
    expect: { bun: "ERR", node: "ERR" },
  },
  "exports a subpath": {
    spec: "@fake/p/t",
    files: {
      [`${P}/package.json`]: '{"exports":{"./t":"./t.cjs"}}',
      [`${P}/t.cjs`]: "",
    },
    expect: { bun: `${P}/t.cjs`, node: `${P}/t.cjs` },
  },
  "exports a subpath pattern": {
    spec: "@fake/p/t",
    files: {
      [`${P}/package.json`]: '{"exports":{"./*":"./lib/*.cjs"}}',
      [`${P}/lib/t.cjs`]: "",
    },
    expect: { bun: `${P}/lib/t.cjs`, node: `${P}/lib/t.cjs` },
  },
  "exports the longest-prefix pattern": {
    spec: "@fake/p/a/t",
    files: {
      [`${P}/package.json`]:
        '{"exports":{"./*":"./wide/*.cjs","./a/*":"./narrow/*.cjs"}}',
      [`${P}/wide/a/t.cjs`]: "",
      [`${P}/narrow/t.cjs`]: "",
    },
    expect: { bun: `${P}/narrow/t.cjs`, node: `${P}/narrow/t.cjs` },
  },
  "exports an exact key over a pattern": {
    spec: "@fake/p/t",
    files: {
      [`${P}/package.json`]:
        '{"exports":{"./*":"./wide/*.cjs","./t":"./exact.cjs"}}',
      [`${P}/wide/t.cjs`]: "",
      [`${P}/exact.cjs`]: "",
    },
    expect: { bun: `${P}/exact.cjs`, node: `${P}/exact.cjs` },
  },
  "exports a mixed subpath/condition map": {
    files: {
      [`${P}/package.json`]: '{"exports":{".":"./e.cjs","require":"./e.cjs"}}',
      [`${P}/e.cjs`]: "",
    },
    expect: { bun: "ERR", node: "ERR" },
  },
  ...Object.fromEntries(
    (
      [
        ["traversing", '{"exports":{".":{"require":"../escaped.cjs"}}}'],
        ["absolute", '{"exports":"$ROOT/app/node_modules/@fake/escaped.cjs"}'],
        ["bare", '{"exports":"escaped.cjs"}'],
        ["dot-segment", '{"exports":"./a/../../escaped.cjs"}'],
        ["node_modules-segment", '{"exports":"./node_modules/x/e.cjs"}'],
        ["trailing-slash", '{"exports":"./lib/"}'],
        ["array-entry", '{"exports":["../escaped.cjs"]}'],
      ] as const
    ).map(([label, manifest]) => [
      `exports a ${label} target`,
      {
        files: {
          [`${P}/package.json`]: manifest,
          [`${P}/node_modules/x/e.cjs`]: "",
          [`${P}/lib/index.js`]: "",
          [ESCAPED]: "",
        },
        expect: { bun: "ERR", node: "ERR" },
      },
    ]),
  ),
  // conditions
  ...Object.fromEntries(
    (
      [
        [
          "bun before require",
          { bun: "./b.cjs", require: "./r.cjs", default: "./d.cjs" },
          { bun: "b", node: "r" },
        ],
        [
          "require before bun",
          { require: "./r.cjs", bun: "./b.cjs" },
          { bun: "r", node: "r" },
        ],
        [
          "node before require",
          { node: "./n.cjs", require: "./r.cjs" },
          { bun: "n", node: "n" },
        ],
        [
          "default first",
          { default: "./d.cjs", require: "./r.cjs" },
          { bun: "d", node: "d" },
        ],
        [
          "only bun, then default",
          { bun: "./b.cjs", default: "./d.cjs" },
          { bun: "b", node: "d" },
        ],
        [
          "node-addons",
          { "node-addons": "./n.cjs", default: "./d.cjs" },
          { bun: "n", node: "n" },
        ],
        [
          "import, module, browser and types never match",
          {
            types: "./b.cjs",
            import: "./n.cjs",
            module: "./r.cjs",
            browser: "./b.cjs",
            default: "./d.cjs",
          },
          { bun: "d", node: "d" },
        ],
      ] as const
    ).map(([label, exports, picks]) => [
      `conditions: ${label}`,
      {
        files: {
          [`${P}/package.json`]: JSON.stringify({ exports }),
          [`${P}/b.cjs`]: "",
          [`${P}/n.cjs`]: "",
          [`${P}/r.cjs`]: "",
          [`${P}/d.cjs`]: "",
        },
        expect: {
          bun: `${P}/${picks.bun}.cjs`,
          node: `${P}/${picks.node}.cjs`,
        },
      },
    ]),
  ),
  // legacy subpaths
  "a subpath of a package with no exports": {
    spec: "@fake/p/s",
    files: { [`${P}/package.json`]: "{}", [`${P}/s.cjs`]: "" },
    expect: { bun: `${P}/s.cjs`, node: "ERR" },
  },
  "a subpath directory with its own package.json": {
    spec: "@fake/p/s",
    files: {
      [`${P}/package.json`]: "{}",
      [`${P}/s/package.json`]: '{"main":"x.js"}',
      [`${P}/s/x.js`]: "",
      [`${P}/s/index.js`]: "",
    },
    expect: { bun: `${P}/s/x.js`, node: `${P}/s/x.js` },
  },
  // self-reference
  "the project's own name, through its exports": {
    files: {
      "app/package.json": '{"name":"@fake/p","exports":"./self.cjs"}',
      "app/self.cjs": "",
      [`${P}/package.json`]: '{"main":"i.js"}',
      [`${P}/i.js`]: "",
    },
    expect: { bun: "app/self.cjs", node: "app/self.cjs" },
  },
};

/** A file's path as a descriptor name, which must be a bare word. */
const nameFor = (path: string) => `f${Buffer.from(path).toString("hex")}`;

/** The path a loaded descriptor's name stands for; errors pass through. */
const pathOf = (loaded: string) =>
  loaded.startsWith("ERR:")
    ? loaded
    : Buffer.from(loaded.slice(1), "hex").toString();

/** The descriptor a file holds, named after its path under the case root. */
function moduleText(path: string): string {
  const descriptor = `{ descriptorVersion: 0, name: ${JSON.stringify(nameFor(path))}, packageName: "p", defaultTag: "node" }`;
  if (path.endsWith(".json")) {
    return JSON.stringify({
      descriptorVersion: 0,
      name: nameFor(path),
      packageName: "p",
      defaultTag: "node",
    });
  }
  if (/\.m[jt]s$/.test(path)) return `export default ${descriptor};`;
  return `module.exports = ${descriptor};`;
}

// One child process per runtime and mode runs every case, each in its own
// directory. "native": the files exist before the process starts; it records
// the runtime's own resolution, then the loader's. "fresh": the specifier
// misses first, then the files are written and the loader runs again.
const childScript = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const [loaderPath, planPath, mode] = process.argv.slice(2);
const { loadTargetDescriptor } = await import(loaderPath);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const write = (root, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
};
const load = (spec, app) => {
  try {
    return loadTargetDescriptor(spec, app).name;
  } catch (e) {
    return "ERR:" + (e.code ?? e.name) + ":" + e.message;
  }
};
const out = {};
for (const { name, root, spec, files } of plan) {
  const app = join(root, "app");
  if (mode === "native") {
    let runtime;
    try {
      runtime = createRequire(join(app, "package.json")).resolve(spec).slice(root.length + 1);
    } catch (e) {
      runtime = "ERR:" + (e.code ?? e.name);
    }
    out[name] = { runtime, loader: load(spec, app) };
  } else {
    const before = load(spec, app);
    write(root, files);
    out[name] = { before, loader: load(spec, app) };
  }
}
console.log(JSON.stringify(out));
`;

type Native = Record<string, { runtime: string; loader: string }>;
type Fresh = Record<string, { before: string; loader: string }>;

const base = realpathSync(mkdtempSync(join(tmpdir(), "mx-fresh-resolve-")));
const results: Record<string, { native: Native; fresh: Fresh }> = {};

function prepare(runtime: string, mode: "native" | "fresh") {
  const dir = join(base, `${runtime}-${mode}`);
  const plan = Object.entries(cases).map(([name, c], i) => {
    const root = join(dir, String(i));
    const files: Record<string, string> = {};
    for (const [rel, text] of Object.entries(c.files)) {
      files[rel] = rel.endsWith("package.json")
        ? text.replaceAll("$ROOT", root)
        : text === ""
          ? moduleText(rel)
          : text;
    }
    // The project and a node_modules (Bun keeps a miss once it has one).
    const skeleton = {
      "app/package.json": files["app/package.json"] ?? "{}",
      "app/node_modules/.bin/.keep": "",
    };
    writeFiles(root, skeleton);
    if (mode === "native") writeFiles(root, files);
    return { name, root, spec: c.spec ?? "@fake/p", files };
  });
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan));
  writeFileSync(join(dir, "probe.mjs"), childScript);
  const out = spawnSync(
    runtime,
    [join(dir, "probe.mjs"), loader, planPath, mode],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (out.status !== 0) throw new Error(`${runtime} ${mode}: ${out.stderr}`);
  return JSON.parse(out.stdout.trim().split("\n").pop() as string);
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

beforeAll(() => {
  for (const runtime of ["bun", "node"]) {
    results[runtime] = {
      native: prepare(runtime, "native"),
      fresh: prepare(runtime, "fresh"),
    };
  }
}, 120_000);

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe.each(["bun", "node"] as const)(
  "fresh resolution matches %s's own resolver",
  (runtime) => {
    it.each(Object.keys(cases))("%s", (name) => {
      const { native, fresh } = results[runtime] as {
        native: Native;
        fresh: Fresh;
      };
      const { runtime: truth, loader } = native[name] as Native[string];
      const loaded = pathOf(loader);
      const { before, loader: freshLoader } = fresh[name] as Fresh[string];
      const after = { before, loader: pathOf(freshLoader) };
      const pinned = cases[name]?.expect?.[runtime];
      if (pinned !== undefined) {
        expect(
          truth.startsWith("ERR") ? "ERR" : truth,
          "the runtime itself",
        ).toBe(pinned);
      }
      // The miss came first, so the specifier was not there yet.
      expect(after.before).toMatch(/^ERR:/);
      if (truth.startsWith("ERR")) {
        expect(loaded, "loader, no miss first").toMatch(
          /^ERR:(not-found|load-failed):/,
        );
        expect(after.loader, "loader, after a miss").toMatch(
          /^ERR:(not-found|load-failed):/,
        );
        expect(after.loader.split(":")[1]).toBe(loaded.split(":")[1]);
      } else {
        expect(loaded, "loader, no miss first").toBe(truth);
        expect(after.loader, "loader, after a miss").toBe(truth);
      }
    });
  },
);
