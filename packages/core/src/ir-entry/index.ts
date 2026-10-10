/**
 * The IR entry point (decision 204): parse, lower, check and return core's
 * IR, for a consumer that interprets the tree itself (a dialect such as
 * Mesh) rather than emitting a host's code. Replaces `@mxlang/data`'s
 * `parseData`: with `tagRules: "none"`, every diagnostic it reported is
 * reported at the same text and position (the default `html` rules reject
 * files `parseData` accepted, such as `<input><child/></input>`).
 *
 * An error means `ir: undefined` (no partial IR) and every independent error
 * the source has, each positioned, earliest first: every parse error (the
 * parser recovers and reports several), and, once the source lowers, every
 * check reject, structural hit and unknown tag (`checks.ts`). Lowering stops
 * at its first error by design, so a lowering error (`parents`/`children`, a
 * bad attribute) is the one error of its kind; under `unknownTags: "reject"`
 * the source's unknown tags are still listed beside it. No input makes
 * `lowerSource` throw: an error with no position (a bug in core) is reported
 * at 1:0 with an `internal error: ` prefix, and a user-facing one that has
 * none with `unpositioned error: `. Warnings are collected and returned
 * alongside the IR.
 *
 * @unstable
 */

import { readFileSync } from "node:fs";
import { WEB_ELEMENTS } from "@mxlang/web-elements";
import { compileSource } from "../compile.ts";
import { type MxWarning, TranslateError } from "../core.ts";
import type { CustomTag } from "../custom-tags.ts";
import type { HostDeclarations } from "../declarations.ts";
import type { Ir } from "../ir.ts";
import type { Dialect, SyntaxTable } from "../syntax-table.ts";
import {
  type TagRulesPreset,
  taglibsOfRules,
  tagRulesPreset,
} from "../tag-presets.ts";
import { createTargetLookup, type TargetLookup } from "../target-descriptor.ts";
import { scanAuthoredTags } from "./authored-tags.ts";
import { checkIr, labelInside, unknownTagMessage } from "./checks.ts";
import {
  builtinTagNames,
  DEFAULT_TAG,
  entryDeclarations,
} from "./declarations.ts";
import {
  errorDiagnostics,
  flattenErrors,
  type IrDiagnostic,
  lineStartsOf,
  toDiagnostic,
} from "./diagnostics.ts";
import { finishIr, type SpannedIr } from "./spans.ts";

export type { IrDiagnostic } from "./diagnostics.ts";
export type { Spanned, SpannedIr } from "./spans.ts";

/** @unstable */
export interface LowerSourceOptions {
  /** Contract-only custom tags (decision 130), by call name. */
  customTags?: Record<string, CustomTag>;
  /**
   * The dialect, or a bare syntax table (decision 182 addendum 5), for a
   * consumer that builds its own (Mesh passes its dialect, hooks included);
   * omitted, the dialect the file's extension routes to (decision 212). A
   * trigger, block tag or filter nothing lowers (a `{ call }` trigger with
   * no `lowerTrigger`) is a positioned diagnostic ("`<id>` trigger has no
   * lowering yet").
   */
  dialect?: SyntaxTable | Dialect;
  /**
   * The tag rules preset the source parses under (decision 204; ruling 209:
   * an option of this function only, never a project or host setting).
   * `"html"` (default, decision 212 item 8: a dialect that states no tag
   * rules gets the full HTML rules): the web elements' parse rules (void, raw
   * text, preserved whitespace) and core's whole taglib. `"markup"`: the same
   * parse rules with core's statement tags only. `"none"` (Mesh's): no native
   * element rules, so `script`, `input` or `title` is an ordinary tag whose
   * body parses as markup.
   */
  tagRules?: TagRulesPreset;
  /**
   * What the unnamed tag (`<#id>`, `<.class>`) stands for in place of the
   * built-in `object` (decision 145), already validated.
   */
  defaultTag?: string;
  /**
   * `"pass"` (default) keeps the structural constructs — text, `${}`,
   * `<if>`/`<for>`/`<const>`, `import`/`export`/`static` — in the IR for the
   * consumer to interpret. Comments are never structural: under either value
   * a `//` line or `<!-- -->` stays in the IR as its `Comment` node
   * (decision 131 addendum 5). `"reject"` makes each structural construct a
   * positioned error ("the data tree is static; this file's consumer does
   * not evaluate `<if>`"), for a consumer that wants tags and attributes
   * only and must not silently ignore an `<if>` it never reads. A
   * structural hit and a check error are ordered by position.
   */
  structural?: "pass" | "reject";
  /**
   * Whether a top-level `import` passes. Defaults to the effective
   * `structural` value. `"pass"` with `structural: "reject"` keeps control
   * flow, `export` and `static` rejected and returns the imports in
   * `ir.imports`. `"reject"` with `structural: "pass"` rejects only the
   * `import`s.
   */
  imports?: "pass" | "reject";
  /**
   * `"allow"` (default) keeps the open set of decision 131: a tag with no
   * entry in `customTags` is accepted. `"reject"` closes it: any tag, at any
   * depth, whose name has no entry in `customTags` (and is not the built-in
   * `object`) is a positioned error naming the tag, with a
   * nearest-declared-name hint when one is close. An unknown parent is
   * reported before its children's `parents`/`children` errors, and the
   * errors inside an unknown tag are labelled, never dropped (decision 161).
   */
  unknownTags?: "allow" | "reject";
  /**
   * A sink for core's warnings: they are pushed here as they are raised, so
   * those raised before a later error stay in the caller's array.
   * `diagnostics` still reports this call's warnings (not entries already in
   * the array) when the source lowers.
   */
  warnings?: MxWarning[];
}

