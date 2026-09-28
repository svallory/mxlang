import { readFileSync } from "node:fs";
import { decode } from "@jridgewell/sourcemap-codec";
import {
  type MxWarning,
  reportScanDiagnostics,
  scanCached,
  TranslateError,
  withCalleeInputSources,
} from "@mxlang/core";
import type { MxRegionCompile, RawSourceMap } from "@mxlang/parser";
import { print, SOLID_BUILTIN_TAGS, sourceBindings } from "@mxlang/parser";
import { compileSolidMx } from "@mxlang/solid";
import type {
  CodeInformation,
  CodeMapping,
  LanguagePlugin,
  VirtualCode,
} from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";

/**
 * Adapts `compileSolidMx`'s own `(source, options)` signature to the
 * `MxRegionCompile` shape `print` calls — the parser no longer defaults to
 * this host, so every `.solid.mx` caller supplies it explicitly.
 */
export const solidRegionCompile: MxRegionCompile = ({ source, ...rest }) =>
  compileSolidMx(source, rest);

export const SOLID_MX_EXTENSION = "solid.mx";
export const SOLID_MX_LANGUAGE_ID = "solidmx";

export const codeInformation: CodeInformation = {
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
};

export interface SolidMxSyntaxError {
  fileName: string;
  message: string;
  offset: number;
  source: string;
}

export interface MxCompileDiagnostic extends SolidMxSyntaxError {
  category: "error" | "warning";
}

export interface MxDiagnosticLanguagePlugin extends LanguagePlugin<string> {
  getCompileDiagnostics(fileName?: string): MxCompileDiagnostic[];
}

export interface SolidMxLanguagePlugin extends MxDiagnosticLanguagePlugin {
  getSyntaxError(fileName: string): SolidMxSyntaxError | undefined;
}

/**
 * Reads a file's current text from the editor host: an unsaved buffer when
 * the file is open, `undefined` when the host does not hold it (core then
 * reads the file from disk itself).
 */
export type DependencySourceReader = (fileName: string) => string | undefined;

export interface DependencyLanguagePluginOptions {
  /**
   * How a compile reads the callee files whose `Input` it depends on.
   *
   * Supplied by the tsserver plugin so a caller type-checks against an open
   * callee's unsaved text. `mx-tsc` supplies none: a one-shot run has only
   * the files on disk, which core reads by itself.
   */
  readSource?: DependencySourceReader;
}

