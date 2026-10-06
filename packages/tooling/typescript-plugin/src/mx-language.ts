import { dirname } from "node:path";
import { createVirtualTagModuleReader } from "@mxlang/angular";
import * as core from "@mxlang/core";
import {
  type CustomTag,
  dropOwnParserPosition,
  type Expr,
  type GeneratedMapping,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type Lookup,
  lower,
  type MxWarning,
  newCtx,
  parseFragment,
  printExpression,
  type TargetLookup,
  type TargetPolicy,
  type TargetPolicyDiagnostic,
} from "@mxlang/core";
import {
  builtinFileKinds,
  builtinLookup,
  builtinTargets,
  defaultTagFor,
  getCustomTags,
  lookupFor,
  scanCached,
} from "@mxlang/target-registry";
import type { CodeMapping, VirtualCode } from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";
import { markoAuthoredSpans } from "./authored-spans.ts";
import { failedModuleStub } from "./failed-module-stub.ts";
import { fileKindOf } from "./file-kinds.ts";
import {
  createTargetPolicyRecorder,
  LOAD_FAILURE_CODES,
} from "./host-policy-diagnostics.ts";
import {
  codeInformation,
  compileWithDependencies,
  type DependencyLanguagePluginOptions,
  decodeMappings,
  diagnosticsFrom,
  foreignTemplateError,
  type MxCompileDiagnostic,
  type MxDiagnosticLanguagePlugin,
  mergeMappings,
  nearestPackageDir,
  warningDiagnostic,
} from "./language.ts";
import { dropOwnLocationHeader } from "./own-location-header.ts";
import type {
  AuthoredSpan,
  SpannedVirtualCode,
} from "./unmapped-diagnostics.ts";

/** Thrown inside the compile to skip it when the policy's target failed to load. */
class TargetNotLoaded extends Error {}

export const MX_LANGUAGE_ID = "mx";
export const MX_EXTENSIONS = ["mx"] as const;

export interface MxSyntaxError {
  fileName: string;
  message: string;
  offset: number;
  source: string;
}

export interface MxLanguagePlugin extends MxDiagnosticLanguagePlugin {
  getSyntaxError(fileName: string): MxSyntaxError | undefined;
  /**
   * What resolving the host of each `.mx` file this plugin compiled had to say
   * (an unknown `mx.host`, a malformed `package.json`), as
   * `resolveTargetPolicyDetailed` reported it. Kept per plugin instance, never
   * process-global: tsserver hosts several projects per process, and each
   * has its own plugin. One file's entries are replaced whenever it is
   * compiled again, so a fixed `package.json` stops being reported.
   */
  getTargetPolicyDiagnostics(fileName?: string): TargetPolicyDiagnostic[];
}

export interface MxLanguagePluginOptions
  extends DependencyLanguagePluginOptions {
  /**
   * Custom tags supplied directly, merged over whatever the scan discovers
   * for each file.
   *
   * Discovery is per file and needs no configuration (spec §4), which is what
   * lets `mx-tsc` and the tsserver plugin construct this plugin identically
   * and still resolve the tags each file can actually call — neither has a
   * tag map to hand over at construction time, and a project's tags are a
   * property of its directories rather than of its tooling.
   */
  customTags?: Record<string, CustomTag>;
}

