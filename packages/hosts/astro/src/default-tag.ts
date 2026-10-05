/**
 * The `.astro.mx` Vite plugin's read of `mx.astro-html.defaultTag` (decision
 * 145): core's shared check over html's lookup (the Astro template lowers
 * under html's tables) and the file's scanned tags. A rejected value is
 * dropped, the built-in answers, and one warning names the `package.json`
 * position. This plugin cannot reach the registry (it depends on this
 * package), so it runs the check itself.
 */
import {
  type CustomTag,
  ownDefaultTag,
  type TargetPolicyDiagnostic,
} from "@mxlang/core";
import htmlDescriptor from "@mxlang/html/descriptor";
import { DEFAULT_TAG } from "./astro-template.ts";

export function astroDefaultTag(
  file: string,
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  report: (diagnostic: TargetPolicyDiagnostic) => void,
): string | undefined {
  return ownDefaultTag(file, {
    target: "astro-html",
    ...(customTags ? { customTags } : {}),
    translator: htmlDescriptor.translator,
    // The target is astro-html, whose declarations are html's: what is an
    // element there is what Marko's lookup flags, not the template's casing rule.
    declarations: htmlDescriptor.declarations?.default,
    builtins: [DEFAULT_TAG],
    report,
  });
}