export function createSolidMxLanguagePlugin(
  typescript: typeof ts,
  options: DependencyLanguagePluginOptions = {},
): SolidMxLanguagePlugin {
  const syntaxErrors = new Map<string, SolidMxSyntaxError>();
  const compileDiagnostics = new Map<string, MxCompileDiagnostic[]>();
  const dependencies = new Map<string, string[]>();
  const reportedScanDiagnostics = new Set<string>();

  return {
    getLanguageId(fileName) {
      return isSolidMx(fileName) ? SOLID_MX_LANGUAGE_ID : undefined;
    },

    createVirtualCode(fileName, languageId, snapshot) {
      if (languageId !== SOLID_MX_LANGUAGE_ID && !isSolidMx(fileName)) {
        return undefined;
      }

      const source = snapshot.getText(0, snapshot.getLength());
      try {
        // The tags this file can call, discovered the same way every other
        // integration discovers them. Without this the editor would know
        // nothing of a registered tag inside a `.solid.mx` region while a
        // `vite build` of the same file compiled it fine — the gap the P1
        // review recorded against this path.
        //
        // A scan diagnostic (e.g. an unknown `hosts` name) names a
        // *different* file — the `package.json` that declared it — so it
        // cannot become a `MxCompileDiagnostic` positioned in this file;
        // logged the same way `mx-language.ts` already does for this exact
        // case (tsserver's own log in an editor, stderr under `mx-tsc`).
        const scan = scanCached(fileName, { host: "solid" });
        reportScanDiagnostics(scan.diagnostics, reportedScanDiagnostics, (d) =>
          console.warn(`@mxlang/typescript-plugin: ${d.file}: ${d.message}`),
        );
        const discovered = scan.customTags;
        const compiled = compileWithDependencies(
          options.readSource,
          dependencies.get(fileName) ?? [],
          () => {
            const warnings: MxWarning[] = [];
            const printed = print(source, fileName, {
              mxRegionCompile: (input) =>
                compileSolidMx(input.source, { ...input, warnings }),
              ...(Object.keys(discovered).length > 0
                ? { customTags: discovered }
                : undefined),
            });
            return { ...printed, warnings };
          },
        );
        const { warnings, ...printed } = compiled;
        dependencies.set(fileName, printed.dependencies);
        syntaxErrors.delete(fileName);
        const { code: generated, warning: builtinImportWarning } =
          appendSolidBuiltinImport(printed.code);
        const allWarnings = builtinImportWarning
          ? [...warnings, builtinImportWarning]
          : warnings;
        compileDiagnostics.set(
          fileName,
          allWarnings.map((warning) =>
            warningDiagnostic(fileName, source, warning),
          ),
        );
        return createVirtualCode(
          typescript,
          generated,
          source,
          printed.map,
          attributeTagDiagnosticMappings(source, printed.code),
        );
      } catch (cause) {
        const foreign = foreignTemplateError(
          cause,
          fileName,
          source,
          options.readSource,
        );
        if (foreign) {
          syntaxErrors.delete(fileName);
          // See `ForeignTemplateError`'s doc comment above for the
          // map-clobber caveat this write is subject to.
          compileDiagnostics.set(foreign.templateFileName, [
            foreign.templateDiagnostic,
          ]);
          compileDiagnostics.set(fileName, [foreign.callerDiagnostic]);
          return createVirtualCode(typescript, "", source, undefined);
        }
        const error = toSyntaxError(fileName, source, cause);
        syntaxErrors.set(fileName, error);
        compileDiagnostics.set(fileName, [{ ...error, category: "error" }]);
        return createVirtualCode(typescript, "", source, undefined);
      }
    },

    getSyntaxError(fileName) {
      return syntaxErrors.get(fileName);
    },

    getCompileDiagnostics(fileName) {
      return diagnosticsFrom(compileDiagnostics, fileName);
    },

    typescript: {
      resolveHiddenExtensions: true,
      extraFileExtensions: [
        {
          extension: SOLID_MX_EXTENSION,
          isMixedContent: false,
          scriptKind: typescript.ScriptKind.TSX,
        },
      ],
      getServiceScript(root) {
        return {
          code: root,
          extension: ".tsx",
          scriptKind: typescript.ScriptKind.TSX,
          // Deliberately no `preventLeadingOffset`, same reasoning as
          // whole-file `.mx` (see `mx-language.ts`). `print`'s output
          // preserves the region's *line count* but not every line's exact
          // text: an earlier line the printer reformats (e.g. an `Input`
          // interface losing whitespace) shifts every later column while
          // leaving the line number unchanged. With the flag set, Volar's
          // `runTsc` parses its `SourceFile` from the generated text alone,
          // so `tsc` converts a correctly mapped source *offset* into a
          // column against the *generated* line's start instead of the
          // *source* line's start — the two disagree whenever a prior line's
          // length changed (measured: `export const broken` on line 4
          // reported column 17 against a source column of 14, because the
          // printed `Input` interface on line 3 is three characters
          // shorter). Unset, Volar pads the virtual contents with the
          // source's own lines and the offsets agree.
        };
      },
    },
  };
}

export function diagnosticsFrom(
  diagnostics: ReadonlyMap<string, MxCompileDiagnostic[]>,
  fileName?: string,
): MxCompileDiagnostic[] {
  return fileName === undefined
    ? [...diagnostics.values()].flat()
    : (diagnostics.get(fileName) ?? []);
}

export function warningDiagnostic(
  fileName: string,
  source: string,
  warning: MxWarning,
): MxCompileDiagnostic {
  const lineStart =
    lineOffsets(source)[Math.max(0, warning.line - 1)] ?? source.length;
  return {
    fileName,
    message: warning.message,
    offset: Math.min(source.length, lineStart + Math.max(0, warning.column)),
    source,
    category: "warning",
  };
}

/**
 * A compile error raised while compiling a tag template, split into the
 * diagnostic that belongs to the template file and the pointer diagnostic
 * left on the caller (spec §2's third position rule, matching the language
 * server's `diagnoseDocument`). `undefined` when `cause` is not a
 * `TranslateError` naming a file other than `callerFileName`.
 *
 * Every caller stores `templateDiagnostic` in its own `compileDiagnostics`
 * map under `templateFileName` — a key belonging to a *different* file's
 * `createVirtualCode` call. That map is one entry per file, so this can race
 * with the template's own independent compile if it is itself open: the
 * last write wins, and the template's own directly-detected diagnostics and
 * this caller-attributed one clobber each other rather than merging.
 * Pre-existing map shape; this is simply the first thing that writes into
 * another file's entry.
 */
export interface ForeignTemplateError {
  templateFileName: string;
  templateDiagnostic: MxCompileDiagnostic;
  callerDiagnostic: MxCompileDiagnostic;
}