export function createMxLanguagePlugin(
  typescript: typeof ts,
  options: MxLanguagePluginOptions = {},
): MxLanguagePlugin {
  const syntaxErrors = new Map<string, MxSyntaxError>();
  const compileDiagnostics = new Map<string, MxCompileDiagnostic[]>();
  const dependencies = new Map<string, string[]>();
  const hostPolicies = createTargetPolicyRecorder();
  const resolveHost = (fileName: string) => hostPolicies.resolve(fileName);

  /**
   * The tags callable from one file: everything discovered around it, with an
   * explicitly supplied definition winning over a discovered one of the same
   * name. Returns `undefined` when there are none, so a project using no
   * custom tags registers no taglib at all.
   */
  /**
   * Scan diagnostics already warned about, so an editor re-checking a file on
   * every keystroke does not repeat one misconfigured `package.json` forever.
   */
  const reported = new Set<string>();

  const tagsFor = (
    fileName: string,
    policy: TargetPolicy,
  ): Record<string, CustomTag> | undefined => {
    // A misconfigured `mx.tags` is not fatal — the local `tags/` directories
    // still resolve — but silence is worse than a warning here: a tag simply
    // fails to resolve with nothing saying why. There is no diagnostic
    // channel for a problem in a *different* file than the one being checked,
    // so this goes to the log, which is tsserver's own log in an editor and
    // stderr under `mx-tsc`.
    // The filter value `mx.tags[].hosts` is matched against: the target's own
    // host name, or a hostless target's legacy `mx.host` value (`html`),
    // which is what every existing `hosts: ["html"]` entry matches.
    // `lookupFor` adds a descriptor a package specifier loaded (§4.2), so a
    // third-party host's name is a valid filter value here too.
    const targets = lookupFor(policy);
    const host = targets.hostFilterKey(policy.target) ?? null;
    for (const diagnostic of scanCached(fileName, { host, targets })
      .diagnostics) {
      const key = `${diagnostic.file}\u0000${diagnostic.message}`;
      if (reported.has(key)) continue;
      reported.add(key);
      console.warn(
        `@mxlang/typescript-plugin: ${diagnostic.file}: ${diagnostic.message}`,
      );
    }

    const discovered = getCustomTags(fileName, { host, targets });
    const merged = options.customTags
      ? { ...discovered, ...options.customTags }
      : discovered;
    return Object.keys(merged).length > 0 ? merged : undefined;
  };

  return {
    getLanguageId(fileName) {
      return isMx(fileName) ? MX_LANGUAGE_ID : undefined;
    },

    createVirtualCode(fileName, languageId, snapshot) {
      if (languageId !== MX_LANGUAGE_ID && !isMx(fileName)) return undefined;

      const source = snapshot.getText(0, snapshot.getLength());
      hostPolicies.source(fileName, source);
      let tagsUsed: Record<string, CustomTag> | undefined;
      try {
        const result = compileWithDependencies(
          options.readSource,
          dependencies.get(fileName) ?? [],
          () => {
            const hostPolicy = resolveHost(fileName);
            // The target failed to load and the page sits under the fallback
            // target. Its verdict on a page written for another target would
            // bury the real error (§4.1): compile nothing, point at the policy.
            if (
              hostPolicies
                .get(fileName)
                .some((diagnostic) => LOAD_FAILURE_CODES.has(diagnostic.code))
            ) {
              throw new TargetNotLoaded();
            }
            const customTags = tagsFor(fileName, hostPolicy);
            tagsUsed = customTags;
            // Reuse discovery's policy resolution: resolving it again would
            // repeat deprecation warnings on unchanged non-Angular files.
            // Tag projection belongs to the target's registered template
            // pipeline, not a host-name comparison. Pages still hit pending.
            const descriptor = lookupFor(hostPolicy).target(hostPolicy.target);
            const hasTagPipeline = descriptor?.host?.fileKinds?.some((kind) =>
              builtinFileKinds.some(
                (builtin) =>
                  builtin.segment === kind.segment &&
                  builtin.pipeline === "ng-template",
              ),
            );
            const tag = hasTagPipeline
              ? compileAngularTagVirtual(fileName, source, customTags)
              : undefined;
            return tag ?? compileMxVirtual(fileName, source, customTags);
          },
        );
        const { generated, mappings, warnings } = result;
        dependencies.set(fileName, result.dependencies);
        syntaxErrors.delete(fileName);
        compileDiagnostics.set(
          fileName,
          warnings.map((warning) =>
            warningDiagnostic(fileName, source, warning),
          ),
        );
        return createVirtualCode(
          typescript,
          generated,
          mappings,
          result.angularTag,
          () => markoAuthoredSpans(source, fileName, tagsUsed),
        );
      } catch (cause) {
        if (cause instanceof TargetNotLoaded) {
          // Only the `target not loaded` pointer (`getCompileDiagnostics`) and
          // an inert module remain.
          syntaxErrors.delete(fileName);
          compileDiagnostics.set(fileName, []);
          return createVirtualCode(
            typescript,
            failedModuleStub(typescript, source),
            [],
          );
        }
        const foreign = foreignTemplateError(
          cause,
          fileName,
          source,
          options.readSource,
        );
        if (foreign) {
          syntaxErrors.delete(fileName);
          // See `ForeignTemplateError`'s doc comment (`language.ts`) for the
          // map-clobber caveat this write is subject to.
          compileDiagnostics.set(foreign.templateFileName, [
            foreign.templateDiagnostic,
          ]);
          compileDiagnostics.set(fileName, [foreign.callerDiagnostic]);
          return createVirtualCode(
            typescript,
            failedModuleStub(typescript, source),
            [],
          );
        }
        const error = toSyntaxError(fileName, source, cause);
        syntaxErrors.set(fileName, error);
        compileDiagnostics.set(fileName, [{ ...error, category: "error" }]);
        return createVirtualCode(
          typescript,
          failedModuleStub(typescript, source),
          [],
        );
      }
    },

    getSyntaxError(fileName) {
      return syntaxErrors.get(fileName);
    },

    getTargetPolicyDiagnostics(fileName) {
      return hostPolicies.get(fileName);
    },

    getCompileDiagnostics(fileName) {
      return [
        ...diagnosticsFrom(compileDiagnostics, fileName),
        ...hostPolicies.errors(fileName),
      ];
    },

    typescript: {
      resolveHiddenExtensions: true,
      extraFileExtensions: MX_EXTENSIONS.map((extension) => ({
        extension,
        isMixedContent: false,
        scriptKind: typescript.ScriptKind.TSX,
      })),
      getServiceScript(root) {
        if (root.id === "angular-tag") {
          return {
            code: root,
            extension: ".ts",
            scriptKind: typescript.ScriptKind.TS,
          };
        }
        // TSX, not TS, and for every other host: the Preact host emits a component
        // module whose body is JSX, and parsed as plain TS its `return (<>…)`
        // is a syntax error — which surfaced as the module having no exports
        // at all ("File '…/Counter.mx' is not a module"), not as a parse
        // error anyone could read. TSX is a superset for the other hosts'
        // JSX-free output, with one narrowing that does not reach it: `<T>x`
        // as a type assertion, which no host emits (they emit `x as T`).
        return {
          code: root,
          extension: ".tsx",
          scriptKind: typescript.ScriptKind.TSX,
          // Deliberately no `preventLeadingOffset`. A compiled `.mx` module
          // does not preserve the source's line structure (the `escape` import
          // and the hoisted statements move), and with that flag set Volar's
          // `runTsc` parses its `SourceFile` from the generated text alone —
          // so `tsc` turns a correctly mapped source *offset* into line/column
          // using the generated file's line table, reporting every `.mx`
          // diagnostic on the wrong line. Unset, Volar pads the virtual
          // contents to the source's own lines and the offsets agree.
        };
      },
    },
  };

  // Tag modules are already a build-supported output kind. Present only those
  // as TypeScript; leave page dispatch (including Angular's pending guard) alone.
  function compileAngularTagVirtual(
    fileName: string,
    source: string,
    customTags: Record<string, CustomTag> | undefined,
  ) {
    const projectDir = nearestPackageDir(dirname(fileName));
    if (!projectDir) return undefined;
    const result = createVirtualTagModuleReader(projectDir, {
      customTags,
      targets: builtinLookup(),
      ...(options.readSource ? { readSource: options.readSource } : {}),
    })(fileName, source);
    if (!result) return undefined;
    return {
      generated: result.code,
      mappings: result.mappings.map(
        (mapping): CodeMapping => ({
          sourceOffsets: [mapping.sourceStart],
          generatedOffsets: [mapping.generatedStart],
          lengths: [mapping.sourceEnd - mapping.sourceStart],
          generatedLengths: [mapping.generatedEnd - mapping.generatedStart],
          data: codeInformation,
        }),
      ),
      dependencies: result.dependencies,
      warnings: result.warnings,
      angularTag: true,
    };
  }

  function compileMxVirtual(
    fileName: string,
    source: string,
    customTags: Record<string, CustomTag> | undefined,
  ): {
    generated: string;
    mappings: CodeMapping[];
    dependencies: string[];
    warnings: MxWarning[];
    angularTag?: boolean;
  } {
    const hostPolicy = resolveHost(fileName);
    const targets = lookupFor(hostPolicy);
    const descriptor = targets.target(hostPolicy.target);
    const load = descriptor?.load;
    if (!load) {
      const identity = descriptor?.host
        ? `${descriptor.host.name} host`
        : `${hostPolicy.target} target`;
      throw new Error(
        `the ${identity} is not wired into @mxlang/typescript-plugin yet${descriptor?.pending ? ` (${descriptor.pending})` : ""}`,
      );
    }
    const strict = descriptor.strict === "always" || hostPolicy.strict === true;
    const warnings: MxWarning[] = [];
    // Every compile carries the built-in lookup: core asks it which packages
    // export `AttrTag` and which file-kind segments exist, and the answer must
    // be the whole registered set, not one target's own descriptor, or a
    // callee importing `AttrTag` from another registered target's package
    // would stop being recognised.
    const defaultTag = defaultTagFor(fileName, hostPolicy);
    const compiled = load(core).compileModule(source, fileName, {
      strict,
      customTags,
      defaultTag,
      warnings,
      typeCheck: true,
      targets,
    });
    const generated = descriptor.typeSurface?.(compiled.code) ?? compiled.code;
    // A loaded descriptor with no `declarations` has no lowering policy of its
    // own: html's second lowering would judge its pages under html's rules and
    // fail on what the target accepts. It maps from what it recorded.
    const recordedOnly =
      descriptor.mappings === "merge-recorded" ||
      (hostPolicy.descriptor !== undefined && !descriptor.declarations);
    const mappings = recordedOnly
      ? mergeMappings(
          [
            ...(compiled.map
              ? decodeMappings(compiled.map, generated, source)
              : []),
            ...recordedMappings(compiled.mappings ?? []),
          ].sort(
            (left, right) =>
              (left.generatedOffsets[0] ?? 0) -
              (right.generatedOffsets[0] ?? 0),
          ),
        )
      : createHtmlMappings(
          source,
          fileName,
          generated,
          strict,
          (strict ? descriptor.declarations?.strict : undefined) ??
            descriptor.declarations?.default,
          compiled.mappings,
          customTags,
          // The mapping pass lowers the same source a second time. It
          // needs somewhere to put its warnings, but they are the ones the
          // compile already reported, so they are not reported again.
          [],
          targets,
          defaultTag,
        );
    // What the host's own compiler stage adds that the type-check cannot see
    // (Solid: imports for its auto-imported built-ins). Any file kind of the
    // target that declares it; appended at the end, so no mapped offset moves.
    const complete = descriptor.host?.fileKinds?.find(
      (kind) => kind.completeTypecheckModule,
    )?.completeTypecheckModule;
    const completed = complete?.(generated);
    if (completed?.warning) warnings.push(completed.warning);
    return {
      generated: completed?.code ?? generated,
      mappings,
      dependencies: compiled.dependencies,
      warnings,
    };
  }
}

