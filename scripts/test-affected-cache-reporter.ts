/**
 * Vitest reporter that switches on the selection cache for one
 * `vitest related` run (see test-affected-cache.ts). `onInit` fires before
 * Vitest selects the tests, `onTestRunStart` after, which is where the native
 * transforms are put back. Anything unexpected leaves selection native.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  cacheMode,
  collectInputs,
  type Inputs,
  type Installed,
  install,
  NATIVE_PREFIX,
  type ProjectInput,
  type ProjectLike,
  pluginOrigin,
} from "./test-affected-cache.ts";

interface VitestProject {
  name: string;
  config: {
    root: string;
    server?: unknown;
    alias?: unknown;
    define?: unknown;
    defines?: unknown;
  };
  vite: { config: Record<string, unknown> };
  vitenode: ProjectLike["vitenode"];
}

interface VitestCtx {
  config: { root: string };
  projects: VitestProject[];
}

const BARE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/g;
const MAX_PACKAGE_FILES = 3000;

/** Read once: the content hash and, for source files, the text to scan. */
function readHashed(f: string): { hash: string; text: string } {
  try {
    const buf = readFileSync(f);
    return {
      hash: createHash("sha256").update(buf).digest("hex"),
      text: /\.[cm]?[jt]sx?$/.test(f) ? buf.toString("utf8") : "",
    };
  } catch {
    return { hash: "unreadable", text: "" };
  }
}

/** The package name of a bare specifier (`@scope/name/sub` -> `@scope/name`). */
function packageName(spec: string): string | undefined {
  if (spec.startsWith("node:")) return undefined;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Every file below `dir` except node_modules and .git; undefined when
 * `budget.left` runs out (the budget is shared by every package of a closure).
 */
function packageFiles(
  dir: string,
  budget: { left: number },
): string[] | undefined {
  const out: string[] = [];
  const walk = (d: string): boolean => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const f = join(d, e.name);
      if (e.isDirectory()) {
        if (!walk(f)) return false;
      } else if (e.isFile()) {
        if (budget.left-- <= 0) return false;
        out.push(f);
      }
    }
    return true;
  };
  return walk(dir) ? out.sort() : undefined;
}

/**
 * Content hash of the config file and every file it imports (vite's
 * `configFileDependencies`): a plugin factory or option closure defined there
 * shows no text in the plugin object, nor do the helpers a hook calls. A file
 * that cannot be read is recorded as such, which still changes the key when it
 * appears or disappears.
 *
 * Vite leaves bare imports out of `configFileDependencies`, so a plugin
 * imported from a workspace package (a `node_modules` symlink into the
 * repository) is found here: each bare import whose package resolves, from the
 * importing file, to a directory inside the repository and outside
 * `node_modules` gets every file of that package hashed, and the bare imports
 * of those files are followed the same way (a worklist, so a package a plugin
 * package uses is covered too). The files of all packages together are capped
 * at `maxPackageFiles`; past it the first package that did not fit is returned
 * as `unhashed`, and the project goes native.
 */
export function configFiles(
  c: Record<string, unknown>,
  root: string,
  repoRoot: string,
  maxPackageFiles = MAX_PACKAGE_FILES,
): { files: Record<string, string>; unhashed?: string } {
  const sources = [
    c.configFile,
    ...((c.configFileDependencies as string[] | undefined) ?? []),
  ].filter((f): f is string => typeof f === "string");
  const files: Record<string, string> = {};
  const packages = new Set<string>();
  const queue: { name: string; dir: string }[] = [];
  const budget = { left: maxPackageFiles };

  /** Queue every workspace package the text of `file` imports. */
  const follow = (file: string, text: string) => {
    for (const m of text.matchAll(BARE_IMPORT)) {
      const name = packageName(m[1]);
      if (name === undefined || packages.has(name)) continue;
      // The nearest node_modules/<name> above the importing file.
      for (let d = dirname(file); ; d = dirname(d)) {
        let real: string;
        try {
          real = realpathSync(join(d, "node_modules", name));
        } catch {
          if (d === dirname(d)) break;
          continue;
        }
        const rel = relative(repoRoot, real);
        const inside = !rel.startsWith("..") && !isAbsolute(rel);
        if (inside && !rel.split(sep).includes("node_modules")) {
          packages.add(name);
          queue.push({ name, dir: real });
        }
        break;
      }
    }
  };

  for (const f of [...new Set(sources)].sort()) {
    const r = readHashed(f);
    files[relative(root, f)] = r.hash;
    follow(f, r.text);
  }
  while (queue.length > 0) {
    const { name, dir } = queue.shift() as { name: string; dir: string };
    const list = packageFiles(dir, budget);
    if (list === undefined) return { files, unhashed: name };
    for (const f of list) {
      const r = readHashed(f);
      files[`pkg:${name}/${relative(dir, f)}`] = r.hash;
      follow(f, r.text);
    }
  }
  return { files };
}

