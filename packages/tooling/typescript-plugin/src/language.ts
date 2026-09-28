import { decode } from "@jridgewell/sourcemap-codec";
import {
  getCustomTags,
  type MxWarning,
  withCalleeInputSources,
} from "@mxlang/core";
import type { MxRegionCompile, RawSourceMap } from "@mxlang/parser";
import { parseBabel, print } from "@mxlang/parser";
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
        const discovered = getCustomTags(fileName, { host: "solid" });
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
        compileDiagnostics.set(
          fileName,
          warnings.map((warning) =>
            warningDiagnostic(fileName, source, warning),
          ),
        );
        return createVirtualCode(
          typescript,
          appendSolidBuiltinImport(printed.code),
          source,
          printed.map,
          attributeTagDiagnosticMappings(source, printed.code),
        );
      } catch (cause) {
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
 * Compiles a caller against the current text of the callee files it depends
 * on, so an open callee's unsaved `Input` is what the caller is typed
 * against.
 *
 * The first pass runs with the sources of the dependencies the previous
 * compile reported. A compile that reports a different set is repeated once
 * with the sources of the new set, unless the host holds nothing different
 * for it: the first pass then already read everything the second would.
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
 */
export function compileWithDependencies<T extends { dependencies: string[] }>(
  readSource: DependencySourceReader | undefined,
  previousDependencies: readonly string[],
  compile: () => T,
): T {
  if (!readSource) return compile();
  const previousSources = dependencySources(readSource, previousDependencies);
  const result = withCalleeInputSources(previousSources, compile);
  if (sameDependencies(previousDependencies, result.dependencies)) {
    return result;
  }
  const nextSources = dependencySources(readSource, result.dependencies);
  if (sameSources(previousSources, nextSources)) return result;
  return withCalleeInputSources(nextSources, compile);
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

function dependencySources(
  readSource: DependencySourceReader,
  dependencies: readonly string[],
): Map<string, string> {
  const sources = new Map<string, string>();
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
 * Solid JSX built-ins `@mxlang/solid`'s emitter can print as a bare tag with
 * no import of its own (`<Show>`, `<For>`, …): the *runtime* build pipeline
 * gets these for free because `@solidjs/vite-plugin`'s compiler stage
 * (native or Babel) auto-imports every built-in it sees, per
 * `@mxlang/solid`'s own `AGENTS.md`. That compiler stage never runs inside
 * the type-check projection — `createVirtualCode` here only prints JSX text
 * and hands it straight to `tsc`/tsserver — so without this, every `<Show>`
 * (from `<if>`/`<if|u|>`), `<For>`/`<Repeat>` (from `<for>`), `<Switch>`/
 * `<Match>` (from a 3+-branch `<if>`), `<Errored>`/`<Loading>` (from
 * `<try>`) and `<Dynamic>` (from a dynamic tag) is an unresolved identifier
 * (TS2304), which drowns every real diagnostic inside that JSX in noise the
 * negative test below guards against staying hidden.
 */
const SOLID_BUILTIN_IMPORTS: ReadonlyArray<{
  name: string;
  from: string;
}> = [
  { name: "Show", from: "solid-js" },
  { name: "For", from: "solid-js" },
  { name: "Switch", from: "solid-js" },
  { name: "Match", from: "solid-js" },
  { name: "Repeat", from: "solid-js" },
  { name: "Errored", from: "solid-js" },
  { name: "Loading", from: "solid-js" },
  { name: "Dynamic", from: "@solidjs/web" },
];

/**
 * Appends an import for every Solid JSX built-in the generated text uses as
 * a bare tag and the source does not already bind (an import, or any other
 * top-level declaration of the same name) — so a caller who genuinely wrote
 * `import { Show } from "./my-show.ts"` is left alone rather than getting a
 * colliding second `Show`. Appended at the end of the file, after every
 * mapping is computed from the unmodified generated text, so no existing
 * line or offset shifts: an appended, unmapped import cannot mis-position an
 * earlier diagnostic.
 */
export function appendSolidBuiltinImport(generated: string): string {
  const bound = sourceBindings(generated);
  const needed = SOLID_BUILTIN_IMPORTS.filter(
    ({ name }) =>
      new RegExp(`<${name}[\\s/>]`).test(generated) && !bound.has(name),
  );
  if (needed.length === 0) return generated;

  const byModule = new Map<string, string[]>();
  for (const { name, from } of needed) {
    const names = byModule.get(from) ?? [];
    names.push(name);
    byModule.set(from, names);
  }
  const imports = [...byModule.entries()]
    .map(([from, names]) => `import { ${names.join(", ")} } from "${from}";`)
    .join("\n");
  return `${generated}\n${imports}\n`;
}

/**
 * The generated file's actual top-level bound identifiers — every import's
 * *local* name (so `import { Show as MyShow }` binds `MyShow`, not `Show`)
 * plus every top-level `const`/`function`/`class` declaration — so
 * `appendSolidBuiltinImport` never shadows a name the author already bound
 * and never skips one because an unrelated line merely contains the text of
 * its name (an alias clause, a multi-line import). Parses the generated text
 * with the same Babel used to print it rather than scanning lines, since a
 * line-based probe cannot tell a bound identifier from a substring: it must
 * resolve what each declaration actually binds.
 */
function sourceBindings(generated: string): Set<string> {
  const bound = new Set<string>();
  let program: ReturnType<typeof parseBabel>["program"];
  try {
    const file = parseBabel(generated, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
    program = file.program;
  } catch {
    return bound;
  }
  for (const statement of program.body) {
    switch (statement.type) {
      case "ImportDeclaration":
        if (statement.importKind === "type") break;
        for (const specifier of statement.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.importKind === "type"
          ) {
            continue;
          }
          bound.add(specifier.local.name);
        }
        break;
      case "VariableDeclaration":
        for (const declarator of statement.declarations) {
          collectPatternNames(declarator.id, bound);
        }
        break;
      case "FunctionDeclaration":
      case "ClassDeclaration":
        if (statement.id) bound.add(statement.id.name);
        break;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        if (
          statement.declaration &&
          (statement.declaration.type === "VariableDeclaration" ||
            statement.declaration.type === "FunctionDeclaration" ||
            statement.declaration.type === "ClassDeclaration")
        ) {
          if (statement.declaration.type === "VariableDeclaration") {
            for (const declarator of statement.declaration.declarations) {
              collectPatternNames(declarator.id, bound);
            }
          } else if (statement.declaration.id) {
            bound.add(statement.declaration.id.name);
          }
        }
        break;
      default:
        break;
    }
  }
  return bound;
}

/**
 * Collects every identifier a binding pattern introduces — a bare name, or
 * the names inside a destructured object/array — so a top-level
 * `const { Show } = ...` is recognized as binding `Show` the same as a plain
 * `const Show = ...` would. Untyped on purpose: the pattern shapes are a
 * small, stable subset of Babel's AST and pulling in `@babel/types` just for
 * this helper's signature is not worth a new dependency.
 */
// biome-ignore lint/suspicious/noExplicitAny: small stable subset of Babel's pattern node shapes
function collectPatternNames(pattern: any, bound: Set<string>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      bound.add(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "ObjectProperty") {
          collectPatternNames(property.value, bound);
        } else if (property.type === "RestElement") {
          collectPatternNames(property.argument, bound);
        }
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        collectPatternNames(element, bound);
      }
      break;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, bound);
      break;
    case "RestElement":
      collectPatternNames(pattern.argument, bound);
      break;
    default:
      break;
  }
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
  const mappings: CodeMapping[] = [];
  const generatedCursors = new Map<string, number>();
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
    const generatedEndMarker = generated.indexOf("} satisfies ", probeStart);
    if (generatedEndMarker < 0) continue;
    const generatedEnd = generatedEndMarker + 1;
    generatedCursors.set(name, generatedEnd);
    const propertyMappings = attributePropertyMappings(
      source,
      sourceStart,
      generated,
      generatedStart,
      generatedEnd,
    );
    // The whole-object fallback and each property mapping above must not
    // share a generated offset: `@volar/source-map`'s lookup yields every
    // mapping containing an offset in *array* order, so an overlapping
    // wider span, if it sorted first, would always win over a narrower one
    // sorted after it by `createVirtualCode`'s `generatedOffsets[0]`
    // ascending sort. Punching each property's own range out of the
    // fallback (rather than relying on sort order alone) keeps every
    // generated offset covered by exactly one candidate mapping.
    let cursor = generatedStart;
    for (const property of propertyMappings) {
      const propertyStart = property.generatedOffsets[0] ?? 0;
      if (propertyStart > cursor) {
        mappings.push(
          fallbackSpan(sourceStart, cursor, propertyStart - cursor),
        );
      }
      mappings.push(property);
      cursor =
        propertyStart +
        (property.generatedLengths?.[0] ?? property.lengths[0] ?? 0);
    }
    if (cursor < generatedEnd) {
      mappings.push(fallbackSpan(sourceStart, cursor, generatedEnd - cursor));
    }
  }
  return mappings;
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
    const probe = `"${key}":`;
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
    mappings.push({
      sourceOffsets: [keySourceStart],
      generatedOffsets: [probeStart],
      lengths: [propertySourceEnd - keySourceStart],
      generatedLengths: [propertyGeneratedEnd - probeStart],
      data: { verification: true },
    });
  }
  return mappings.sort(
    (left, right) =>
      (left.generatedOffsets[0] ?? 0) - (right.generatedOffsets[0] ?? 0),
  );
}

/** The first top-level (bracket-depth-0) `,` at or after `from`, else `end`. */
function topLevelCommaOrEnd(text: string, from: number, end: number): number {
  let depth = 0;
  for (let i = from; i < end; i++) {
    const char = text[i];
    if (char === "(" || char === "[" || char === "{") depth++;
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