/**
 * Astro passes template children as JSX's `children` attribute, then the MX
 * renderer turns that slot into `input.content` at runtime. Present that call
 * shape to TypeScript without changing the compiled function body.
 *
 * `children` is offered only to a component whose `Input` actually declares
 * `content`. A component with no content slot accepts no slot content at
 * runtime, so bolting `children?: unknown` onto it would let
 * `<Card>anything</Card>` type-check against a component that silently drops
 * it. The choice is made by a conditional type rather than by inspecting the
 * emitted interface text, so it stays correct however the author formatted
 * their `Input` — and `Omit` still removes `content` itself, which is the
 * renderer's own parameter name and never something an Astro caller passes.
 */
export function createAstroTypeSurface(code: string): string {
  // Compatibility export; the owning pipeline's target now supplies it.
  const kind = builtinFileKinds.find(
    (kind) => kind.pipeline === "astro-template",
  );
  const descriptor = builtinTargets.find((target) =>
    target.host?.fileKinds?.some((entry) => entry.segment === kind?.segment),
  );
  return descriptor?.typeSurface?.(code) ?? code;
}

function createVirtualCode(
  typescript: typeof ts,
  generated: string,
  mappings: CodeMapping[],
  angularTag = false,
  authoredSpans?: () => AuthoredSpan[],
): SpannedVirtualCode {
  return {
    ...(authoredSpans ? { authoredSpans } : {}),
    id: angularTag ? "angular-tag" : "root",
    languageId: "typescript",
    snapshot: typescript.ScriptSnapshot.fromString(generated),
    mappings,
    embeddedCodes: [],
  };
}

