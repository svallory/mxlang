/**
 * The virtual module for a template that failed to compile.
 *
 * It used to be `""`, which is not a module: every importer then reported
 * `TS2306 File '…' is not a module`, which mx-tsc printed *before* the real
 * compile error (in the template, at its own line and column) and which sent
 * readers to the importer. A stub that is a valid module with an `any`-typed
 * default and an `Input` type absorbs the importer-side errors, so the compile
 * error is the only diagnostic left.
 *
 * TypeScript has no wildcard export, so a default-only stub would just move
 * the cascade to TS2305/TS2614 for every named import. The stub therefore also
 * re-declares each name the failed source itself exports, found with a
 * tolerant lexical scan (the source did not parse, so a real parse is not
 * available), and copies `export * [as N] from` lines verbatim. Each name is
 * a value and a type that accept any call, construction or type arguments, so
 * `import { X }`, `import type { X }`, `import * as NS`, `X<T>`, `new X<T>()`
 * and `f<T>()` all resolve.
 *
 * The stub carries no source mappings, so no diagnostic is ever reported inside
 * it. Do not revert this to `""`.
 */
const IDENT = "[A-Za-z_$][\\w$]*";
// `[ \t]+`, never `\s+`: a file being typed (`export type` then a newline and
// the next `export`) must not have its keyword read as the previous name.
const DECLARATION = new RegExp(
  `\\bexport[ \\t]+(default[ \\t]+)?(?:declare[ \\t]+)?(?:abstract[ \\t]+)?(?:async[ \\t]+)?(const[ \\t]+enum|const|let|var|function\\*?|class|interface|type|enum)[ \\t]*(?:(${IDENT})|([{\\[]))`,
  "g",
);
const SPECIFIER_LIST = /\bexport[ \t]+(?:type[ \t]+)?\{([^}]*)\}/g;
const STAR_REEXPORT = new RegExp(
  `^[ \\t]*export[ \\t]+\\*(?:[ \\t]+as[ \\t]+${IDENT})?[ \\t]+from[ \\t]*(["'])[^"'\\n]*\\1`,
  "gm",
);
const IDENT_ONLY = new RegExp(`^${IDENT}$`);
const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await async of type declare abstract as from get set namespace module global " +
    "__mxFailed __MxAny"
  ).split(" "),
);

function usable(name: string | undefined): name is string {
  return name !== undefined && IDENT_ONLY.test(name) && !RESERVED.has(name);
}

/** Identifiers bound by the `{…}`/`[…]` pattern that opens at `from`. */
function patternNames(source: string, from: number): string[] {
  let depth = 0;
  let end = from;
  for (; end < source.length; end++) {
    const char = source[end];
    if (char === "{" || char === "[" || char === "(") depth++;
    else if (char === "}" || char === "]" || char === ")") {
      depth--;
      if (depth === 0) break;
    }
    if (char === "\n" && source[end + 1] === "\n") break;
  }
  const pattern = source
    .slice(from, end)
    .replace(/=[^,}\]]*/g, "")
    .replace(/\.\.\./g, "");
  return [...pattern.matchAll(new RegExp(`(${IDENT})(?![\\w$]|\\s*:)`, "g"))]
    .map((m) => m[1])
    .filter(usable);
}

function namedExports(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(DECLARATION)) {
    if (match[1] !== undefined) continue; // `export default …` binds no name
    if (match[4] !== undefined) {
      for (const name of patternNames(
        source,
        (match.index ?? 0) + match[0].length - 1,
      ))
        names.add(name);
    } else if (usable(match[3])) names.add(match[3]);
  }
  for (const match of source.matchAll(SPECIFIER_LIST)) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const exported = specifier
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (usable(exported)) names.add(exported);
    }
  }
  names.add("Input");
  return names;
}

// Arity-free: a value that may be called or constructed with any type
// arguments, and a type alias that accepts up to eight. A scanned arity
// would miss generic classes/functions (TS2315, TS2347) and miscount
// `<A extends () => void>`.
const PARAMS = Array.from({ length: 8 }, (_, i) => `_${i} = any`).join(", ");
const ANY_VALUE = `{ <${PARAMS}>(...a: any[]): any; new <${PARAMS}>(...a: any[]): any; [k: string]: any }`;

export function failedModuleStub(source: string): string {
  const lines = [
    "declare const __mxFailed: any;",
    "export default __mxFailed;",
    `type __MxAny = ${ANY_VALUE};`,
  ];
  for (const name of namedExports(source)) {
    lines.push(
      `export declare const ${name}: __MxAny; export type ${name}<${PARAMS}> = any;`,
    );
  }
  for (const match of source.matchAll(STAR_REEXPORT)) {
    lines.push(`${match[0].trim()};`);
  }
  return `${lines.join("\n")}\n`;
}
