import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { compile } from "@mxlang/html";

/**
 * Renders a stock `.marko` fixture through `@mxlang/html`, by actually
 * loading the emitted module rather than reconstructing its shape.
 *
 * `@mxlang/html`'s own loaders (the Bun plugin, `@mxlang/vite-plugin`)
 * accept only `.mx` — MX only supports the MX 1.0 subset of Marko syntax, so
 * a real `.marko` filename is never handed to a product entry point. This
 * harness instead reads each fixture's `.marko` file by content and compiles
 * it under a *virtual* sibling `.mx` filename (same directory, so relative
 * imports and `@marko/compiler`'s own `tags/` discovery still resolve
 * exactly as they would for a real `.mx` file there): `compile(source,
 * virtualMxPath)` rather than `compileFile(realMarkoPath)`.
 *
 * Mirrors `marko-compile-stock.ts`'s approach for the real Marko toolchain:
 * copy the whole fixture directory (`tags/` included, so tag discovery finds
 * the same components — Marko's own `scanTagsDir` only discovers files whose
 * *real* extension is `.marko`, so those stay on disk as `.marko` and are
 * read by content, not renamed), compile every `.marko` file's content in
 * place to a sibling `.ts` (named after the virtual `.mx` path, not the real
 * `.marko` one), rewrite each file's own `from "./X.marko"` imports to point
 * at the compiled `.ts` siblings, then `import()` the compiled entry point
 * and call its default export. No parsing of the emitted module's prologue —
 * a change to the import line, the `Input` interface, or the brand no longer
 * breaks this harness the way text-matching the exact shape did (a prologue
 * change to `postEmit` previously reported every fixture as a translator
 * bug).
 *
 * The emitted `escape` import (`from "@mxlang/html"`, a bare workspace
 * specifier) is rewritten to the package's resolved absolute entry point: a
 * bare specifier resolves by walking up from the *importing file* to a
 * `node_modules`, and the scratch copy lives under the OS tmpdir, outside
 * this repo's `node_modules` ancestry, so it would otherwise fail to
 * resolve. Only the specifier is touched — a plain string substitution on
 * one known import, not a regex over the module's shape.
 */
export async function renderTranslator(
  dir: string,
  filename: string,
  input: unknown,
): Promise<string> {
  const escapeEntry = require.resolve("@mxlang/html");
  const scratch = mkdtempSync(join(tmpdir(), "mx-oracle-translator-"));
  try {
    cpSync(dir, scratch, { recursive: true });

    for (const file of markoFiles(scratch)) {
      // Feed content under the virtual `.mx` sibling path — never the real
      // `.marko` filename — so the compiled module is produced exactly as
      // a real `.mx` file in this position would be.
      const source = readFileSync(file, "utf8");
      const virtualMxPath = withMxExtension(file);
      const { code } = compile(source, virtualMxPath);
      const rewritten = code
        .replace(
          /(from\s+")(\.[^"]+)\.(?:marko|mx)(")/g,
          (_match, prefix, path, suffix) => `${prefix}${path}.ts${suffix}`,
        )
        .replace('from "@mxlang/html"', `from ${JSON.stringify(escapeEntry)}`);

      writeFileSync(withTsExtension(file), rewritten);
    }

    const entry = withTsExtension(join(scratch, relative(dir, filename)));
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (input: unknown) => string;
    };
    return mod.default(input);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Every `.marko` file under `dir`, including `tags/`.
 *
 * `tags/` entries stay real `.marko` files on disk (Marko's own tag
 * discovery requires it — see the module doc comment); every other fixture
 * `.marko` file is read by content and compiled under a virtual `.mx`
 * sibling name, never by its real `.marko` path.
 */
function markoFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...markoFiles(full));
    } else if (/\.marko$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

function withMxExtension(file: string): string {
  return file.replace(/\.marko$/, ".mx");
}

function withTsExtension(file: string): string {
  return file.replace(/\.marko$/, ".ts");
}
