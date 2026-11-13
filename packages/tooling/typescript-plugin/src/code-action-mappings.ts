import {
  type CodeInformation,
  isCodeActionsEnabled,
  type Language,
} from "@volar/language-core";
import { getMappingOffset } from "@volar/typescript/lib/node/transform";
import { getServiceScript } from "@volar/typescript/lib/node/utils";
import type * as ts from "typescript";

/**
 * A TypeScript code action (a code fix, a refactor, organize imports) whose
 * edit lands on a verification-only mapping makes no edit.
 *
 * The pinned Volar (2.4.28) maps a code action's text changes through any
 * mapping whose `CodeInformation` enables code actions, and
 * `isCodeActionsEnabled(info)` is `!!info.verification`. A mapping that carries
 * `verification` and nothing else exists so a diagnostic is reported on an
 * authored span the generated text is not (the html body's `content` key on
 * the tag name, an attribute tag's property, a fallback span, an approximation
 * overlay). An edit Volar maps through one rewrites authored text the edit
 * does not describe, so an action with such a change makes none. This runs
 * beneath Volar's proxy, on the generated-coordinate results, repeating
 * Volar's own lookup (`transformFileTextChanges` → `transformSpan` →
 * `transformTextSpan`: the first range `toSourceRange` yields).
 */

/** `verification` is the mapping's only truthy `CodeInformation` key. */
export function isVerificationOnly(data: CodeInformation): boolean {
  let verification = false;
  for (const [key, value] of Object.entries(data)) {
    if (!value) continue;
    if (key !== "verification") return false;
    verification = true;
  }
  return verification;
}

/**
 * Whether Volar would map any of `changes` through a verification-only
 * mapping: for each text change of a file with a service script, the first
 * range `toSourceRange` yields under Volar's code-action filter, over the same
 * maps `transformSpan` walks (every source of the service script). A change no
 * mapping takes is Volar's to drop, as today.
 */
export function landsOnVerificationOnly(
  language: Language<string>,
  changes: readonly ts.FileTextChanges[],
): boolean {
  for (const fileChanges of changes) {
    const [serviceScript] = getServiceScript(language, fileChanges.fileName);
    if (!serviceScript) continue;
    const offset = getMappingOffset(language, serviceScript);
    for (const change of fileChanges.textChanges) {
      const start = change.span.start - offset;
      const end = start + change.span.length;
      for (const [, map] of language.maps.forEach(serviceScript.code)) {
        const first = map
          .toSourceRange(start, end, false, isCodeActionsEnabled)
          .next();
        if (first.done) continue;
        // Without `fallbackToAnyMatch`, one mapping takes both ends.
        if (isVerificationOnly(first.value[2].data)) return true;
        break;
      }
    }
  }
  return false;
}

/**
 * Wraps the code actions of the service Volar is about to proxy whose text
 * changes Volar maps under its code-action filter: `getCodeFixesAtPosition`,
 * `getCombinedCodeFix`, `getEditsForRefactor` and `organizeImports`. A fix with
 * any change on a verification-only mapping is dropped; a combined fix with
 * one keeps its other fields and no changes (a fix-all is one action, so a
 * partial one could leave the file half-edited). A refactor with one is
 * `undefined`, as tsserver answers a refactor with no edits: its
 * `renameLocation` and `commands` would otherwise follow an edit that never
 * happened. Organize imports with one returns no changes, being one whole-file
 * action too.
 */
export function dropVerificationOnlyCodeActions(
  service: ts.LanguageService,
  getLanguage: () => Language<string> | undefined,
): void {
  const codeFixesAtPosition = service.getCodeFixesAtPosition.bind(service);
  service.getCodeFixesAtPosition = (...args) => {
    const fixes = codeFixesAtPosition(...args);
    const language = getLanguage();
    if (!language) return fixes;
    return fixes.filter(
      (fix) => !landsOnVerificationOnly(language, fix.changes),
    );
  };
  const combinedCodeFix = service.getCombinedCodeFix.bind(service);
  service.getCombinedCodeFix = (...args) => {
    const combined = combinedCodeFix(...args);
    const language = getLanguage();
    if (!language || !landsOnVerificationOnly(language, combined.changes)) {
      return combined;
    }
    return { ...combined, changes: [] };
  };
  const editsForRefactor = service.getEditsForRefactor.bind(service);
  service.getEditsForRefactor = (...args) => {
    const refactor = editsForRefactor(...args);
    const language = getLanguage();
    if (
      !refactor ||
      !language ||
      !landsOnVerificationOnly(language, refactor.edits)
    ) {
      return refactor;
    }
    return undefined;
  };
  const organizeImports = service.organizeImports.bind(service);
  service.organizeImports = (...args) => {
    const changes = organizeImports(...args);
    const language = getLanguage();
    if (!language || !landsOnVerificationOnly(language, changes)) {
      return changes;
    }
    return [];
  };
}
