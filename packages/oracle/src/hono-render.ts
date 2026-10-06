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
import { compileHonoFile } from "@mxlang/hono";
import { discoveredCustomTags, mxTwins } from "./mx-twins.ts";

/** Compile a fixture tree to Hono JSX TSX and render its entry with `hono/jsx`. */
export async function renderHono(
  dir: string,
  filename: string,
  input: unknown,
): Promise<string> {
  const { jsx } = (await import("hono/jsx")) as {
    jsx: (
      type: unknown,
      props: Record<string, unknown>,
    ) => { toString(): string | Promise<string> };
  };
  const scratch = mkdtempSync(join(tmpdir(), "mx-oracle-hono-"));

  try {
    cpSync(dir, scratch, { recursive: true });
    mxTwins(scratch);
    linkNodeModules(scratch);

    for (const file of markoFiles(scratch)) {
      const { code } = compileHonoFile(file, {
        customTags: discoveredCustomTags(file),
      });
      const rewritten = code
        .replace(
          /(from\s+")(\.[^"]+)\.(?:marko|mx)(")/g,
          (_match: string, prefix: string, path: string, suffix: string) =>
            `${prefix}${path}.tsx${suffix}`,
        )
        .replace(
          '"@mxlang/hono/runtime"',
          JSON.stringify(require.resolve("@mxlang/hono/runtime")),
        );
      writeFileSync(withTsxExtension(file), rewritten);
    }

    const entry = withTsxExtension(
      join(scratch, relative(dir, filename.replace(/\.marko$/, ".mx"))),
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (props: Record<string, unknown>) => unknown;
    };
    const element = jsx(mod.default, input as Record<string, unknown>);
    const html = element.toString();
    return typeof html === "string" ? html : await html;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function linkNodeModules(scratch: string): void {
  const repoNodeModules = dirname(
    dirname(require.resolve("hono/package.json")),
  );
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "mx-oracle-hono-scratch", type: "module" }),
  );
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" },
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