/** @unstable */
export interface LowerSourceResult {
  /**
   * Absent when `diagnostics` holds an error: no partial IR. A private copy,
   * spans guaranteed (`SpannedIr`); `DelegatedTag.args` is always present
   * (`[]` without arguments).
   */
  ir: SpannedIr | undefined;
  diagnostics: IrDiagnostic[];
}

const lookups = new WeakMap<HostDeclarations, TargetLookup>();

/**
 * The target lookup `compileSource` requires. Core reads two facts from it:
 * which packages export `AttrTag` (this one: core) and a host's module
 * segment (none). One lookup per declarations object.
 */
function lookupFor(declarations: HostDeclarations): TargetLookup {
  let lookup = lookups.get(declarations);
  if (!lookup) {
    lookup = createTargetLookup([
      {
        descriptorVersion: 0,
        name: "ir",
        packageName: "@mxlang/core",
        defaultTag: DEFAULT_TAG,
        declarations: { default: declarations },
      },
    ]);
    lookups.set(declarations, lookup);
  }
  return lookup;
}

/** The names `unknownTags: "reject"` accepts: the built-in `object`, then every `customTags` key. */
function declaredTagNames(
  customTags: Record<string, CustomTag> | undefined,
): Set<string> {
  return new Set([...builtinTagNames(), ...Object.keys(customTags ?? {})]);
}

/**
 * Parses, lowers and checks one source, returning its IR.
 *
 * Never throws: every error the source has is a positioned error diagnostic
 * (see the file header for which are collected together).
 *
 * @unstable
 */
export function lowerSource(
  source: string,
  filename: string,
  options: LowerSourceOptions = {},
): LowerSourceResult {
  const lineStarts = lineStartsOf(source);
  const warnings: MxWarning[] = options.warnings ?? [];
  const firstWarning = warnings.length;
  const failed = (errors: unknown[]): LowerSourceResult => ({
    ir: undefined,
    diagnostics: errorDiagnostics(errors, filename, lineStarts, source),
  });
  let rules: ReturnType<typeof tagRulesPreset>;
  try {
    rules = tagRulesPreset(options.tagRules ?? "html", WEB_ELEMENTS);
  } catch (error) {
    return failed([error]);
  }
  const declarations = entryDeclarations(rules.nativeTags);
  const declared = declaredTagNames(options.customTags);
  let ir: Ir | null = null;
  try {
    compileSource(source, filename, declarations, {
      targets: lookupFor(declarations),
      taglibs: taglibsOfRules(rules),
      statementTags: false,
      customTags: options.customTags,
      defaultTag: options.defaultTag,
      ...(options.dialect !== undefined ? { dialect: options.dialect } : {}),
      warnings,
      emitIr: (lowered) => {
        ir = lowered;
        // The IR, not a module, is the output; `compileSource` requires text
        // back, so the emitted "code" is an unused placeholder.
        return "";
      },
    });
  } catch (error) {
    if (options.unknownTags !== "reject") return failed([error]);
    try {
      const tags = scanAuthoredTags(
        source,
        filename,
        rules,
        options.customTags,
        options.defaultTag ?? DEFAULT_TAG,
        options.dialect,
      );
      const unknown = (tags ?? []).filter((tag) => !declared.has(tag.name));
      const errors = unknown.map(
        (tag) =>
          new TranslateError(
            unknownTagMessage(tag.name, declared),
            tag.line,
            tag.column,
          ),
      );
      const ranges = unknown.map((tag) => ({
        name: tag.name,
        at: { line: tag.line, column: tag.column },
        ...(tag.endLine !== undefined && tag.endColumn !== undefined
          ? { end: { line: tag.endLine, column: tag.endColumn } }
          : {}),
      }));
      return failed(labelInside([...flattenErrors(error), ...errors], ranges));
    } catch (scanError) {
      return failed([error, scanError]);
    }
  }
  if (!ir) {
    return failed([
      new Error("@mxlang/core: lowerSource produced no IR and no error"),
    ]);
  }
  const lowered = ir as Ir;
  // Never throws: the check records every error, even one outside its
  // recovery points, and returns them with the rest.
  const errors = checkIr(lowered, source, {
    structural: options.structural ?? "pass",
    imports: options.imports ?? options.structural ?? "pass",
    unknownTags: options.unknownTags ?? "allow",
    declaredTags: declared,
  });
  if (errors.length > 0) return failed(errors);
  let finished: SpannedIr;
  try {
    finished = finishIr(lowered, source);
  } catch (error) {
    return failed([error]);
  }
  return {
    ir: finished,
    diagnostics: warnings
      .slice(firstWarning)
      .map((warning) =>
        toDiagnostic(
          "warning",
          warning.message,
          warning,
          undefined,
          lineStarts,
          source,
          filename,
        ),
      ),
  };
}

/**
 * `lowerSource` over a file on disk. Reading the file is the caller's
 * concern: a file that cannot be read throws, as `readFileSync` does.
 *
 * @unstable
 */
export function lowerFile(
  path: string,
  options: LowerSourceOptions = {},
): LowerSourceResult {
  return lowerSource(readFileSync(path, "utf8"), path, options);
}
