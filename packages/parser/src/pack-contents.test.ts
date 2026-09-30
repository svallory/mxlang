import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
  main: string;
  types: string;
  files?: string[];
};

/** The paths `bun pm pack` would put in the tarball, without writing one. */
function packedFiles(): string[] {
  const out = execFileSync("bun", ["pm", "pack", "--dry-run"], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  return [...out.matchAll(/^packed\s+\S+\s+(.+)$/gm)].map((m) =>
    (m[1] ?? "").trim(),
  );
}

/** Names a declaration file exports at its top level (or inside its one ambient module). */
function exportedNames(file: string): string[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  const visit = (statements: readonly ts.Statement[]) => {
    for (const s of statements) {
      if (ts.isModuleDeclaration(s) && s.body && ts.isModuleBlock(s.body)) {
        visit(s.body.statements);
        continue;
      }
      const exported = ts
        .getModifiers(s as ts.HasModifiers)
        ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) names.add(d.name.text);
        }
      } else if (
        (ts.isFunctionDeclaration(s) ||
          ts.isInterfaceDeclaration(s) ||
          ts.isTypeAliasDeclaration(s) ||
          ts.isClassDeclaration(s)) &&
        s.name
      ) {
        names.add(s.name.text);
      }
    }
  };
  visit(sf.statements);
  return [...names].sort();
}

describe("@mxlang/parser tarball", () => {
  it("declares a `files` allowlist", () => {
    expect(pkg.files).toEqual(["dist", "README.md"]);
  });

  it("packs only dist/, README, LICENSE and package.json", () => {
    const stray = packedFiles().filter(
      (f) =>
        !f.startsWith("dist/") &&
        !["package.json", "README.md", "LICENSE"].includes(f),
    );
    expect(stray).toEqual([]);
  });

  it("packs the files `main` and `types` point at", () => {
    const packed = packedFiles();
    expect(packed).toContain(pkg.main);
    expect(packed).toContain(pkg.types);
    expect(pkg.types.startsWith("dist/")).toBe(true);
  });
});

describe("@mxlang/parser emitted declarations", () => {
  it("export exactly what src/public.d.ts exports", () => {
    const emitted = join(pkgDir, pkg.types);
    expect(existsSync(emitted)).toBe(true);
    expect(exportedNames(emitted)).toEqual(
      exportedNames(join(pkgDir, "src/public.d.ts")),
    );
  });

  it("are a real module, not an ambient `declare module` block", () => {
    const text = readFileSync(join(pkgDir, pkg.types), "utf8");
    expect(text).not.toMatch(/^declare module /m);
  });
});
