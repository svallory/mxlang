import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { compileReactFile } from "@mxlang/host-react";
import type { ComponentType } from "react";
import { discoveredCustomTags, mxTwins } from "./mx-twins.ts";

/** Compile a fixture tree to React TSX and render its entry with React DOM. */
export async function renderReact(
  dir: string,
  filename: string,
  input: unknown,
): Promise<string> {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const scratch = mkdtempSync(join(tmpdir(), "mx-oracle-react-"));

  try {
    cpSync(dir, scratch, { recursive: true });
    mxTwins(scratch);
    linkNodeModules(scratch);

    for (const file of markoFiles(scratch)) {
      const { code } = compileReactFile(file, {
        customTags: discoveredCustomTags(file),
      });
      const rewritten = code
        .replace(
          /(from\s+")(\.[^"]+)\.(?:marko|mx)(")/g,
          (_match: string, prefix: string, path: string, suffix: string) =>
            `${prefix}${path}.tsx${suffix}`,
        )
        .replace(
          '"@mxlang/host-react/runtime"',
          JSON.stringify(require.resolve("@mxlang/host-react/runtime")),
        );
      writeFileSync(withTsxExtension(file), rewritten);
    }

    const entry = withTsxExtension(
      join(scratch, relative(dir, filename.replace(/\.marko$/, ".mx"))),
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: ComponentType<Record<string, unknown>>;
    };
    return stripReactResourceHints(
      renderToStaticMarkup(
        createElement(mod.default, input as Record<string, unknown>),
      ),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * React 19 hoists an image preload ahead of static markup for each eligible
 * `<img>`. That resource hint is renderer-added transport metadata, not a node
 * authored by the MX fixture, so it is outside the structural parity claim.
 */
export function stripReactResourceHints(html: string): string {
  return html.replace(
    /^(?:<link\b(?=[^>]*\brel="preload")(?=[^>]*\bas="image")[^>]*\/>)+/,
    "",
  );
}

function linkNodeModules(scratch: string): void {
  const repoNodeModules = dirname(
    dirname(require.resolve("react/package.json")),
  );
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "mx-oracle-react-scratch", type: "module" }),
  );
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
    }),
  );
  symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
}

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
