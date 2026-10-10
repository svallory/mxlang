/**
 * What the paths that discover tags for themselves (`loadMx`, `mx` with a
 * `filename`, nested tags, the Bun loader, `example.ts`) do with the
 * package's `mx.html.defaultTag` (decision 145): core's shared check over
 * this target's own lookup and the file's scanned tags, the value returned or
 * dropped with one warning at its `package.json` position. The registry runs
 * the same check for the tools that reach it; this package cannot (the
 * registry depends on it).
 */
import {
  type ContractDefaultTagInput,
  type CustomTag,
  ownDefaultTag,
  type TargetLookup,
} from "@mxlang/core";
import { createHtmlTranslator } from "./compiler.ts";
import { DEFAULT_TAG, policy } from "./translate.ts";

const reported = new Set<string>();

/** For tests: forget which invalid values were already warned about. */
export function resetReportedDefaultTags(): void {
  reported.clear();
}

/** `package.json#mx.html.defaultTag` for the package that holds `file`, when usable. */
export function configuredDefaultTag(
  file: string,
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  targets: TargetLookup,
  tags?: ContractDefaultTagInput["tags"],
): string | undefined {
  return ownDefaultTag(file, {
    target: "html",
    ...(tags ? { tags } : {}),
    ...(customTags ? { customTags } : {}),
    translator: createHtmlTranslator(targets),
    declarations: policy,
    builtins: [DEFAULT_TAG],
    report: (diagnostic) => {
      const key = `${diagnostic.file}\0${diagnostic.line}\0${diagnostic.message}`;
      if (reported.has(key)) return;
      reported.add(key);
      console.warn(
        `@mxlang/target-html: ${diagnostic.file}:${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`,
      );
    },
  });
}