/**
 * Reads a tag template's current source so its own diagnostic can be
 * positioned against its own text, not the caller's. Tries the supplied
 * reader first (an open editor buffer), then falls back to disk — the same
 * order `readCalleeInput` uses for a callee's `Input`.
 */
function readTemplateSource(
  templateFileName: string,
  readSource?: (fileName: string) => string | undefined,
): string {
  return (
    readSource?.(templateFileName) ??
    (() => {
      try {
        return readFileSync(templateFileName, "utf8");
      } catch {
        return "";
      }
    })()
  );
}

export function foreignTemplateError(
  cause: unknown,
  callerFileName: string,
  callerSource: string,
  readSource?: (fileName: string) => string | undefined,
): ForeignTemplateError | undefined {
  if (!(cause instanceof TranslateError)) return undefined;
  if (!cause.file || cause.file === callerFileName) return undefined;

  const templateFileName = cause.file;
  const templateSource = readTemplateSource(templateFileName, readSource);
  const lineStart =
    lineOffsets(templateSource)[Math.max(0, cause.line - 1)] ??
    templateSource.length;
  const templateOffset = Math.min(
    templateSource.length,
    lineStart + Math.max(0, cause.column),
  );

  return {
    templateFileName,
    templateDiagnostic: {
      fileName: templateFileName,
      message: cause.message,
      offset: templateOffset,
      source: templateSource,
      category: "error",
    },
    callerDiagnostic: {
      fileName: callerFileName,
      // Names both the template file and its exact position: tsserver's pull
      // model only surfaces `templateDiagnostic` when something actually
      // asks for `templateFileName`'s diagnostics — typically an editor
      // querying a file the author has open. When the template itself is
      // not open, this caller-side message is the only place the position
      // is visible at all, so it must be enough to find the error without
      // opening the template blind (unlike the language server, which
      // *pushes* `templateDiagnostic` unconditionally over LSP regardless of
      // whether the template is open — see `packages/tooling/typescript-plugin/AGENTS.md`).
      message: `${cause.message} (in ${templateFileName}:${cause.line}:${cause.column + 1})`,
      offset: 0,
      source: callerSource,
      category: "error",
    },
  };
}

/** Hard cap on `compileWithDependencies`'s passes, so a dependency cycle (A -> B -> A) or a pathological chain still terminates. */
const MAX_COMPILE_PASSES = 8;

/**
 * Compiles a caller against the current text of the callee files it depends
 * on, so an open callee's unsaved `Input` is what the caller is typed
 * against.
 *
 * Each pass runs with the accumulated sources every previous pass has read
 * from the host, plus whatever the most recent pass's own dependency list
 * added. Passes stop once a pass reports the same dependency set as the one
 * before it, or once a newly reported dependency has no host text different
 * from what a previous pass already read for it — either means the next pass
 * would see exactly what this one saw. `MAX_COMPILE_PASSES` bounds the loop
 * for a cycle (A depends on B depends on A) or a chain deeper than that,
 * neither of which the fixed-point conditions above would otherwise stop.
 * Sources accumulate across passes (never reset), so a dependency discovered
 * on pass N stays in scope on pass N+2 even if a later pass's own list
 * happens not to re-report it.
 *
 * A chain longer than one hop is real: a callee's `AttrTag<Alias>` (the
 * whole type argument, not a nested field reference) can itself alias a type
 * imported from a further file, which `readCalleeInput`'s own
 * `resolveNamedType` follows across files independent of this loop. Before
 * this fix, a single retry could discover a second-hop dependency but never
 * re-read a third-hop one the retry's own compile newly reported (pinned by
 * `packages/tooling/typescript-plugin/src/index.test.ts`'s
 * `compileWithDependencies against a real readCalleeInput compile` describe
 * block, driven through the real `readCalleeInput`, not a synthetic
 * callback).
 *
 * Dependencies are deliberately **not** registered through Volar's
 * `CodegenContext.getAssociatedScript`. An associated script is a file whose
 * content is embedded in its target's virtual code: `@volar/typescript`'s
 * `getServiceScript` answers for it with the *target's* service script. A
 * callee is a program file with virtual code of its own, so associating it
 * mapped the callee's diagnostics through its caller's mappings and reported
 * them in the caller's file (measured on `examples/todomvc`: the
 * `TodoItem.solid.mx` and `Footer.solid.mx` diagnostics, normally unmapped
 * and dropped, surfaced in `App.solid.mx` at unrelated lines).
 *
 * **Reaching the cap without a fixed point is not silent.** When the loop
 * falls through `MAX_COMPILE_PASSES` passes still finding a new dependency
 * set or new source text each time, a warning naming the chain discovered
 * across the last passes is pushed onto `result.warnings` (when `T` carries
 * one) — types for those callees may be stale, and a caller with no way to
 * see the cap was reached would otherwise report clean when it is not
 * (`compile-deps-cap-warning`, fix-forward for PR #150's
 * `compile-with-dependencies-nesting-limit`).
 */
