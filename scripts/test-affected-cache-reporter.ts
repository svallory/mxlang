/**
 * Vitest reporter that switches on the selection cache for one
 * `vitest related` run (see test-affected-cache.ts). `onInit` fires before
 * Vitest selects the tests, `onTestRunStart` after, which is where the native
 * transforms are put back. Anything unexpected leaves selection native.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  cacheMode,
  collectInputs,
  type Installed,
  install,
  type ProjectInput,
  type ProjectLike,
} from "./test-affected-cache.ts";

interface VitestProject {
  name: string;
  config: { root: string; server?: unknown; alias?: unknown };
  vite: { config: Record<string, unknown> };
  vitenode: ProjectLike["vitenode"];
}

interface VitestCtx {
  config: { root: string };
  projects: VitestProject[];
}

/** The settings of a project that steer module resolution and transforms. */
export function projectInput(p: VitestProject): ProjectInput {
  const c = p.vite.config;
  return {
    name: p.name,
    root: p.config.root,
    plugins: ((c.plugins as { name?: string }[] | undefined) ?? []).map(
      (pl) => pl.name ?? "",
    ),
    config: {
      mode: c.mode,
      define: c.define,
      resolve: c.resolve,
      ssr: c.ssr,
      esbuild: c.esbuild,
      server: p.config.server,
      alias: p.config.alias,
    },
  };
}

export default class AffectedCacheReporter {
  private installed: Installed | undefined;
  private start = 0;

  onInit(ctx: VitestCtx): void {
    if (!cacheMode(process.env).on) return;
    try {
      this.start = performance.now();
      const root = ctx.config.root;
      const inputs = collectInputs(
        root,
        ctx.projects.map(projectInput),
        process.env,
        realpathSync(resolve(root, "node_modules", "vitest")),
      );
      const dir =
        process.env.MX_AFFECTED_CACHE_DIR ??
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
        `test:affected cache: native selection (${(e as Error).message})`,
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
    console.log(
      `test:affected cache: selection ${ms} ms, ${s.hits} hits, ${s.misses} misses, ${s.bypassed} bypassed, ${s.unstable} unstable`,
    );
  }
}