/**
 * The whole-file compilers currently return an empty placeholder source map.
 * Build the mappings from the same positioned IR expressions their emitters
 * consume: every expression carries its original Babel node (and exact `loc`)
 * plus the source text emitted into the TypeScript module.
 *
 * `declarations` selects the host to lower under, because a construct one
 * host accepts another rejects — resolving a Preact template under the HTML
 * policy would throw on the first `<try>` and yield no mappings at all.
 */
export function createHtmlMappings(
  source: string,
  fileName: string,
  generated: string,
  strict: boolean,
  declarations?: HostDeclarations,
  emittedMappings: readonly GeneratedMapping[] = [],
  customTags?: Record<string, CustomTag>,
  warnings?: MxWarning[],
  targets: TargetLookup = builtinLookup(),
  defaultTag?: string,
): CodeMapping[] {
  const compiler = core.markoCompiler();
  const { body } = parseFragment(source, {
    filename: fileName,
    customTags,
  });
  // D3: the mapping pass still uses the default HTML target's translator,
  // even when the compile target is JSX. Do not change this disagreement.
  const fallback = builtinLookup().target(builtinLookup().defaultTarget());
  const mappingDeclarations =
    declarations ??
    (strict ? fallback?.declarations?.strict : undefined) ??
    fallback?.declarations?.default;
  if (!mappingDeclarations) throw new Error("missing mapping declarations");
  const ctx = newCtx(
    source,
    printExpression,
    mappingDeclarations,
    compiler.taglib.buildLookup(dirname(fileName), fallback?.translator),
    fileName,
    targets,
  );
  // This is the second lowering of the same source. It must see the same tag
  // map as compilation or a custom tag can make the entire mapping pass fail.
  ctx.customTags = customTags;
  if (defaultTag !== undefined) ctx.defaultTag = defaultTag;
  ctx.warnings = warnings;
  const ir = lower(ctx, body);
  const mappedCode = collectMappedCode(ir);
  const sourceLines = lineOffsets(source);
  const mappings: CodeMapping[] = recordedMappings(emittedMappings);
  let generatedCursor = 0;
  const generatedCodeCursors = new Map<string, number>();

  for (const item of mappedCode) {
    const sourceRange = locateSourceCode(item, source, sourceLines);
    if (!sourceRange || item.code.length === 0) continue;

    const searchFrom = Math.max(
      generatedCursor,
      generatedCodeCursors.get(item.code) ?? 0,
    );
    const generatedOffset = generated.indexOf(item.code, searchFrom);
    if (generatedOffset < 0) continue;
    generatedCursor = generatedOffset + item.code.length;
    generatedCodeCursors.set(item.code, generatedCursor);
    mappings.push({
      sourceOffsets: [sourceRange.offset],
      generatedOffsets: [generatedOffset],
      lengths: [sourceRange.length],
      ...(sourceRange.length === item.code.length
        ? {}
        : { generatedLengths: [item.code.length] }),
      data: codeInformation,
    });
  }

  return mergeMappings(
    mappings.sort(
      (left, right) =>
        (left.generatedOffsets[0] ?? 0) - (right.generatedOffsets[0] ?? 0),
    ),
  );
}