export function compileWithDependencies<
  T extends { dependencies: string[]; warnings?: MxWarning[] },
>(
  readSource: DependencySourceReader | undefined,
  previousDependencies: readonly string[],
  compile: () => T,
): T {
  if (!readSource) return compile();

  let dependencies = previousDependencies;
  let sources = dependencySources(readSource, dependencies, new Map());
  let result = withCalleeInputSources(sources, compile);

  for (let pass = 1; pass < MAX_COMPILE_PASSES; pass++) {
    if (sameDependencies(dependencies, result.dependencies)) return result;
    const nextSources = dependencySources(
      readSource,
      result.dependencies,
      sources,
    );
    if (sameSources(sources, nextSources)) return result;
    dependencies = result.dependencies;
    sources = nextSources;
    result = withCalleeInputSources(sources, compile);
  }
  // The loop above only checks a pass's result against the *previous* pass
  // before running the *next* one, so the cap's own final compile (produced
  // inside the last iteration, right before the loop condition fails) is
  // never checked -- without this, a chain that genuinely settles on exactly
  // its 8th compile still fell through to the warning below.
  if (sameDependencies(dependencies, result.dependencies)) return result;
  const finalSources = dependencySources(
    readSource,
    result.dependencies,
    sources,
  );
  if (sameSources(sources, finalSources)) return result;
  result.warnings?.push(unsettledDependenciesWarning(result.dependencies));
  return result;
}

/** The cap-exhaustion warning, positioned at the file's own start (line 1, column 1) since no single call site owns an unsettled chain spanning the whole compile. */
function unsettledDependenciesWarning(
  dependencies: readonly string[],
): MxWarning {
  return {
    message:
      `MX stopped resolving callee inputs after ${MAX_COMPILE_PASSES} passes; ` +
      `the dependency chain did not settle: ${dependencies.join(" → ")}. ` +
      "Types for these callees may be stale.",
    line: 1,
    column: 0,
  };
}

function sameDependencies(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((dependency) => right.includes(dependency))
  );
}

function sameSources(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [fileName, source] of left) {
    if (right.get(fileName) !== source) return false;
  }
  return true;
}

/** Builds the accumulated source-override map for one pass: every previous pass's sources, plus a fresh read for each of `dependencies`. */
function dependencySources(
  readSource: DependencySourceReader,
  dependencies: readonly string[],
  previous: ReadonlyMap<string, string>,
): Map<string, string> {
  const sources = new Map(previous);
  for (const dependency of dependencies) {
    const source = readSource(dependency);
    if (source !== undefined) sources.set(dependency, source);
  }
  return sources;
}

function createVirtualCode(
  typescript: typeof ts,
  generated: string,
  source: string,
  map: RawSourceMap | undefined,
  supplementalMappings: CodeMapping[] = [],
): VirtualCode {
  return {
    id: "root",
    languageId: "typescriptreact",
    snapshot: typescript.ScriptSnapshot.fromString(generated),
    mappings: [
      ...(map ? decodeMappings(map, generated, source) : []),
      ...supplementalMappings,
    ].sort(
      (left, right) =>
        (left.generatedOffsets[0] ?? 0) - (right.generatedOffsets[0] ?? 0),
    ),
    embeddedCodes: [],
  };
}

