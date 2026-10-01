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
 * a type alias accepting any type arguments, and a value: `any` for data
 * (so `n: number = count`, `count + 1`, `for…of`, `switch` all type-check) but
 * a callable, constructible, generic shape for a `function`, `class` or
 * function-initialized binding (calling `any` with type arguments is TS2347,
 * and no single type is both assignable to `number` and callable). Known
 * limit: a callback passed to a method of a stubbed value gets TS7006 under
 * `noImplicitAny` (true of `any` too).
 *
 * The stub carries no source mappings, so no diagnostic is ever reported inside
 * it. Do not revert this to `""`.
 */
const IDENT = "[\\p{ID_Start}$_][\\p{ID_Continue}$‌‍]*";
// `[ \t]+`, never `\s+`: a file being typed (`export type` then a newline and
// the next `export`) must not have its keyword read as the previous name.
const DECLARATION = new RegExp(
  `\\bexport[ \\t]+(default[ \\t]+)?(?:declare[ \\t]+)?(?:abstract[ \\t]+)?(?:async[ \\t]+)?(const[ \\t]+enum|const|let|var|function\\*?|class|interface|type|enum)[ \\t]*(?:(${IDENT})|([{\\[]))`,
  "gu",
);
const SPECIFIER_LIST = /\bexport[ \t]+(?:type[ \t]+)?\{([^}]*)\}/gu;
const STAR_REEXPORT = new RegExp(
  `^[ \\t]*export[ \\t]+\\*(?:[ \\t]+as[ \\t]+${IDENT})?[ \\t]+from[ \\t]*(["'])[^"'\\n]*\\1`,
  "gmu",
);
const IDENT_ONLY = new RegExp(`^${IDENT}$`, "u");
// Words that cannot be a binding name. Contextual keywords (`get`, `set`,
// `type`, `from`, `of`, `async`, …) are legal names and are kept. The two
// helper names are filtered so an export cannot collide with them.
const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await " +
    "__mx$failed$ __Mx$Any$"
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
    .replace(/=[^,}\]]*/gu, "")
    .replace(/\.\.\./gu, "");
  return [
    ...pattern.matchAll(
      new RegExp(`(${IDENT})(?![\\p{ID_Continue}$]|\\s*:)`, "gu"),
    ),
  ]
    .map((m) => m[1])
    .filter(usable);
}

type Kind = "callable" | "data";

function escapeRegExp(text: string): string {
  return text.replace(/[$()*+.?[\\\]^{|}]/gu, "\\$&");
}

/** Is `name` declared in `source` as a function, a class or a function-valued binding? */
function declaredCallable(source: string, name: string): boolean {
  const id = escapeRegExp(name);
  return new RegExp(
    `\\b(?:function\\*?|class)[ \\t]+${id}(?![\\p{ID_Continue}$])|\\b(?:const|let|var)[ \\t]+${id}[ \\t]*(?::[^=\\n]*)?=[ \\t]*(?:async[ \\t]+)?(?:function\\b|<|\\(|${IDENT}[ \\t]*=>)`,
    "u",
  ).test(source);
}

function namedExports(source: string): Map<string, Kind> {
  const names = new Map<string, Kind>();
  const add = (name: string, kind: Kind) => {
    if (kind === "callable" || !names.has(name)) names.set(name, kind);
  };
  for (const match of source.matchAll(DECLARATION)) {
    if (match[1] !== undefined) continue; // `export default …` binds no name
    const end = (match.index ?? 0) + match[0].length;
    if (match[4] !== undefined) {
      for (const name of patternNames(source, end - 1)) add(name, "data");
    } else if (usable(match[3])) {
      const keyword = match[2] ?? "";
      add(
        match[3],
        keyword.startsWith("function") || keyword === "class"
          ? "callable"
          : declaredCallable(source, match[3])
            ? "callable"
            : "data",
      );
    }
  }
  for (const match of source.matchAll(SPECIFIER_LIST)) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const parts = specifier
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u);
      const exported = parts.at(-1)?.trim();
      const local = parts[0]?.trim();
      if (usable(exported)) {
        add(
          exported,
          local && declaredCallable(source, local) ? "callable" : "data",
        );
      }
    }
  }
  add("Input", "data");
  return names;
}

const PARAMS = Array.from({ length: 8 }, (_, i) => `_${i} = any`).join(", ");
const CALLABLE = `{ <${PARAMS}>(...a: any[]): any; new <${PARAMS}>(...a: any[]): any; [k: string]: any }`;

export function failedModuleStub(source: string): string {
  const lines = [
    "declare const __mx$failed$: any;",
    "export default __mx$failed$;",
    `type __Mx$Any$ = ${CALLABLE};`,
  ];
  for (const [name, kind] of namedExports(source)) {
    lines.push(
      `export declare const ${name}: ${kind === "callable" ? "__Mx$Any$" : "any"}; export type ${name}<${PARAMS}> = any;`,
    );
  }
  for (const match of source.matchAll(STAR_REEXPORT)) {
    lines.push(`${match[0].trim()};`);
  }
  return `${lines.join("\n")}\n`;
}
