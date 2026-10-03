import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { discoverProjectTags, type TargetLookup } from "@mxlang/core";
import { readAngularConfig } from "./config.ts";
import { isInside } from "./discover.ts";
import { hasGeneratedHeader } from "./header.ts";
import { angularOwnTargets } from "./own-targets.ts";
import {
  type CompileTagModuleOptions,
  type CompileTagModuleResult,
  compileTagModule,
} from "./tag-module.ts";

export interface VirtualTagModuleOptions extends CompileTagModuleOptions {
  /** The editor's unsaved source, if it holds this tag. */
  readSource?: (filename: string) => string | undefined;
}

/**
 * Read the component modules `mx-angular build` would generate, without writing
 * them. Only discovered tag templates belong here; pages and ordinary TS files
 * must keep their existing tooling routes. Create a reader per check so disk
 * edits cannot leave a stale module in an incremental Angular program.
 */
export function createVirtualTagModuleReader(
  projectDir: string,
  options: VirtualTagModuleOptions = {},
): (filename: string, source?: string) => CompileTagModuleResult | undefined {
  let sources: Map<string, string> | undefined;
  let prefix: string;
  const compiled = new Map<
    string,
    { source: string; result: CompileTagModuleResult }
  >();
  const targets: TargetLookup = options.targets ?? angularOwnTargets;

  function index(): Map<string, string> {
    if (sources) return sources;
    const indexed = new Map<string, string>();
    const discovered = discoverProjectTags(projectDir, {
      host: "angular",
      targets,
    });
    if (![...discovered.tags.values()].some((tag) => tag.template)) {
      sources = indexed;
      return sources;
    }
    const root = realpathSync(projectDir);
    const config = readAngularConfig(projectDir);
    prefix = config.tagSelectorPrefix;
    for (const tag of discovered.tags.values()) {
      if (!tag.template) continue;
      const filename = resolve(tag.template);
      // Match the build's containment rule, including symlink escapes.
      if (!isInside(root, realpathSync(filename))) continue;
      indexed.set(filename, filename);
      indexed.set(
        filename.slice(0, -".mx".length) + config.tagExtension,
        filename,
      );
    }
    sources = indexed;
    return sources;
  }

  return (filename, source) => {
    if (!filename.endsWith(".mx") && !filename.endsWith(".ts"))
      return undefined;
    const template = index().get(resolve(filename));
    if (!template) return undefined;
    // A real authored TS sibling wins; only MX-generated artifacts may be
    // refreshed from source, just like the build's overwrite guard.
    if (
      resolve(filename) !== template &&
      existsSync(filename) &&
      !hasGeneratedHeader(readFileSync(filename, "utf8"))
    )
      return undefined;
    const text =
      source ??
      options.readSource?.(template) ??
      readFileSync(template, "utf8");
    const previous = compiled.get(template);
    if (previous?.source === text) return previous.result;
    const result = compileTagModule(text, template, {
      ...options,
      targets,
      tagSelectorPrefix: options.tagSelectorPrefix ?? prefix,
      // The caller owns warning delivery. Never log while resolving a module.
      warnings: options.warnings ?? [],
    });
    compiled.set(template, { source: text, result });
    return result;
  };
}