/**
 * Appends an import for every Solid JSX built-in (`SOLID_BUILTIN_TAGS`,
 * `@mxlang/parser`) the generated text uses as a bare tag and the source
 * does not already bind (`sourceBindings`, same package) — so a caller who
 * genuinely wrote `import { Show } from "./my-show.ts"` is left alone rather
 * than getting a colliding second `Show`. `@mxlang/solid`'s emitter prints
 * these built-ins (`<Show>`, `<For>`, …) as bare tags because the *runtime*
 * build pipeline gets them for free — `@solidjs/vite-plugin`'s compiler
 * stage (native or Babel) auto-imports every built-in it sees, per
 * `@mxlang/solid`'s own `AGENTS.md` — and that compiler stage never runs
 * inside the type-check projection: `createVirtualCode` here only prints JSX
 * text and hands it straight to `tsc`/tsserver, so without this, every
 * `<Show>` (from `<if>`/`<if|u|>`), `<For>`/`<Repeat>` (from `<for>`),
 * `<Switch>`/`<Match>` (from a 3+-branch `<if>`), `<Errored>`/`<Loading>`
 * (from `<try>`) and `<Dynamic>` (from a dynamic tag) is an unresolved
 * identifier (TS2304), which drowns every real diagnostic inside that JSX in
 * noise the negative test below guards against staying hidden.
 *
 * Appended at the end of the file, after every mapping is computed from the
 * unmodified generated text, so no existing line or offset shifts: an
 * appended, unmapped import cannot mis-position an earlier diagnostic.
 *
 * **`generated` failing to parse would mean the printer itself emitted
 * invalid TSX** — a bug in this package, not an author mistake, since
 * `generated` is our own emitted output rather than authored source (see
 * `source-bindings-silent-parse-failure`). On that failure every built-in is
 * appended unconditionally rather than silently treating it as "nothing
 * bound" — over-importing risks at worst a redundant import TypeScript
 * already tolerates; under-importing (the old behavior, if `sourceBindings`
 * happened to swallow a real binding) risks hiding every real diagnostic
 * inside the JSX behind TS2304 noise, which is exactly the failure class
 * this function exists to prevent. The failure is reported through the same
 * `warning` channel every other non-fatal diagnostic in this file uses
 * (`compile-deps-cap-warning`'s cap warning is the precedent: positioned at
 * the file's own start, line 1 column 1, since there is no more specific
 * author-facing position for a printer-internal failure) rather than only a
 * `console.warn`, which an editor user would never see.
 */
export function appendSolidBuiltinImport(generated: string): {
  code: string;
  warning?: MxWarning;
} {
  const { bindings: bound, error } = sourceBindings(generated);
  const warning: MxWarning | undefined = error
    ? {
        message:
          "the printed .solid.mx module could not be parsed while checking " +
          "Solid built-in imports, so they were added conservatively " +
          `(${error.message})`,
        line: 1,
        column: 0,
      }
    : undefined;
  const needed = SOLID_BUILTIN_TAGS.filter(
    ({ name }) =>
      new RegExp(`<${name}[\\s/>]`).test(generated) &&
      (error || !bound.has(name)),
  );
  if (needed.length === 0) return { code: generated, warning };

  const byModule = new Map<string, string[]>();
  for (const { name, from } of needed) {
    const names = byModule.get(from) ?? [];
    names.push(name);
    byModule.set(from, names);
  }
  const imports = [...byModule.entries()]
    .map(([from, names]) => `import { ${names.join(", ")} } from "${from}";`)
    .join("\n");
  return { code: `${generated}\n${imports}\n`, warning };
}

/**
 * Maps each synthetic attribute-tag value object back to its authored tag
 * name, and each of that tag's own attributes back to its authored
 * `name=value` span. The SolidMX printer can map an attribute's *value*
 * (`title=1`'s `1`) exactly, because it is copied verbatim into the
 * generated object literal, but not its *key*: the printer re-quotes it
 * (`title` becomes `"title"`), so `decodeMappings`'s text-equality walk
 * never finds a matching span for it. TypeScript can position a property
 * type-mismatch diagnostic anywhere from the quoted key to the value
 * (`solid-attr-tag-attr-offset`), and a range diagnostic only resolves
 * through Volar's `toSourceRange` when the *same* mapping covers both ends
 * (`findMatchingStartEnd` translates the range's end through whichever
 * mapping matched its start) — so each property gets **one** mapping
 * spanning its whole `"key": value` text, covering every position TS might
 * pick, rather than separate key/value spans that leave gaps a range
 * diagnostic can straddle.
 */
