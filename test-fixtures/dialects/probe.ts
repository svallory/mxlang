import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A throwaway project that is itself a dialect package, `probe`: a project's
 * own `package.json#mx.dialect` is a declaration like any dependency's, so no
 * `node_modules` is needed. The dialect claims `.probe` and `.probe.mx`, parses
 * under `tagRules: "none"` (Mesh's rules: `<input>` is no void element), and
 * has one trigger, `!word`, that lowers to an attribute, except `!bad`, which
 * fails with the code `PROBE_BAD`.
 *
 * Shared by the tooling tests of dialect files (`mx-tsc`, the language
 * server, the TypeScript plugin, the Vite plugin).
 */

/** The text of `dialect.cjs`: a CommonJS module whose default export is the dialect. */
export const PROBE_DIALECT_MODULE = `module.exports.default = {
  tagRules: "none",
  table: {
    attributeTriggers: [
      { id: "probe", chars: "!", match: "![a-z]+", standIn: "keep", node: { call: "probe" } },
    ],
  },
  lowerTrigger(id, text, span, ctx) {
    if (text === "!bad") return ctx.fail("bad probe", { code: "PROBE_BAD" });
    return ctx.attribute("a", true);
  },
};
`;

/**
 * {@link PROBE_DIALECT_MODULE} plus a fixable error: `!fix` fails with
 * `PROBE_FIXABLE` and carries one quick fix, "Replace with `!ok`", whose edit
 * is the trigger's own text. A hook attaches `fixes` to the error it throws
 * (UTF-16 offsets into the file, `end` exclusive), as core does for its own.
 */
export const PROBE_FIX_DIALECT_MODULE = `module.exports.default = {
  tagRules: "none",
  table: {
    attributeTriggers: [
      { id: "probe", chars: "!", match: "![a-z]+", standIn: "keep", node: { call: "probe" } },
    ],
  },
  lowerTrigger(id, text, span, ctx) {
    if (text !== "!fix") return ctx.attribute("a", true);
    try {
      ctx.fail("fixable probe", { code: "PROBE_FIXABLE" });
    } catch (error) {
      error.fixes = [
        {
          title: "Replace with \`!ok\`",
          edits: [{ offset: span.sourceStart, end: span.sourceStart + text.length, newText: "!ok" }],
        },
      ];
      throw error;
    }
  },
};
`;

/** The source {@link PROBE_FIX_DIALECT_MODULE} fails on: `!fix` at offset 3, 4 characters. */
export const PROBE_FIX_SOURCE = "<y !fix/>\n";

/** The dialect's manifest: its identity and the extensions it claims. */
export const PROBE_MANIFEST = {
  id: "probe",
  name: "Probe",
  extensions: [".probe", ".probe.mx"],
  module: "./dialect.cjs",
};

/** Sources the dialect accepts and rejects, and what it reports for them. */
export const PROBE_SOURCES = {
  /** Valid under the dialect. */
  ok: "<y !ok/>\n",
  /** The trigger fails: `bad probe`, code `PROBE_BAD`, at line 1 column 3. */
  bad: "<y !bad/>\n",
  /**
   * `<input>` unclosed: an error under `tagRules: "none"` (`Missing ending
   * "input" tag`, line 1 column 0), valid HTML.
   */
  noRules: "<input>\n",
} as const;

/**
 * `contracts.cjs`: one contract, `<service>` with a required string `value`.
 * A project that lists it under `mx.contracts` (the `contracts` option of
 * {@link probeProject}) makes `<service/>` a contract violation.
 */
export const PROBE_CONTRACTS_MODULE = `module.exports = { default: { service: { attributes: { value: { type: "string", required: true } } } } };
`;

/** What the contract above reports for a `<service/>` that omits `value`. */
export const PROBE_CONTRACT_MESSAGE =
  "`<service>`: missing required attribute `value`";

/**
 * The probe dialect with tag discovery: it discovers tag files (`concepts/`, `kinds/`, extension
 * `.thing.probe`) and derives a contract from each with a `tagFile` hook:
 * the hook lowers the tag file under its own scan and forwards what it
 * finds, and adds `KIT_BAD` (2:4) to a file that says `BAD`.
 */
export const PROBE_TAG_HOOK_MODULE = `module.exports.default = {
  tagRules: "none",
  table: {},
  tagFile(file, ctx) {
    // The objects \`ctx.lower\` returned, as they are: core keeps their codes and ends.
    const diagnostics = [...ctx.lower().diagnostics];
    if (file.source.includes("BAD")) {
      diagnostics.push({ severity: "error", message: "bad concept", line: 2, column: 4, code: "KIT_BAD" });
    }
    return { contract: {}, diagnostics };
  },
};
`;

/**
 * {@link PROBE_TAG_HOOK_MODULE}, for the tests of a tag file's range: the hook
 * returns the diagnostics of \`ctx.lower\` as they are, so core keeps each one's
 * range end (a copy would lose both its \`MX_\` code and its end).
 */
export const PROBE_TAG_HOOK_END_MODULE = PROBE_TAG_HOOK_MODULE;

/**
 * The probe dialect whose `tagFile` hook reads `money.json` beside the tag
 * file, names it with `ctx.dependsOn`, and reports `bad money.json` (1:2,
 * `KIT_BAD`) when it says BAD. A `.json` file is no file any watcher glob
 * names, which is the point.
 */
export const PROBE_DEPENDS_ON_HOOK_MODULE = `const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
module.exports.default = {
  tagRules: "none",
  table: {},
  tagFile(file, ctx) {
    ctx.dependsOn("money.json");
    const data = readFileSync(join(dirname(file.path), "money.json"), "utf8");
    const diagnostics = data.includes("BAD")
      ? [{ severity: "error", message: "bad money.json", line: 1, column: 2, code: "KIT_BAD" }]
      : [];
    return { contract: {}, diagnostics };
  },
};
`;

/**
 * A dialect whose `tagFile` hook names the file its tag file's text asks for:
 * `dep=<path>` anywhere in the tag file, relative to the tag file's
 * directory. A tag file with no `dep=` names nothing.
 */
export const PROBE_DEPENDS_ON_NAMED_HOOK_MODULE = `module.exports.default = {
  tagRules: "none",
  table: {},
  tagFile(file, ctx) {
    const named = /dep=([^\\s>]+)/.exec(file.source);
    if (named) ctx.dependsOn(named[1]);
    return { contract: {}, diagnostics: [] };
  },
};
`;

export const PROBE_TAG_DIALECT = {
  tagDirs: ["concepts", "kinds"],
  tagExtensions: [".thing.probe"],
};

export function tagDiscoveryProject(
  files: Record<string, string> = {},
): ProbeProject {
  return probeProject(
    { "dialect.cjs": PROBE_TAG_HOOK_MODULE, ...files },
    { manifest: PROBE_TAG_DIALECT },
  );
}

const roots: string[] = [];

export interface ProbeProject {
  /** The project directory, real path. */
  dir: string;
  /** Absolute path of `relative` inside the project. */
  path(relative: string): string;
}

/**
 * Writes the project under a fresh temp directory. `files` are relative paths
 * to texts; `package.json` and `dialect.cjs` are written unless given.
 * `manifest` changes the dialect's declaration (`null` writes a project that
 * declares no dialect). `packageJson` keys replace the generated ones.
 */
export function probeProject(
  files: Record<string, string> = {},
  options: {
    manifest?:
      | (Partial<typeof PROBE_MANIFEST> & Record<string, unknown>)
      | null;
    packageJson?: Record<string, unknown>;
    /** Lists `contracts.cjs` under `mx.contracts`. */
    contracts?: boolean;
  } = {},
): ProbeProject {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-probe-dialect-")));
  roots.push(dir);
  const manifest =
    options.manifest === null
      ? undefined
      : { ...PROBE_MANIFEST, ...options.manifest };
  const all: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "probe-dialect",
      ...(manifest || options.contracts
        ? {
            mx: {
              ...(manifest ? { dialect: manifest } : {}),
              ...(options.contracts ? { contracts: "./contracts.cjs" } : {}),
            },
          }
        : {}),
      ...options.packageJson,
    }),
    ...(manifest ? { "dialect.cjs": PROBE_DIALECT_MODULE } : {}),
    ...(options.contracts ? { "contracts.cjs": PROBE_CONTRACTS_MODULE } : {}),
    ...files,
  };
  for (const [relative, text] of Object.entries(all)) {
    const file = join(dir, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { dir, path: (relative) => join(dir, relative) };
}

/** Removes every project {@link probeProject} made. */
export function cleanupProbeProjects(): void {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
