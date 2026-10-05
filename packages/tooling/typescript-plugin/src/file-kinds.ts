import type { HostFileKind } from "@mxlang/core";
import {
  type BuiltinFileKind,
  builtinFileKinds,
  builtinLookup,
  builtinTargets,
} from "@mxlang/target-registry";

/** The built-in glue selects pipelines, never host or segment names. */
export function fileKindForPipeline(
  pipeline: BuiltinFileKind["pipeline"],
): BuiltinFileKind {
  const kind = builtinFileKinds.find((entry) => entry.pipeline === pipeline);
  if (!kind) throw new Error(`missing built-in file pipeline: ${pipeline}`);
  return kind;
}

/** Plugin recognition has always been case-insensitive. */
export function fileKindOf(fileName: string): BuiltinFileKind | undefined {
  return builtinFileKinds.find((kind) =>
    fileName.toLowerCase().endsWith(`.${kind.segment}.mx`),
  );
}

/** Discovery follows the target owning the file kind, not the page policy. */
export function fileKindHostFilter(kind: HostFileKind): string | null {
  const target = builtinTargets.find((target) =>
    target.host?.fileKinds?.some((entry) => entry.segment === kind.segment),
  );
  return target ? (builtinLookup().hostFilterKey(target.name) ?? null) : null;
}