export function attributeTagDiagnosticMappings(
  source: string,
  generated: string,
): CodeMapping[] {
  const generatedCursors = new Map<string, number>();
  const tags: Array<{
    sourceStart: number;
    generatedStart: number;
    generatedEnd: number;
    properties: CodeMapping[];
  }> = [];
  for (const match of source.matchAll(/@([A-Za-z_$][\w$]*)/g)) {
    const name = match[1];
    if (!name || match.index === undefined) continue;
    const sourceStart = match.index + 1;
    const probe = `${name}={{`;
    const probeStart = generated.indexOf(
      probe,
      generatedCursors.get(name) ?? 0,
    );
    if (probeStart < 0) continue;
    const generatedStart = probeStart;
    // This tag's *own* closing `} satisfies `, not the first one in the
    // text: a component nested inside this tag's body can itself take an
    // attribute tag, which prints its own `{ ... } satisfies ...}` before
    // this tag's closes (`<Card><@tab><Inner><@sub .../></Inner></@tab>`
    // nests `sub`'s wrapper inside `tab`'s). A naive `indexOf` finds the
    // *inner* tag's marker first, truncating this tag's span. Scanning by
    // brace depth from the object literal's own opening `{` (`probeStart +
    // name.length + 2`, right after `={`) finds the marker at depth 0 —
    // this object's own close — regardless of what is nested inside it.
    const generatedEndMarker = matchingSatisfiesMarker(
      generated,
      probeStart + probe.length - 1,
    );
    if (generatedEndMarker < 0) continue;
    const generatedEnd = generatedEndMarker + 1;
    generatedCursors.set(name, generatedEnd);
    tags.push({
      sourceStart,
      generatedStart,
      generatedEnd,
      properties: attributePropertyMappings(
        source,
        sourceStart,
        generated,
        generatedStart,
        generatedEnd,
      ),
    });
  }

  // Every property mapping across every tag, owner-tagged and sorted once:
  // a nested tag's own object literal (and its properties) sits *inside*
  // its parent's generated span
  // (`<Card><@tab><Inner><@sub .../></Inner></@tab>`'s `sub` properties fall
  // inside `tab`'s own range), so a *global* punch is required — punching
  // only a tag's own direct attributes out of its own fallback (as an
  // earlier version of this function did) still leaves the fallback
  // overlapping every nested tag's properties, and the wider, earlier-
  // sorted fallback silently wins per the array-order rule in the loop
  // below.
  const allProperties = tags
    .flatMap((tag) => tag.properties.map((property) => ({ tag, property })))
    .sort(
      (left, right) =>
        (left.property.generatedOffsets[0] ?? 0) -
        (right.property.generatedOffsets[0] ?? 0),
    );

  const mappings: CodeMapping[] = [];
  for (const tag of tags) {
    // The whole-object fallback and every property mapping (this tag's own,
    // and any nested tag's) must not share a generated offset:
    // `@volar/source-map`'s lookup yields every mapping containing an
    // offset in *array* order, so an overlapping wider span, if it sorted
    // first, would always win over a narrower one sorted after it by
    // `createVirtualCode`'s `generatedOffsets[0]` ascending sort. Punching
    // every property's own range out of the fallback (rather than relying
    // on sort order alone) keeps every generated offset covered by exactly
    // one candidate mapping.
    let cursor = tag.generatedStart;
    for (const { tag: owner, property } of allProperties) {
      const propertyStart = property.generatedOffsets[0] ?? 0;
      const propertyLength =
        property.generatedLengths?.[0] ?? property.lengths[0] ?? 0;
      if (propertyStart >= tag.generatedEnd) break;
      // Defensive: a malformed or overlapping property span (this
      // function's own bug, or a future one) must never regress `cursor`
      // or be pushed itself — no mapping is emitted rather than a wrong
      // one, same rule as `attributePropertyMappings`'s own guard.
      if (propertyStart < cursor || propertyLength <= 0) continue;
      if (propertyStart > cursor) {
        mappings.push(
          fallbackSpan(tag.sourceStart, cursor, propertyStart - cursor),
        );
      }
      // A nested tag's own property is punched out of every ancestor's
      // fallback above, but pushed into the result only once, from its
      // owning tag's own turn through this loop.
      if (owner === tag) mappings.push(property);
      cursor = propertyStart + propertyLength;
    }
    if (cursor < tag.generatedEnd) {
      mappings.push(
        fallbackSpan(tag.sourceStart, cursor, tag.generatedEnd - cursor),
      );
    }
  }
  return mappings;
}

/**
 * The index of the `}` that closes the object literal opened at
 * `objectOpen` (the `{` right after an attribute tag's `name={`), found by
 * bracket-depth scanning rather than the first `} satisfies ` in the text —
 * a component nested inside this tag's body can itself take an attribute
 * tag, whose own `{ ... } satisfies ...}` prints *inside* this one and
 * would otherwise be mistaken for this tag's own close. Quote-aware for the
 * same reason `topLevelCommaOrEnd` is. Returns `-1` if the depth never
 * returns to 0 before the text ends (malformed input, defensively refused
 * rather than guessed at).
 */
function matchingSatisfiesMarker(text: string, objectOpen: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = objectOpen; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === "]") {
      depth--;
      if (depth === 0 && char === "}") return i;
    }
  }
  return -1;
}

function fallbackSpan(
  sourceStart: number,
  generatedStart: number,
  generatedLength: number,
): CodeMapping {
  return {
    sourceOffsets: [sourceStart],
    generatedOffsets: [generatedStart],
    lengths: [0],
    generatedLengths: [generatedLength],
    data: { verification: true },
  };
}

