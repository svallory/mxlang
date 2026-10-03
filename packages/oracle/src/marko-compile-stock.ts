import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFile } from "@marko/compiler";
import * as translator from "marko/translator";

/**
 * Renders a *stock* `.marko` fixture through the real Marko 6 toolchain, for
 * `oracle:marko`'s one table (decision 68 collapsed the old two-table
 * mx-html-vs-translator comparison to this single stock-Marko one; the `.mx`
 * dialect and its own compile path are retired).
 *
 * These fixtures are already `.marko`, so nothing is renamed and no import is
 * rewritten to a different extension. What still has to happen is compiling
 * each file ahead of time to a sibling `.mjs` — Marko's loader cannot compile
 * a `.marko` file reached through a plain `import` — and pointing the
 * fixture's own imports at those compiled modules.
 *
 * The whole fixture directory is copied, `tags/` included, so Marko's own tag
 * discovery finds the same components the translator does.
 */
export async function renderStockMarko(
  fixtureDir: string,
  input: unknown,
): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "mx-oracle-stock-"));
  cpSync(fixtureDir, scratch, { recursive: true });

  for (const relative of markoFiles(scratch)) {
    const compiled = await compileFile(join(scratch, relative), {
      translator,
      output: "html",
      modules: "esm",
      // Without this, Marko emits resume/hydration markers even for a pure
      // server-html render. It does not suppress them entirely, which is why
      // `normalize-html.ts` still strips a trailing marker before comparing.
      optimize: true,
    });
    // A component is imported by its `.marko` path but must resolve to the
    // module actually compiled beside it.
    writeFileSync(
      join(scratch, `${relative.slice(0, -".marko".length)}.mjs`),
      pinBareSpecifiers(
        compiled.code.replace(/(from\s+")([^"]+)\.marko(")/g, "$1$2.mjs$3"),
      ),
    );
  }

  const mod = (await import(join(scratch, "input.mjs"))) as {
    default: { render: (input: unknown) => { toString(): string } | string };
  };
  const rendered = mod.default.render(input);
  return typeof rendered === "string" ? rendered : String(await rendered);
}

/**
 * Rewrites every bare `from "marko/…"` / `from "@marko/…"` specifier to the
 * absolute path it resolves to *from this package*. The scratch copy lives
 * under the OS tmpdir, which has no `node_modules` ancestor, so a bare
 * specifier there falls through to Bun's auto-install and fetches
 * `marko@latest` instead of the pinned runtime the translator was built
 * against (6.4.x lacks `_serialize_if`, which 6.3.51's translator emits).
 * Resolving up front keeps the scratch dir hermetic; relative specifiers
 * (`./x.mjs`) are left alone.
 */
function pinBareSpecifiers(code: string): string {
  return code.replace(
    /(\bfrom\s*|\bimport\s*)"((?:marko|@marko)(?:\/[^"]*)?)"/g,
    (_match, prefix: string, specifier: string) =>
      `${prefix}${JSON.stringify(fileURLToPath(import.meta.resolve(specifier)))}`,
  );
}

/** Every `.marko` file in the fixture, including those under `tags/`. */
function markoFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const nested of readdirSync(join(root, entry.name))) {
        if (nested.endsWith(".marko")) found.push(join(entry.name, nested));
      }
      continue;
    }
    if (entry.name.endsWith(".marko")) found.push(entry.name);
  }
  // A component must be compiled before the template importing it is loaded,
  // and `tags/`-discovered components are the leaves here, so deepest first.
  return found.sort((a, b) => b.split("/").length - a.split("/").length);
}

void existsSync;
