import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fake third-party target packages, one per case, and a helper that installs
 * them into a throwaway project the way a package manager would
 * (`node_modules/@fake/mx-<case>`), so the loader resolves them from the
 * project and nothing else.
 *
 * - `ok`        uses the injected core (OQ10)
 * - `ok-ssr`    a second target of `ok`'s host (`fake-host`)
 * - `file-kinds` declares a whole-file `host.fileKinds` entry (`.fk.mx`)
 * - `join-solid` names the built-in host `solid` (rejected)
 * - `own-core`  imports its own `@mxlang/core` copy (pins the brand check)
 * - `hostless`  valid target with no `host` part (an error under `mx.host`)
 * - `throws`    its module throws on evaluation
 * - `invalid`   exports something that is not a descriptor
 * - `no-default-tag` a valid descriptor without the required `defaultTag`
 * - `host-override` a host overriding `defaultTag`; its compile echoes the one it got
 * - `forbids-contract` a host whose declarations set `allowContractDefaultTag: false`
 * - `forbids-nohost` the same on a target with no host
 * - `permits-host` a host whose declarations permit the rung
 * - `bad-default-tag` a descriptor whose own `defaultTag` is no tag its target has
 * - `version`   exports `descriptorVersion: 1`
 *
 * `missing` has no package: a specifier no project installs.
 */
export type FakeTarget =
  | "ok"
  | "ok-ssr"
  | "file-kinds"
  | "join-solid"
  | "own-core"
  | "hostless"
  | "throws"
  | "invalid"
  | "no-default-tag"
  | "host-override"
  | "bad-default-tag"
  | "forbids-contract"
  | "forbids-nohost"
  | "permits-host"
  | "version";

const here = import.meta.dirname;
const repoCore = join(here, "..", "..", "packages", "core");

const roots: string[] = [];

/** Removes every project made since the last call. Call it from `afterEach`. */
export function cleanupProjects(): void {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
}

export interface FakeProject {
  /** The project directory, which holds the `package.json`. */
  root: string;
  /** Absolute path of a file in the project. */
  path(name: string): string;
  /** The `package.json`. */
  manifest: string;
}

/**
 * A **copy** of core (`package.json` and the built `dist/index.js`) under the
 * project's `node_modules/@mxlang/core`, so its realpath differs from the
 * tool's and `require` gives a second module record, hence a second
 * `TranslateError` class. A symlink would resolve to the very file the tools
 * import and share its classes. Core's own runtime dependencies are linked
 * (they are not what is under test).
 */
function installSecondCore(root: string): void {
  const nm = join(root, "node_modules");
  const copy = join(nm, "@mxlang", "core");
  mkdirSync(join(copy, "dist"), { recursive: true });
  cpSync(join(repoCore, "package.json"), join(copy, "package.json"));
  cpSync(join(repoCore, "dist", "index.js"), join(copy, "dist", "index.js"));
  for (const dep of ["@marko", "@babel", "htmljs-parser"]) {
    symlinkSync(
      realpathSync(join(repoCore, "node_modules", dep)),
      join(nm, dep),
      "dir",
    );
  }
}

/** An empty temp directory that holds several projects (a workspace). */
export function fakeWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-third-party-ws-")));
  roots.push(root);
  return root;
}

/** The specifier a project installing `name` writes under `mx.target`. */
export const specifier = (name: FakeTarget | "missing"): string =>
  `@fake/mx-${name}`;

/**
 * A project with `package.json` `{ mx, dependencies }`, the listed fake targets
 * installed under `node_modules/@fake/`, and extra `files` (`a.mx` by default
 * is not created: pass what the test reads). `ownCore` links the repo's own
 * `@mxlang/core` into the project, which is what `own-core` resolves.
 */
export function fakeProject(options: {
  /** Make the project here (created if missing) instead of in a new temp dir. */
  root?: string;
  mx?: unknown;
  /** Raw manifest text, for malformed or hand-positioned JSON. */
  manifestText?: string;
  install?: readonly FakeTarget[];
  files?: Record<string, string>;
}): FakeProject {
  let root = options.root;
  if (root === undefined) {
    // Real path: macOS reports /var as /private/var, and a resolved file is the real one.
    root = realpathSync(mkdtempSync(join(tmpdir(), "mx-third-party-")));
    roots.push(root);
  } else mkdirSync(root, { recursive: true });
  const manifest = join(root, "package.json");
  writeFileSync(
    manifest,
    options.manifestText ?? JSON.stringify({ mx: options.mx }, null, 2),
  );
  const project: FakeProject = {
    root,
    manifest,
    path: (name) => join(root, name),
  };
  for (const name of options.install ?? []) installFake(project, name);
  for (const [name, text] of Object.entries(options.files ?? {})) {
    writeFileSync(join(root, name), text);
  }
  return project;
}

/** Installs one fake target into an existing project, as a package manager would. */
export function installFake(project: FakeProject, name: FakeTarget): void {
  cpSync(
    join(here, name),
    join(project.root, "node_modules", "@fake", `mx-${name}`),
    { recursive: true },
  );
  if (name === "own-core") installSecondCore(project.root);
}
