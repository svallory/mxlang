/**
 * Placing a region's synthesized tag imports in the surrounding module.
 *
 * An MX region inside a `.solid.mx` file is an *expression*, so an import the
 * compiler minted for a discovered tag has no module scope of its own to land
 * in: the surrounding TypeScript module is the only place it can go (design
 * §3.2, decision 95 ruling 3).
 *
 * Two consumers need exactly this, which is why the decision lives here rather
 * than inside either of them: `parse` (the product path, for a whole
 * `.solid.mx` file) and `@mxlang/typescript-plugin` (the editor path, which
 * compiles regions itself and must project the same imports into its virtual
 * file, or the tag's binding is unresolved in the editor while the build is
 * fine).
 */

/** One synthesized import a region needs written into its module. */
export interface HoistedImport {
  /** The `import X from "./y.mx"` statement text. */
  code: string;
  /** The local binding the emitted region references. */
  binding: string;
  /** The module specifier, as written in `code`. */
  specifier: string;
  /**
   * The template's resolved absolute path.
   *
   * Dedupe and authored-import reuse key on this, not on the specifier: two
   * spellings (`./tags/icon.mx`, `./tags/../tags/icon.mx`) are one file and
   * must collapse to one import.
   */
  resolvedPath: string;
}

/** What placing a set of hoisted imports decided. */
export interface HoistPlan {
  /** Statement text to insert, in order. Empty when everything was reused. */
  statements: string[];
  /**
   * Generated binding -> the authored binding it should defer to.
   *
   * Non-empty when the module already imports a tag's file itself: the
   * injected import is dropped and the region's reference is pointed at the
   * author's own name instead.
   */
  renames: Map<string, string>;
}

/** A module's own default import of some file, as the scan records it. */
export interface AuthoredImport {
  /** The specifier as written, for resolving against the module's path. */
  specifier: string;
  /** The local name bound to the default export. */
  local: string;
}

/**
 * Decides which imports to inject and which to reuse.
 *
 * `resolveAuthored` maps an authored import's specifier to the absolute path
 * it refers to, so reuse is keyed on the file rather than on its spelling. It
 * returns null for a specifier this pass cannot resolve to a path (a bare
 * package name, an alias), which then simply never matches a tag unit.
 */
export function planHoistedImports(
  hoisted: readonly HoistedImport[],
  authored: readonly AuthoredImport[],
  resolveAuthored: (specifier: string) => string | null,
): HoistPlan {
  const byPath = new Map<string, string>();
  for (const one of authored) {
    const path = resolveAuthored(one.specifier);
    if (path !== null && !byPath.has(path)) byPath.set(path, one.local);
  }

  const statements: string[] = [];
  const renames = new Map<string, string>();
  for (const entry of hoisted) {
    const reused = byPath.get(entry.resolvedPath);
    if (reused !== undefined) {
      // A second region calling the same tag mints its own binding, so this
      // covers every one of them rather than only the first.
      if (reused !== entry.binding) renames.set(entry.binding, reused);
      continue;
    }
    byPath.set(entry.resolvedPath, entry.binding);
    statements.push(entry.code);
  }
  return { statements, renames };
}