function recordedMappings(
  mappings: readonly GeneratedMapping[],
): CodeMapping[] {
  return mappings
    .filter(
      (mapping) =>
        mapping.sourceEnd > mapping.sourceStart &&
        mapping.generatedEnd > mapping.generatedStart,
    )
    .map((mapping) => {
      const sourceLength = mapping.sourceEnd - mapping.sourceStart;
      const generatedLength = mapping.generatedEnd - mapping.generatedStart;
      return {
        sourceOffsets: [mapping.sourceStart],
        generatedOffsets: [mapping.generatedStart],
        lengths: [sourceLength],
        ...(sourceLength === generatedLength
          ? {}
          : { generatedLengths: [generatedLength] }),
        data: codeInformation,
      };
    });
}

type PositionedCode =
  | Expr
  | Extract<
      IrNode,
      {
        kind: "Static" | "Import" | "Export" | "InputInterface" | "Hoisted";
      }
    >;

function collectMappedCode(ir: Ir): PositionedCode[] {
  const mapped: PositionedCode[] = [];
  const seen = new Set<object>();

  function visit(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (isExpression(value)) {
      mapped.push(value);
      return;
    }
    if (isPositionedCode(value)) {
      mapped.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "node") visit(child);
    }
  }

  visit(ir);
  return mapped;
}

function isExpression(value: unknown): value is Expr {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Expr>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.shape === "string" &&
    !!candidate.node
  );
}

function isPositionedCode(
  value: unknown,
): value is Exclude<PositionedCode, Expr> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Exclude<PositionedCode, Expr>>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.kind === "string" &&
    ["Static", "Import", "Export", "InputInterface", "Hoisted"].includes(
      candidate.kind,
    ) &&
    !!candidate.loc &&
    !!candidate.end
  );
}

