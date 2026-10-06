import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { compilePreactFile } from "@mxlang/preact";
import { discoveredCustomTags, mxTwins } from "./mx-twins.ts";

/**
 * Renders a stock `.marko` fixture through `@mxlang/preact`, by loading the
 * emitted component module and handing it to `preact-render-to-string`.
 *
 * The same shape as `translator-render.ts`'s harness for the string host, and
 * for the same reasons: copy the whole fixture directory (`tags/` included, so
 * tag discovery finds the same components), compile every `.marko`/`.mx` file
 * in place to a sibling module, rewrite each file's own `from "./X.marko"`
 * imports to point at the compiled siblings, then `import()` the entry point.
 *
 * Two differences from that harness, both forced by the target:
 *
 * - The compiled sibling is `.tsx`, not `.ts` — this host emits JSX.
 * - The scratch directory gets a `tsconfig.json` and a `package.json` of its
 *   own. The emitted module carries `/** @jsxImportSource preact *\/`, which
 *   Bun honours per file, but the bare `preact` and `preact/jsx-runtime`
 *   specifiers still have to resolve: the copy lives under the OS tmpdir,
 *   outside this repo's `node_modules` ancestry. A `node_modules` symlink
 *   pointing back at the repo's own is what makes them resolve, exactly as the
 *   string harness rewrites its one `@mxlang/html` specifier to an absolute
 *   path for the same reason.
 */
export async function renderPreact(
  dir: string,
  filename: string,
  input: unknown,
): Promise<string> {
  const { render } = (await import("preact-render-to-string")) as {
    render: (vnode: unknown) => string;
  };
  const { h } = (await import("preact")) as {
    h: (type: unknown, props: unknown) => unknown;
  };

  const scratch = mkdtempSync(join(tmpdir(), "mx-oracle-preact-"));
  try {
    cpSync(dir, scratch, { recursive: true });
    mxTwins(scratch);
    linkNodeModules(scratch);

    for (const file of markoFiles(scratch)) {
      const { code } = compilePreactFile(file, {
        customTags: discoveredCustomTags(file),
      });
      const rewritten = code
        .replace(
          /(from\s+")(\.[^"]+)\.(?:marko|mx)(")/g,
          (_match: string, prefix: string, path: string, suffix: string) =>
            `${prefix}${path}.tsx${suffix}`,
        )
        // The emitted `<try>`/`class` helpers import from this package's own
        // runtime entry, a bare workspace specifier. Bare resolution walks up
        // from the importing file, and the scratch copy lives under the OS
        // tmpdir — outside this repo's `node_modules` ancestry — so the one
        // known specifier is rewritten to the resolved absolute path, exactly
        // as `translator-render.ts` does for `@mxlang/html`'s `escape`.
        .replace(
          '"@mxlang/preact/runtime"',
          JSON.stringify(require.resolve("@mxlang/preact/runtime")),
        );

      writeFileSync(withTsxExtension(file), rewritten);
    }

    const entry = withTsxExtension(
      join(scratch, relative(dir, filename.replace(/\.marko$/, ".mx"))),
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (input: unknown) => unknown;
    };
    return render(h(mod.default, input));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Points the scratch copy at this repo's `node_modules`.
 *
 * A symlink rather than a copy: the emitted modules import `preact` and
 * `preact/jsx-runtime` by bare specifier, and bare resolution walks up from
 * the importing file looking for `node_modules` — which the OS tmpdir has
 * none of.
 */
function linkNodeModules(scratch: string): void {
  const repoNodeModules = dirname(
    dirname(require.resolve("preact/package.json")),
  );
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "mx-oracle-preact-scratch", type: "module" }),
  );
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
    }),
  );
  require("node:fs").symlinkSync(
    repoNodeModules,
    join(scratch, "node_modules"),
    "dir",
  );
}

/** Every `.marko`/`.mx` file under `dir`, including `tags/`. */
function markoFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      results.push(...markoFiles(full));
    } else if (/\.(?:marko|mx)$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

function withTsxExtension(file: string): string {
  return file.replace(/\.(?:marko|mx)$/, ".tsx");
}
