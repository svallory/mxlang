import { dirname, join } from "node:path";
import ts from "typescript";
import { compile } from "../index.ts";

/** One TypeScript diagnostic of the projection, at the authored text it maps to. */
export interface Found {
  code: number;
  text: string;
  /** The authored text the diagnostic's start maps to, `?` when it is unmapped. */
  at: string;
}

export interface DiagnosticsOptions {
  /** Virtual modules beside the page, by name (`"one.ts"`). */
  files?: Record<string, string>;
  /** Overrides of the base options (`noUnusedLocals`, `erasableSyntaxOnly`, ...). */
  compilerOptions?: ts.CompilerOptions;
}

// The page and its virtual modules sit in a directory under `src`, so the
// emitted `import … from "@mxlang/target-html"` resolves to this package.
const DIR = join(dirname(import.meta.dirname), "__type-check__");
const PAGE = join(DIR, "page.mx");
const MODULE = join(DIR, "page.ts");

const BASE: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  types: [],
};

/**
 * A diagnostic in an authored statement the target copies verbatim to module
 * level (`static` code, `export interface Input`): the tools map those whole
 * statements from the IR by finding their code in both texts, not from the
 * target's own mappings, so the line is found in the source here the same way.
 * Only a module-level line (no indent: generated scaffolding is indented) found
 * exactly once qualifies, else `?`. Each row that relies on this is also checked
 * through the editor path (the plugin's `client-server-view.test.ts`).
 */
function statementText(
  source: string,
  code: string,
  start: number,
  length: number,
): string {
  const lineStart = code.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = code.indexOf("\n", start);
  const line = code.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const at = source.indexOf(line);
  if (
    line.trim() === "" ||
    line !== line.trimStart() ||
    at === -1 ||
    source.indexOf(line, at + 1) !== -1
  ) {
    return "?";
  }
  const offset = at + start - lineStart;
  return source.slice(offset, offset + length);
}

/** Library and package files parsed once per process: only the page and its virtual modules change. */
const shared = new Map<string, ts.SourceFile | undefined>();

/**
 * Compiles `source` with `typeCheck`, checks the projection with TypeScript in
 * process, and maps each diagnostic of the page back to the authored text.
 */
export function diagnosticsOf(
  source: string,
  options: DiagnosticsOptions = {},
): Found[] {
  const result = compile(source, PAGE, { typeCheck: true });
  const virtual = new Map<string, string>([[MODULE, result.code]]);
  for (const [name, text] of Object.entries(options.files ?? {})) {
    virtual.set(join(DIR, name), text);
  }
  const compilerOptions = { ...BASE, ...options.compilerOptions };
  const host = ts.createCompilerHost(compilerOptions);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const text = virtual.get(name);
    if (text !== undefined) {
      return ts.createSourceFile(name, text, languageVersion, true);
    }
    const key = `${name}\0${JSON.stringify(languageVersion)}`;
    if (!shared.has(key)) {
      shared.set(key, original(name, languageVersion, ...rest));
    }
    return shared.get(key);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => virtual.has(name) || fileExists(name);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (name) =>
    name === DIR || (directoryExists?.(name) ?? true);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => virtual.get(name) ?? readFile(name);
  const program = ts.createProgram([MODULE], compilerOptions, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(MODULE))
    .filter((d) => d.file?.fileName === MODULE)
    .map((d) => {
      const start = d.start ?? 0;
      // The narrowest mapping holding the start: the authored token.
      const mapping = result.mappings
        .filter((m) => m.generatedStart <= start && start < m.generatedEnd)
        .sort(
          (a, b) =>
            a.generatedEnd -
            a.generatedStart -
            (b.generatedEnd - b.generatedStart),
        )[0];
      return {
        code: d.code,
        text: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        at: !mapping
          ? statementText(source, result.code, start, d.length ?? 0)
          : // A mapping that copies the text maps the diagnostic's own range.
            mapping.generatedEnd - mapping.generatedStart ===
              mapping.sourceEnd - mapping.sourceStart
            ? source.slice(
                mapping.sourceStart + start - mapping.generatedStart,
                mapping.sourceStart +
                  Math.min(start + (d.length ?? 0), mapping.generatedEnd) -
                  mapping.generatedStart,
              )
            : source.slice(mapping.sourceStart, mapping.sourceEnd),
      };
    });
}
