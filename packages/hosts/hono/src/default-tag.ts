/**
 * The Bun loader's read of `mx.hono-jsx.defaultTag` (decision 145): core's
 * shared check over this host's lookup (the JSX hosts share Preact's
 * translator) and the file's scanned tags. A rejected value is dropped, the
 * built-in answers, and one warning names the `package.json` position.
 */
import {
  type ContractDefaultTagInput,
  type CustomTag,
  ownDefaultTag,
  type TargetPolicyDiagnostic,
} from "@mxlang/core";
import { translator } from "@mxlang/host-preact";
import { DEFAULT_TAG } from "@mxlang/host-preact/emitter";
import { honoDeclarations } from "./dialect.ts";

export function honoDefaultTag(
  file: string,
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  report: (diagnostic: TargetPolicyDiagnostic) => void,
  tags?: ContractDefaultTagInput["tags"],
): string | undefined {
  return ownDefaultTag(file, {
    target: "hono-jsx",
    ...(tags ? { tags } : {}),
    hostName: "hono",
    ...(customTags ? { customTags } : {}),
    translator,
    declarations: honoDeclarations,
    builtins: [DEFAULT_TAG],
    report,
  });
}
