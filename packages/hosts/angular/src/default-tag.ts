/**
 * The Angular paths that scan for themselves (`build()`, the virtual tag
 * reader the editor and the checker use) read `mx.angular-template.defaultTag`
 * (decision 145) through core's shared check over this host's own lookup and
 * the file's scanned tags. A rejected value is dropped, the built-in answers,
 * and the diagnostic goes to the caller's own channel.
 */
import {
  type ContractDefaultTagInput,
  type CustomTag,
  createTranslator,
  ownDefaultTag,
  type TargetLookup,
  type TargetPolicyDiagnostic,
} from "@mxlang/core";
import { angularDeclarations, DEFAULT_TAG } from "./emitter.ts";

export function angularDefaultTag(
  file: string,
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  targets: TargetLookup,
  report: (diagnostic: TargetPolicyDiagnostic) => void,
  tags?: ContractDefaultTagInput["tags"],
): string | undefined {
  return ownDefaultTag(file, {
    target: "angular-template",
    ...(tags ? { tags } : {}),
    hostName: "angular",
    ...(customTags ? { customTags } : {}),
    translator: createTranslator({
      taglibs: [],
      tagDiscoveryDirs: [],
      targets,
    }),
    declarations: angularDeclarations,
    builtins: [DEFAULT_TAG],
    report,
  });
}
