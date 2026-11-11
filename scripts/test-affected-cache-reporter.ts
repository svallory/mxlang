/**
 * Vitest reporter that switches on the selection cache for one
 * `vitest related` run (see test-affected-cache.ts). `onInit` fires before
 * Vitest selects the tests, `onTestRunStart` after, which is where the native
 * transforms are put back. Anything unexpected leaves selection native.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
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

/**
 * Content hash of the config file and every file it imports (vite's
 * `configFileDependencies`): a plugin factory or option closure defined there
 * shows no text in the plugin object. A file that cannot be read is recorded
 * as such, which still changes the key when it appears or disappears.
 */
function configFiles(
  c: Record<string, unknown>,
  root: string,
): Record<string, string> {
  const files = [
    c.configFile,
    ...((c.configFileDependencies as string[] | undefined) ?? []),
  ].filter((f): f is string => typeof f === "string");
  const out: Record<string, string> = {};
  for (const f of [...new Set(files)].sort()) {
    try {
      out[relative(root, f)] = createHash("sha256")
        .update(readFileSync(f))
        .digest("hex");
    } catch {
      out[relative(root, f)] = "unreadable";
    }
  }
  return out;
}

/** The settings of a project that steer module resolution and transforms. */
function projectInput(p: VitestProject): ProjectInput {
  const c = p.vite.config;
  const plugins = (c.plugins as { name?: string }[] | undefined) ?? [];
  return {
    name: p.name,
    root: p.config.root,
    plugins: plugins.map((pl) => pl.name ?? ""),
    origins: plugins.map((pl) => pluginOrigin(pl)),
    config: {
      configFiles: configFiles(c, p.config.root),
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
      const inputs = (this.options.inputs ?? defaultInputs)(
        root,
        ctx.projects.map(projectInput),
      );
      const dir =
        this.options.dir ??
        resolve(root, "node_modules", ".cache", "mx-affected");
      this.installed = install(
        ctx.projects.map((p) => ({
          name: p.name,
          vitenode: p.vitenode,
          input: projectInput(p),
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
