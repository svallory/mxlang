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
 * available). Each name is declared as both a value and a type, with the same
 * arity the source gave a generic declaration, so `import { X }`,
 * `import type { X }`, `import * as NS` and `X<T>` all resolve.
 *
 * The stub carries no source mappings, so no diagnostic is ever reported inside
 * it. Do not revert this to `""`.
 */
const IDENT = "[A-Za-z_$][\\w$]*";
const DECLARATION = new RegExp(
  `\\bexport\\s+(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(const\\s+enum|const|let|var|function\\*?|class|interface|type|enum)\\s+(${IDENT})`,
  "g",
);
const SPECIFIER_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;

/** Number of type parameters of a declaration whose name ends at `from`. */
function typeParameterCount(source: string, from: number): number {
  if (source[from] !== "<") return 0;
  let depth = 0;
  let count = 1;
  for (let index = from; index < source.length; index++) {
    const char = source[index];
    if (char === "<" || char === "(" || char === "[" || char === "{") depth++;
    else if (char === ">" || char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) return count;
    } else if (char === "," && depth === 1) count++;
  }
  return 1;
}

function namedExports(source: string): Map<string, number> {
  const names = new Map<string, number>();
  for (const match of source.matchAll(DECLARATION)) {
    const name = match[2];
    if (name === undefined || name === "default") continue;
    const arity =
      match[1] === "interface" || match[1] === "type"
        ? typeParameterCount(source, (match.index ?? 0) + match[0].length)
        : 0;
    names.set(name, Math.max(arity, names.get(name) ?? 0));
  }
  for (const match of source.matchAll(SPECIFIER_LIST)) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const exported = specifier
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (exported && new RegExp(`^${IDENT}$`).test(exported)) {
        if (exported !== "default")
          names.set(exported, names.get(exported) ?? 0);
      }
    }
  }
  names.set("Input", names.get("Input") ?? 0);
  return names;
}

export function failedModuleStub(source: string): string {
  const lines = [
    "declare const __mxFailed: any;",
    "export default __mxFailed;",
  ];
  for (const [name, arity] of namedExports(source)) {
    const params = Array.from({ length: arity }, (_, i) => `_${i} = any`);
    lines.push(
      `export const ${name}: any = __mxFailed;`,
      `export type ${name}${params.length ? `<${params.join(", ")}>` : ""} = any;`,
    );
  }
  return `${lines.join("\n")}\n`;
}