/**
 * One tag's own attributes (`<@tab title=1 other="x">`'s `title` and
 * `other`), each mapped as a single span from its re-quoted key
 * (`"title":`) through its value's end in the generated object literal,
 * back to its authored `title=1` span in source. Scanned within
 * `[sourceStart, tag's own end)` and `[generatedStart, generatedEnd)` so an
 * attribute name repeated on a sibling attribute tag never cross-maps. A
 * value's generated end is found by bracket-depth-aware scanning for the
 * next top-level `,` or the object's own closing `}` (`generatedEnd - 1`),
 * since the value itself may contain commas or braces (an object literal,
 * a call).
 */
function attributePropertyMappings(
  source: string,
  sourceStart: number,
  generated: string,
  generatedStart: number,
  generatedEnd: number,
): CodeMapping[] {
  const tagCloseMatch = /[/?]?>/.exec(source.slice(sourceStart));
  const sourceTagEnd =
    tagCloseMatch?.index === undefined
      ? source.length
      : sourceStart + tagCloseMatch.index;
  const mappings: CodeMapping[] = [];
  const attrRe = /([A-Za-z_$][\w$]*)=/g;
  attrRe.lastIndex = sourceStart;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: bounded regex scan, mirrors the tag-name loop above
  while ((match = attrRe.exec(source)) !== null) {
    if (match.index >= sourceTagEnd) break;
    const key = match[1];
    if (!key) continue;
    const keySourceStart = match.index;
    // The emitter always prints a property as `"key": value` (colon, one
    // space, value — `attributeTagValue`'s `mapped(...), ": ",
    // attributeTagAttrValue(attr)`), so the value text itself starts one
    // character after the probe, not immediately after the colon.
    const probe = `"${key}": `;
    const probeStart = generated.indexOf(probe, generatedStart);
    if (probeStart < 0 || probeStart >= generatedEnd) continue;
    const valueStart = probeStart + probe.length;
    const propertyGeneratedEnd = topLevelCommaOrEnd(
      generated,
      valueStart,
      generatedEnd - 1,
    );
    // The authored value's own source length: same offset-and-length walk
    // `decodeMappings.equalLength` uses, bounded by how much of the
    // generated value text matches the source starting at the `=`.
    const sourceValueStart = keySourceStart + key.length + 1;
    const propertySourceEnd =
      sourceValueStart +
      equalLength(
        generated,
        valueStart,
        source,
        sourceValueStart,
        propertyGeneratedEnd - valueStart,
      );
    const sourceLength = propertySourceEnd - keySourceStart;
    const generatedLength = propertyGeneratedEnd - probeStart;
    // No mapping is emitted rather than a wrong one: a malformed scan (an
    // unbalanced bracket the quote-skip above did not anticipate) must
    // never produce a negative or zero-length span downstream.
    if (sourceLength <= 0 || generatedLength <= 0) continue;
    mappings.push({
      sourceOffsets: [keySourceStart],
      generatedOffsets: [probeStart],
      lengths: [sourceLength],
      generatedLengths: [generatedLength],
      data: { verification: true },
    });
  }
  return mappings.sort(
    (left, right) =>
      (left.generatedOffsets[0] ?? 0) - (right.generatedOffsets[0] ?? 0),
  );
}

/**
 * The first top-level (bracket-depth-0) `,` at or after `from`, else `end`.
 * Skips the contents of a `"`/`'`/`` ` `` string or template literal
 * (honoring `\`-escapes) so a value like `"a, b"` or `"a)b"` cannot be
 * mistaken for the property's own boundary or drive `depth` negative.
 */
function topLevelCommaOrEnd(text: string, from: number, end: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = from; i < end; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) return i;
  }
  return end;
}

export function decodeMappings(
  map: RawSourceMap,
  generated: string,
  source: string,
): CodeMapping[] {
  const generatedLineOffsets = lineOffsets(generated);
  const sourceLineOffsets = lineOffsets(source);
  const rawMappings: CodeMapping[] = [];

  for (const [generatedLine, segments] of decode(map.mappings).entries()) {
    const generatedLineOffset = generatedLineOffsets[generatedLine];
    if (generatedLineOffset === undefined) continue;
    const nextLineOffset =
      generatedLineOffsets[generatedLine + 1] ?? generated.length;

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      if (segment === undefined || segment.length < 4) continue;
      const sourceLine = segment[2];
      const sourceColumn = segment[3];
      if (sourceLine === undefined || sourceColumn === undefined) continue;
      const sourceLineOffset = sourceLineOffsets[sourceLine];
      if (sourceLineOffset === undefined) continue;

      const generatedOffset = generatedLineOffset + segment[0];
      const sourceOffset = sourceLineOffset + sourceColumn;

      // Bound the span by the next segment's start or end of generated line.
      const nextSegGenCol = segments[segIdx + 1]?.[0];
      const maxGen =
        nextSegGenCol !== undefined
          ? generatedLineOffset + nextSegGenCol
          : nextLineOffset;
      const maxLength = maxGen - generatedOffset;

      const length = Math.min(
        maxLength,
        equalLength(generated, generatedOffset, source, sourceOffset),
      );
      if (length === 0) continue;

      rawMappings.push({
        sourceOffsets: [sourceOffset],
        generatedOffsets: [generatedOffset],
        lengths: [length],
        data: codeInformation,
      });
    }
  }

  return mergeMappings(rawMappings);
}

