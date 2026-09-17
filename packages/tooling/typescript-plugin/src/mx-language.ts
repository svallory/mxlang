import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  type CustomTag,
  type Expr,
  type GeneratedMapping,
  getCustomTags,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type Lookup,
  lower,
  type Node,
  newCtx,
  parseFragment,
  resolveHostPolicy,
  scanCached,
} from "@mxlang/core";
import { compileHonoMx, honoDeclarations } from "@mxlang/hono";
import { compile, policy, strictPolicy, translator } from "@mxlang/html";
import { compilePreactMx, preactDeclarations } from "@mxlang/preact";
import { compileReactMx, reactDeclarations } from "@mxlang/react";
import { compileSolidMx } from "@mxlang/solid";
import type {
  CodeMapping,
  LanguagePlugin,
  VirtualCode,
} from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";
import { codeInformation, decodeMappings, mergeMappings } from "./language.ts";

export const MX_LANGUAGE_ID = "mx";
export const MX_EXTENSIONS = ["mx"] as const;

export interface MxSyntaxError {
  fileName: string;
  message: string;
  offset: number;
  source: string;
}

export interface MxLanguagePlugin extends LanguagePlugin<string> {
  getSyntaxError(fileName: string): MxSyntaxError | undefined;
}

export interface MxLanguagePluginOptions {
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

  const tagsFor = (fileName: string): Record<string, CustomTag> | undefined => {
    // A misconfigured `mx.tags` is not fatal — the local `tags/` directories
    // still resolve — but silence is worse than a warning here: a tag simply
    // fails to resolve with nothing saying why. There is no diagnostic
    // channel for a problem in a *different* file than the one being checked,
    // so this goes to the log, which is tsserver's own log in an editor and
    // stderr under `mx-tsc`.
    for (const diagnostic of scanCached(fileName).diagnostics) {
      const key = `${diagnostic.file}\u0000${diagnostic.message}`;
      if (reported.has(key)) continue;
      reported.add(key);
      console.warn(
        `@mxlang/typescript-plugin: ${diagnostic.file}: ${diagnostic.message}`,
      );
    }

    const discovered = getCustomTags(fileName);
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
      try {
        const hostPolicy = resolveHostPolicy(fileName);
        // Resolved once and threaded through both the compile and the second
        // lowering below: P1's same-map rule, now fed by discovery.
        const customTags = tagsFor(fileName);
        const strict =
          hostPolicy.host === "astro" || hostPolicy.strict === true;
        const compiled =
          hostPolicy.host === "solid"
            ? compileSolidMx(source, {
                filename: fileName,
                customTags,
              })
            : hostPolicy.host === "preact"
              ? compilePreactMx(source, fileName, {
                  customTags,
                })
              : hostPolicy.host === "react"
                ? compileReactMx(source, fileName, {
                    customTags,
                  })
                : hostPolicy.host === "hono"
                  ? compileHonoMx(source, fileName, {
                      customTags,
                    })
                  : compile(source, fileName, {
                      strict,
                      customTags,
                    });
        const generated =
          hostPolicy.host === "astro"
            ? createAstroTypeSurface(compiled.code)
            : compiled.code;
        const mappings =
          hostPolicy.host === "solid"
            ? mergeMappings(
                [
                  ...decodeMappings(compiled.map, generated, source),
                  ...recordedMappings(compiled.mappings),
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
                // Resolve under the host that produced `generated`: a
                // construct one host accepts another rejects, and resolving
                // under the wrong policy throws instead of mapping.
                hostPolicy.host === "preact"
                  ? preactDeclarations
                  : hostPolicy.host === "react"
                    ? reactDeclarations
                    : hostPolicy.host === "hono"
                      ? honoDeclarations
                      : undefined,
                compiled.mappings,
                customTags,
              );
        syntaxErrors.delete(fileName);
        return createVirtualCode(typescript, generated, mappings);
      } catch (cause) {
        syntaxErrors.set(fileName, toSyntaxError(fileName, source, cause));
        return createVirtualCode(typescript, "", []);
      }
    },

    getSyntaxError(fileName) {
      return syntaxErrors.get(fileName);
    },

    typescript: {
      resolveHiddenExtensions: true,
      extraFileExtensions: MX_EXTENSIONS.map((extension) => ({
        extension,
        isMixedContent: false,
        scriptKind: typescript.ScriptKind.TSX,
      })),
      getServiceScript(root) {
        // TSX, not TS, and for every host: the Preact host emits a component
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
  const defaultExport = "export default render;";
  if (!code.includes(defaultExport)) {
    throw new Error(
      "@mxlang/typescript-plugin: the Astro host could not find the compiled MX default export.",
    );
  }
  return code.replace(
    defaultExport,
    [
      'type MxAstroInput = "content" extends keyof Input',
      '  ? Omit<Input, "content"> & { children?: unknown }',
      "  : Input;",
      "const mxAstroRender = render as unknown as (input: MxAstroInput) => string;",
      "export default mxAstroRender;",
    ].join("\n"),
  );
}

function createVirtualCode(
  typescript: typeof ts,
  generated: string,
  mappings: CodeMapping[],
): VirtualCode {
  return {
    id: "root",
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
  emittedMappings: GeneratedMapping[] = [],
  customTags?: Record<string, CustomTag>,
): CodeMapping[] {
  const require = createRequire(import.meta.url);
  const compiler = require("@marko/compiler") as {
    taglib: {
      buildLookup(directory: string, translator: unknown): Lookup | undefined;
    };
  };
  const { generator } = require("@marko/compiler/internal/babel") as {
    generator(node: Node, options: { concise: boolean }): { code: string };
  };
  const { body } = parseFragment(source, {
    filename: fileName,
    customTags,
  });
  const ctx = newCtx(
    source,
    (node) => generator(node, { concise: true }).code,
    declarations ?? (strict ? strictPolicy : policy),
    compiler.taglib.buildLookup(dirname(fileName), translator),
    fileName,
  );
  // This is the second lowering of the same source. It must see the same tag
  // map as compilation or a custom tag can make the entire mapping pass fail.
  ctx.customTags = customTags;
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

function recordedMappings(mappings: GeneratedMapping[]): CodeMapping[] {
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

function isExpression(value: object): value is Expr {
  const candidate = value as Partial<Expr>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.shape === "string" &&
    !!candidate.node
  );
}

function isPositionedCode(
  value: object,
): value is Exclude<PositionedCode, Expr> {
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
  if (lower.endsWith(".solid.mx")) return false;
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
  return {
    fileName,
    message: error.message ?? "Invalid MX source.",
    offset: Math.min(source.length, offset),
    source,
  };
}
