/**
 * A `tags/` file the caller's host cannot call.
 *
 * MX's own scan (`scan.ts`) indexes flat `tags/x.mx` and `tags/x.tag.ts`
 * files only. Marko's scan also finds `tags/x.marko` and `tags/x/index.*`, but
 * a host that has no Marko taglib lookup (Solid, Astro, a `.<host>.mx`
 * region, Angular) never asks it. A call to `<x>` with such a file beside it
 * used to compile as the native element `<x>`, silently, so the author saw
 * unstyled markup instead of the component they wrote the file for. This
 * module finds that file so lowering can say so.
 *
 * It is a diagnostic, not a resolution: it never makes the tag callable.
 * Host-neutral on purpose; the caller decides which names reach it.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const TAGS_DIR = "tags";
const TAG_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** `tags/<name>/index.<ext>`: a directory tag, in any of the template/module forms. */
const INDEX_FILE = /^index\.(?:marko|mx|tag\.ts)$/;

export interface UncalledTagFile {
  /** Absolute path of the file found. */
  file: string;
  /** `flat`: `tags/x.marko`. `index`: `tags/x/index.<ext>`. */
  shape: "flat" | "index";
}

/**
 * Looks, from `filename`'s directory up to the nearest `package.json`, for a
 * `tags/<name>.marko` or `tags/<name>/index.*` file; the nearest wins.
 * Returns `undefined` when there is none (the common case: one `existsSync`
 * per ancestor directory).
 */
export function findUncalledTagFile(
  filename: string,
  name: string,
): UncalledTagFile | undefined {
  if (!TAG_NAME.test(name)) return undefined;
  let dir = dirname(resolve(filename));
  for (;;) {
    const tags = join(dir, TAGS_DIR);
    const flat = join(tags, `${name}.marko`);
    if (existsSync(flat)) return { file: flat, shape: "flat" };
    const own = join(tags, name);
    if (existsSync(own)) {
      let entries: string[] = [];
      try {
        entries = readdirSync(own).sort();
      } catch {
        // Not a directory (a file named like the tag): nothing to report.
      }
      const index = entries.find((entry) => INDEX_FILE.test(entry));
      if (index) return { file: join(own, index), shape: "index" };
    }
    if (existsSync(join(dir, "package.json"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The diagnostic text: the file found, and why this host cannot call it. */
export function uncalledTagFileMessage(
  filename: string,
  name: string,
  found: UncalledTagFile,
): string {
  const shown = relative(dirname(resolve(filename)), found.file);
  return `\`<${name}>\` matches \`${shown}\`, which this host cannot call: MX calls flat \`tags/<name>.mx\` files here, and this host does not resolve a \`tags/<name>/\` directory. It would compile as the native element \`<${name}>\`. Write the tag as \`tags/${name}.mx\`, or import it explicitly.`;
}

/**
 * The one diagnostic for a `.marko` file used as a tag (decision 172): the
 * same text on every target, whichever lookup, import or `tags/` shape led to
 * it. `.marko` is not an MX input, so it is never compiled, never a native
 * element and never an emitted import.
 */
export function markoFileTagMessage(
  filename: string,
  name: string,
  file: string,
): string {
  const shown = relative(dirname(resolve(filename)), file);
  const mx = shown.replace(/\.marko$/, ".mx");
  return `\`<${name}>\` resolves to \`${shown}\`, a \`.marko\` file, and MX does not compile \`.marko\` files. Convert it to \`.mx\` (\`${mx}\`).`;
}