/** The settings of a project that steer module resolution and transforms. */
function projectInput(p: VitestProject, repoRoot: string): ProjectInput {
  const c = p.vite.config;
  const cf = configFiles(c, p.config.root, repoRoot);
  const plugins = (c.plugins as { name?: string }[] | undefined) ?? [];
  return {
    name: p.name,
    root: p.config.root,
    plugins: plugins.map((pl) => pl.name ?? ""),
    origins: plugins.map((pl) => pluginOrigin(pl)),
    unhashedPackage: cf.unhashed,
    config: {
      configFiles: cf.files,
      mode: c.mode,
      define: c.define,
      // Vitest moves a project's `define` out of the vite config into its own
      // (the vite one keeps only NODE_ENV), so the vite value alone misses it.
      testDefine: p.config.define,
      // The resolved set: simple defines from a config file land here instead.
      testDefines: p.config.defines,
      resolve: c.resolve,
      ssr: c.ssr,
      esbuild: c.esbuild,
      server: p.config.server,
      alias: p.config.alias,
    },
  };
}

export interface ReporterOptions {
  /** Store root; defaults to `node_modules/.cache/mx-affected` under the root. */
  dir?: string;
  /** Test seam: replaces the namespace inputs gathered from disk. */
  inputs?: (root: string, projects: ProjectInput[]) => Inputs;
}

export default class AffectedCacheReporter {
  private installed: Installed | undefined;
  private start = 0;

  // A plain field, not a parameter property: node strips types only.
  private readonly options: ReporterOptions;

  constructor(options: ReporterOptions = {}) {
    this.options = options;
  }

  onInit(ctx: VitestCtx): void {
    if (!cacheMode(process.env).on) return;
    try {
      this.start = performance.now();
      const root = ctx.config.root;
      const perProject = ctx.projects.map((p) => projectInput(p, root));
      const inputs = (this.options.inputs ?? defaultInputs)(root, perProject);
      const dir =
        this.options.dir ??
        resolve(root, "node_modules", ".cache", "mx-affected");
      this.installed = install(
        ctx.projects.map((p, i) => ({
          name: p.name,
          vitenode: p.vitenode,
          input: perProject[i],
        })),
        inputs,
        dir,
        (m) => console.warn(`test:affected cache: ${m}`),
      );
    } catch (e) {
      console.warn(
        `test:affected cache: ${NATIVE_PREFIX}: ${(e as Error).message}`,
      );
      this.installed?.finish();
      this.installed = undefined;
    }
  }

  onTestRunStart(): void {
    const i = this.installed;
    if (!i) return;
    i.finish();
    const s = i.stats;
    const ms = Math.round(performance.now() - this.start);
    const why = [...s.reasons]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, n]) => `${n}x ${r}`)
      .join("; ");
    console.log(
      `test:affected cache: selection ${ms} ms, ${s.hits} hits, ${s.misses} misses, ${s.bypassed} bypassed, ${s.unstable} unstable${why ? ` (bypassed: ${why})` : ""}`,
    );
  }
}

function defaultInputs(root: string, projects: ProjectInput[]): Inputs {
  return collectInputs(
    root,
    projects,
    process.env,
    realpathSync(resolve(root, "node_modules", "vitest")),
  );
}