/**
 * Merges adjacent `CodeMapping`s whose generated and source spans are
 * contiguous (i.e. end-to-start with the same delta). This keeps the mapping
 * list compact for the common case where lines outside MX regions are
 * identity-mapped character by character by `@babel/generator`.
 */
export function mergeMappings(mappings: CodeMapping[]): CodeMapping[] {
  const merged: CodeMapping[] = [];

  for (const curr of mappings) {
    const prev = merged[merged.length - 1];
    // Every mapping this function is given has exactly one span, but the
    // `CodeMapping` type allows many, so read the first defensively rather
    // than asserting: a malformed entry should be passed through untouched,
    // not merged on a guessed offset.
    const prevGen = prev?.generatedOffsets[0];
    const prevSrc = prev?.sourceOffsets[0];
    const prevLen = prev?.lengths[0];
    const currGen = curr.generatedOffsets[0];
    const currSrc = curr.sourceOffsets[0];
    const currLen = curr.lengths[0];

    if (
      prev === undefined ||
      prevGen === undefined ||
      prevSrc === undefined ||
      prevLen === undefined ||
      currGen === undefined ||
      currSrc === undefined ||
      currLen === undefined ||
      prev.generatedLengths !== undefined ||
      curr.generatedLengths !== undefined ||
      currGen !== prevGen + prevLen ||
      currSrc !== prevSrc + prevLen
    ) {
      merged.push(curr);
      continue;
    }

    prev.lengths[0] = prevLen + currLen;
  }

  return merged;
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let offset = 0; offset < text.length; offset++) {
    if (text.charCodeAt(offset) === 10) offsets.push(offset + 1);
  }
  return offsets;
}

function equalLength(
  generated: string,
  generatedOffset: number,
  source: string,
  sourceOffset: number,
  maxLength = Number.POSITIVE_INFINITY,
): number {
  let length = 0;
  while (
    length < maxLength &&
    generatedOffset + length < generated.length &&
    sourceOffset + length < source.length &&
    generated.charCodeAt(generatedOffset + length) ===
      source.charCodeAt(sourceOffset + length)
  ) {
    length++;
  }
  return length;
}

function isSolidMx(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(`.${SOLID_MX_EXTENSION}`);
}

function toSyntaxError(
  fileName: string,
  source: string,
  cause: unknown,
): SolidMxSyntaxError {
  const error = cause as {
    message?: string;
    loc?: { line?: number; column?: number; index?: number };
  };
  const line = Math.max(1, error.loc?.line ?? 1);
  const column = Math.max(0, error.loc?.column ?? 0);
  const lineStart = lineOffsets(source)[line - 1] ?? source.length;

  return {
    fileName,
    message: error.message ?? "Invalid SolidMX source.",
    offset: Math.min(source.length, error.loc?.index ?? lineStart + column),
    source,
  };
}

/**
 * Advertises the terminal `mx` suffix so TypeScript's module resolver can find
 * a `.solid.mx` file it was asked to import.
 *
 * Volar 2.4.28's resolver assumes a custom extension is one suffix. For
 * `X.solid.mx` TypeScript probes `X.solid.d.mx.ts`; declaring `mx` as an extra
 * extension lets that probe be redirected to the real source. Without it an
 * `import "./X.solid.mx"` is TS2307 even though the file compiles fine on its
 * own.
 *
 * This resolves nothing by itself — `getLanguageId` and `getServiceScript`
 * both return undefined, so no file is claimed. It exists purely to widen the
 * resolver, and is used by both the tsserver plugin and `mx-tsc` so an editor
 * and CI resolve imports the same way.
 */
export function createCompoundExtensionResolver(
  typescript: typeof ts,
): LanguagePlugin<string> {
  return {
    getLanguageId: () => undefined,
    typescript: {
      extraFileExtensions: [
        {
          extension: "mx",
          isMixedContent: false,
          scriptKind: typescript.ScriptKind.TSX,
        },
      ],
      getServiceScript: () => undefined,
    },
  };
}
