import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scanCached } from "@mxlang/core";
import { type AngularConfig, readAngularConfig } from "./config.ts";
import { angularDefaultTag } from "./default-tag.ts";
import { isInside } from "./discover.ts";
import { hasGeneratedHeader } from "./header.ts";
import { angularOwnTargets } from "./own-targets.ts";
import {
  type CompileTagModuleOptions,
  type CompileTagModuleResult,
  compileTagModule,
} from "./tag-module.ts";

/**
 * Tooling-only options for the unstable virtual tag reader.
 * @internal
 */
export interface VirtualTagModuleOptions extends CompileTagModuleOptions {
  /** The editor's unsaved source, if it holds this tag. */
  readSource?: (filename: string) => string | undefined;
}

/**
 * Read the component modules `mx-angular build` would generate, without writing
 * them. Only discovered tag templates belong here; pages and ordinary TS files
 * must keep their existing tooling routes. Create a reader per check so disk
 * edits cannot leave a stale module in an incremental Angular program.
 *
 * Tooling-only and unstable.
 * @internal
 */
export function createVirtualTagModuleReader(
  projectDir: string,
  options: VirtualTagModuleOptions = {},
): (filename: string, source?: string) => CompileTagModuleResult | undefined {
  const project = resolve(projectDir);
  let config: AngularConfig | undefined;
  const compiled = new Map<
    string,
    {
      source: string;
      defaultTag: string | undefined;
      result: CompileTagModuleResult;
    }
  >();
  const reported = new Set<string>();
  const targets = options.targets ?? angularOwnTargets;

  return (filename, source) => {
    if (!filename.endsWith(".mx") && !filename.endsWith(".ts"))
      return undefined;
    const path = resolve(filename);
    if (!isInside(project, path) || !existsSync(join(project, "package.json")))
      return undefined;
    config ??= readAngularConfig(project);
    const template = path.endsWith(".mx")
      ? path
      : path.endsWith(config.tagExtension)
        ? `${path.slice(0, -config.tagExtension.length)}.mx`
        : undefined;
    if (!template || !existsSync(template)) return undefined;
    const root = realpathSync(project);
    // Match the build's containment and nested-package boundaries. Probe only
    // the requested source, not every directory in the project on each compile.
    if (!isInside(root, realpathSync(template))) return undefined;
    const scan = scanCached(template, { host: "angular", targets });
    if (!scan.packageFiles.some((file) => realpathSync(dirname(file)) === root))
      return undefined;
    if (
      ![...scan.tags.values()].some(
        (tag) => tag.template && resolve(tag.template) === template,
      )
    )
      return undefined;
    // A real authored TS sibling wins; only MX-generated artifacts may be
    // refreshed from source, just like the build's overwrite guard.
    if (
      path !== template &&
      existsSync(path) &&
      !hasGeneratedHeader(readFileSync(path, "utf8"))
    )
      return undefined;
    const text =
      source ??
      options.readSource?.(template) ??
      readFileSync(template, "utf8");
    const customTags = options.customTags ?? scan.customTags;
    // The package's validated `defaultTag`, as `build()` reads it, so the
    // editor and the checker see the tree the build emits. It is part of the
    // cache entry: an edited config must not serve the old module.
    const defaultTag =
      options.defaultTag ??
      angularDefaultTag(
        template,
        customTags,
        targets,
        (diagnostic) => {
          const key = `${diagnostic.file}\0${diagnostic.line}\0${diagnostic.message}`;
          if (reported.has(key)) return;
          reported.add(key);
          options.warnings?.push({
            file: diagnostic.file,
            line: diagnostic.line,
            column: diagnostic.column,
            message: diagnostic.message,
          });
        },
        scan.tags,
      );
    const previous = compiled.get(template);
    if (previous?.source === text && previous.defaultTag === defaultTag)
      return previous.result;
    const result = compileTagModule(text, template, {
      ...options,
      targets,
      ...(defaultTag === undefined ? {} : { defaultTag }),
      // The build's customTagsFor uses this same per-file cached scan. In
      // particular, nested calls must not fall through to native elements.
      customTags,
      tagSelectorPrefix: options.tagSelectorPrefix ?? config.tagSelectorPrefix,
      // The caller owns warning delivery. Never log while resolving a module.
      warnings: options.warnings ?? [],
    });
    compiled.set(template, { source: text, defaultTag, result });
    return result;
  };
}
