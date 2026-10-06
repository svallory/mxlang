import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A faithful Mesh-style third-party host (decision 148), written as a package
 * into a temp project: `@fake/mx-mesh`, selected by `"mx": { "host":
 * "@fake/mx-mesh" }`, descriptor `mesh-data` with host `mesh`, built on the
 * data target. It reuses data's declarations, `defaultTag` and `parseTranslator`
 * and compiles through data's own compile, recording each call. The data
 * descriptor is handed over on `globalThis` because the package sits in a temp
 * project that cannot resolve `@mxlang/data`; `setupMesh` sets the handoff and
 * `teardownMesh` clears it.
 */
export interface MeshOptions {
  /** `host.fileKinds`: plain data, it goes through JSON. */
  fileKinds?: { segment: string; diagnosticSource: string }[];
  /** `host.defaultTag`, the host's override on the 145 ladder. */
  hostDefaultTag?: string;
  /** The descriptor's own `defaultTag`; default data's. */
  defaultTag?: string;
  /**
   * Leave `builtOn` off: a host that reuses data's declarations without
   * declaring it is built on data (no base-target checks apply).
   */
  notBuiltOnData?: boolean;
  /** `builtOn` in place of `"data"` (a wrong name, a loop). */
  builtOn?: string;
  /** The host's own rule: its compile throws an error at column 0 of every line containing this text. */
  hostRule?: string;
  /** Set `allowContractDefaultTag: false` on the declarations. */
  forbidContractDefaultTag?: boolean;
  /** `mx` keys of the project's `package.json` besides `host`. */
  mx?: Record<string, unknown>;
  /** Extra files of the project, by relative path. */
  files?: Record<string, string>;
}

export interface MeshGlobals {
  __mxDataDescriptor?: object;
  __mxMeshOptions?: MeshOptions;
  /** Every file the host compiled. */
  __mxMeshCompiles?: string[];
  /** The `defaultTag` option each compile received. */
  __mxMeshDefaultTags?: (string | undefined)[];
  /** The directory the last `meshProject` made. */
  __mxMeshProjectDir?: string;
}

const MESH_INDEX = `const data = globalThis.__mxDataDescriptor;
const o = globalThis.__mxMeshOptions ?? {};
module.exports = {
  descriptorVersion: 0,
  name: "mesh-data",
  packageName: "@fake/mx-mesh",
  defaultTag: o.defaultTag ?? data.defaultTag,
  ...(o.notBuiltOnData ? {} : { builtOn: o.builtOn ?? "data" }),
  declarations: o.forbidContractDefaultTag
    ? { default: { ...data.declarations.default, allowContractDefaultTag: false } }
    : data.declarations,
  get parseTranslator() { return data.parseTranslator; },
  host: {
    name: "mesh",
    ...(o.hostDefaultTag === undefined ? {} : { defaultTag: o.hostDefaultTag }),
    ...(o.fileKinds === undefined ? {} : { fileKinds: o.fileKinds }),
  },
  load(core) {
    const compiler = data.load(core);
    return {
      compileModule(source, filename, options) {
        globalThis.__mxMeshCompiles.push(filename);
        globalThis.__mxMeshDefaultTags.push(options.defaultTag);
        if (o.hostRule !== undefined) {
          // One error per line that breaks the rule, thrown as one compile
          // error carrying them all (decision 162's \`errors\`).
          const errors = source
            .split("\\n")
            .flatMap((text, i) =>
              text.includes(o.hostRule)
                ? [new core.TranslateError("mesh rule: " + o.hostRule + " is not allowed", i + 1, 0)]
                : [],
            );
          if (errors.length > 0) {
            if (errors.length > 1) errors[0].errors = errors;
            throw errors[0];
          }
        }
        return compiler.compileModule(source, filename, options);
      },
    };
  },
};
`;

const projects: string[] = [];

/** Hands the data descriptor over and resets the recordings; call before `meshProject`. */
export function setupMesh(
  data: object | undefined,
  options: MeshOptions = {},
): void {
  if (!data) throw new Error("missing data descriptor");
  const globals = globalThis as MeshGlobals;
  globals.__mxDataDescriptor = data;
  globals.__mxMeshOptions = options;
  globals.__mxMeshCompiles = [];
  globals.__mxMeshDefaultTags = [];
}

/** Clears the handoff and removes every project `meshProject` made. */
export function teardownMesh(): void {
  const globals = globalThis as MeshGlobals;
  delete globals.__mxDataDescriptor;
  delete globals.__mxMeshOptions;
  delete globals.__mxMeshCompiles;
  delete globals.__mxMeshDefaultTags;
  delete globals.__mxMeshProjectDir;
  for (const dir of projects.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

/** A project that selects the mesh host, with the package installed. Returns its directory. */
export function meshProject(prefix: string, options: MeshOptions = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  projects.push(dir);
  (globalThis as MeshGlobals).__mxMeshProjectDir = dir;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "@fake/mx-mesh", ...options.mx } }, null, 2),
  );
  const pkg = join(dir, "node_modules", "@fake", "mx-mesh");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@fake/mx-mesh",
      version: "1.0.0",
      main: "index.cjs",
    }),
  );
  writeFileSync(join(pkg, "index.cjs"), MESH_INDEX);
  for (const [name, text] of Object.entries(options.files ?? {})) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
