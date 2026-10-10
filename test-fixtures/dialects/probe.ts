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
    manifest?: Partial<typeof PROBE_MANIFEST> | null;
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