/**
 * Whether a lowered item came from a file other than the one being mapped.
 *
 * The third position rule (spec §2): material inlined from a tag template
 * carries that template's own line and column, tagged with its file. This
 * virtual code's `source` *is* the caller, so a template-originated span has
 * nothing here to map to — its offsets index a different file's text.
 *
 * **Decision: drop it cleanly.** Volar's `CodeMapping` addresses exactly one
 * source, so representing a second file would mean a second `VirtualCode` per
 * template per caller, which is P3 scope this task does not carry. Mapping it
 * anyway is the option that must not be taken: the offsets would land on
 * whatever the caller happens to have at those numbers, so a diagnostic about
 * `tags/icon.mx` would be underlined on an unrelated line of the caller —
 * worse than no mapping, which merely means the diagnostic is not surfaced
 * against this file. The template's own diagnostics reach the author through
 * the language server, which reports them against the template's own URI.
 *
 * **This check is defensive, not load-bearing, and that was measured.** Two
 * existing mechanisms already reject a template-originated span today: the
 * text comparison below (a template offset rarely indexes identical text in
 * the caller), and `generatedCodeCursors`, which gives each distinct code
 * string one forward cursor, so a second identical occurrence — which is
 * exactly what an expansion of the same expression produces — finds no
 * remaining position and is skipped. Disabling this check leaves the tests in
 * `index.test.ts` green.
 *
 * It is kept because both of those hold for reasons unrelated to files: they
 * are about text and about order, and neither would notice a template whose
 * span happened to line up. Relying on them would make correctness here a
 * property of two unrelated heuristics agreeing, which is the kind of guard
 * that stops holding silently when either is tuned.
 */
function isForeignFile(item: PositionedCode): boolean {
  if (isExpression(item)) return typeof item.file === "string";
  return typeof item.loc.file === "string";
}

function locateSourceCode(
  item: PositionedCode,
  source: string,
  sourceLines: number[],
): { offset: number; length: number } | undefined {
  if (isForeignFile(item)) return undefined;
  if (isExpression(item)) {
    const loc = item.node?.loc;
    if (!loc?.start || !loc.end) return undefined;
    const offset = offsetAt(sourceLines, source.length, loc.start);
    const end = offsetAt(sourceLines, source.length, loc.end);
    return source.slice(offset, end) === item.code
      ? { offset, length: item.code.length }
      : undefined;
  }

  const blockStart = offsetAt(sourceLines, source.length, item.loc);
  const blockEnd = offsetAt(sourceLines, source.length, item.end);
  const withinBlock = source.slice(blockStart, blockEnd).indexOf(item.code);
  if (withinBlock >= 0) {
    return { offset: blockStart + withinBlock, length: item.code.length };
  }

  // A host hook may synthesize a hoisted declaration from a source tag. Map
  // the generated declaration as one block to the producing tag's full span;
  // this is deliberately approximate, but keeps its diagnostics visible.
  if (item.kind === "Hoisted" && blockEnd > blockStart) {
    return { offset: blockStart, length: blockEnd - blockStart };
  }
  return undefined;
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let offset = 0; offset < text.length; offset++) {
    if (text.charCodeAt(offset) === 10) offsets.push(offset + 1);
  }
  return offsets;
}

function offsetAt(
  offsets: number[],
  sourceLength: number,
  position: { line: number; column: number },
): number {
  return Math.min(
    sourceLength,
    (offsets[Math.max(0, position.line - 1)] ?? sourceLength) +
      Math.max(0, position.column),
  );
}

function isMx(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (fileKindOf(fileName)) {
    return false;
  }
  return MX_EXTENSIONS.some((extension) => lower.endsWith(`.${extension}`));
}

function toSyntaxError(
  fileName: string,
  source: string,
  cause: unknown,
): MxSyntaxError {
  const error = cause as {
    message?: string;
    line?: number;
    column?: number;
    loc?: {
      line?: number;
      column?: number;
      start?: { line?: number; column?: number };
    };
  };
  const line = Math.max(
    1,
    error.line ?? error.loc?.line ?? error.loc?.start?.line ?? 1,
  );
  const column = Math.max(
    0,
    error.column ?? error.loc?.column ?? error.loc?.start?.column ?? 0,
  );
  const offset = (lineOffsets(source)[line - 1] ?? source.length) + column;
  const message = dropOwnLocationHeader(
    error.message ?? "Invalid MX source.",
    fileName,
  );
  return {
    fileName,
    // Babel's `(L:C)` is dropped only when it repeats this position.
    message: dropOwnParserPosition(cause, message),
    offset: Math.min(source.length, offset),
    source,
  };
}
