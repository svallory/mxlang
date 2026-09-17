import { basename } from "node:path";

/**
 * The name a module emitter declares its default export under.
 *
 * `Ir.exportName` is optional because a `.solid.mx` region has no declaration
 * to name, so an emitter that *does* write a module has to assert the half of
 * that contract it relies on. Interpolating it unguarded would emit
 * `export default function undefined(…)` — syntactically valid, and wrong in
 * a way nothing downstream reports.
 */
export function moduleExportName(
  ir: { exportName?: string },
  host: string,
): string {
  if (!ir.exportName) {
    throw new Error(
      `${host}: this IR has no \`exportName\`, so it was lowered as a non-module (a \`.solid.mx\` region). A host that emits a module must set \`Ctx.emitsModule\` before lowering.`,
    );
  }
  return ir.exportName;
}

/**
 * The PascalCase identifier a compiled module's default export is named after.
 *
 * Every host that emits a module names its default export after the file
 * (`icon.mx` -> `Icon`, `table-of.mx` -> `TableOf`), rather than exporting an
 * anonymous function. Two reasons, and the second is the load-bearing one:
 *
 * - A named declaration is what a stack trace, a devtools component label and
 *   a framework's `Component.name` all read.
 * - **A tag's render function is a named declaration, so self-recursion needs
 *   no import** (design invariant §7.5-7). A tag whose template calls its own
 *   name resolves to this binding, in its own module scope. Emitting an
 *   `import Tree from "./tree.mx"` into `tree.mx` itself happens to work under
 *   ESM, but it is a module importing itself to reach a function it already
 *   has.
 *
 * The name is derived, never authored: the basename is split on any run of
 * non-identifier characters, each part capitalized, and the result prefixed
 * `Tag_` if it would not start with an identifier character (`1st.mx` ->
 * `Tag_1st`). The separator keeps a prefixed name distinct from one that
 * derived the same letters on its own — `9.mx` is `Tag_9` while `tag-9.mx`
 * is `Tag9`. An empty or fully-stripped basename yields plain `Tag`, so the
 * result is always a valid identifier.
 *
 * Collisions are the caller's problem to finish: pass `taken` and a colliding
 * name is re-minted with a numeric suffix, which is what the file-level gensym
 * counter is for. A tag unit's own generated names and its export name come
 * from the same file, so they must not land on each other.
 */
export function exportNameFor(
  filename: string,
  taken: (name: string) => boolean = () => false,
): string {
  const stem = basename(filename).replace(/\.[^.]*$/, "");
  // `_` separates words rather than surviving into the name: `my_widget.mx`
  // is `MyWidget`, the same as `my-widget.mx`. `$` is not a word separator —
  // it is an ordinary identifier character an author chose deliberately.
  const parts = stem.split(/[^A-Za-z0-9$]+/).filter(Boolean);
  const pascal = parts
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
  // Prefixed only when the derived name cannot *start* an identifier, and
  // with a separator: `Tag_9` rather than `Tag9`, so `9.mx` and `tag-9.mx`
  // stay distinct names. They are different compilations that never see each
  // other's `Ctx`, so the collision re-mint below cannot separate them — two
  // sibling tag files colliding on one export name would be silent.
  // A basename with nothing usable in it at all (`.mx`) yields plain `Tag`,
  // rather than the bare separator `Tag_`.
  const name =
    pascal === ""
      ? "Tag"
      : /^[A-Za-z_$]/.test(pascal)
        ? pascal
        : `Tag_${pascal}`;

  if (!taken(name)) return name;
  let serial = 2;
  while (taken(`${name}${serial}`)) serial++;
  return `${name}${serial}`;
}
