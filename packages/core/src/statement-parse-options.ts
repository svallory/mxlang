/**
 * The Babel options a module statement's text (`static`, `server`, `client`,
 * `export`) is parsed with. The statement check (`rejectInvalidStatement`)
 * and the row check (`firstRowIn`) both read the text through this one
 * helper, so they cannot disagree on what the text means.
 */

/** The options `@babel/parser` reads a module statement with. */
export interface StatementParseOptions {
  sourceType: "module";
  plugins: string[];
  allowReturnOutsideFunction: boolean;
  allowImportExportEverywhere?: boolean;
  allowUndeclaredExports: boolean;
  allowSuperOutsideMethod: boolean;
  allowNewTargetOutsideFunction: boolean;
}

/** The parse options of a statement written after `keyword`. */
export function statementParseOptions(keyword: string): StatementParseOptions {
  return {
    sourceType: "module",
    // Stock Marko's own sub-parse options: `client { let q = super.x }` and
    // `new.target` compile there (to `var q;`, the client statement is
    // dropped), so they parse here too. In `static`, `server` and `export`
    // the text is emitted at the module's top level, where they are a
    // SyntaxError on load, so those keep the refusal.
    allowSuperOutsideMethod: keyword === "client",
    allowNewTargetOutsideFunction: keyword === "client",
    // This statement is one of the module's, parsed alone: an `export { q }`
    // names a binding an earlier statement or import declares.
    allowUndeclaredExports: true,
    // No decorators plugin: stock Marko (compiler 5.42.11) has none either, so
    // `static @d() class C {}` and `@d m() {}` are refused, as it does.
    plugins: ["typescript"],
    // A top-level `return` is TypeScript's TS1108 to report, with its mapping,
    // in an Astro fence and a template `static` alike; stock Marko 6.3.51
    // compiles a template `static return` too.
    allowReturnOutsideFunction: true,
  };
}
