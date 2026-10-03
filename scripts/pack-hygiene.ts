// Shared helpers for the packaging-hygiene checks: `pack-hygiene.test.ts`
// (tarball contents + bare specifiers, default unit run) and `pack-probe.ts`
// (skipLibCheck:false consumer probe, run from `verify`).
//
// The defect class (G8, PR #174): a package whose tarball ships the wrong
// files, or whose emitted `.d.ts` imports a module the package never declares,
// typechecks fine in the workspace and breaks for the first real consumer.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { bakedPathsIn } from "./baked-paths.ts";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface PackageJson {
  name: string;
  private?: boolean;
  main?: string;
  types?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export interface PackedPackage {
  /** npm name. */
  name: string;
  /** Workspace-relative directory. */
  dir: string;
  /** Top-level paths (besides `dist/`) the tarball may contain. */
  extraTopLevel: string[];
  /**
   * When set, the exact `dist/` files the tarball may contain (paths relative
   * to the package). A stray build entry (a dev-only script, an example) then
   * fails instead of shipping unnoticed.
   */
  distFiles?: string[];
  /** True when the package emits `.d.ts` (a `types` entry, `dist/**.d.ts`). */
  declarations: boolean;
  /**
   * Bare specifiers in the shipped `.d.ts` that are satisfied by a package
   * other than their own name. Every entry needs a comment saying why.
   */
  specifierAliases?: Record<string, string>;
}

/** The packages that ship a tarball (or would, once `private` is lifted). */
export const PACKED_PACKAGES: PackedPackage[] = [
  {
    name: "@mxlang/core",
    dir: "packages/core",
    extraTopLevel: [],
    declarations: true,
  },
  {
    name: "@mxlang/parser",
    dir: "packages/parser",
    extraTopLevel: [],
    declarations: true,
  },
  {
    name: "@mxlang/html",
    dir: "packages/hosts/html",
    extraTopLevel: ["types"],
    distFiles: [
      "dist/bun.d.ts",
      "dist/bun.js",
      "dist/compiler.d.ts",
      "dist/descriptor.d.ts",
      "dist/descriptor.js",
      "dist/emitter.d.ts",
      "dist/helpers.d.ts",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/translate.d.ts",
    ],
    declarations: true,
    specifierAliases: {
      // `dist/bun.d.ts` has `import type { BunPlugin } from "bun"`. The `bun`
      // module's types come from `@types/bun`, declared as an OPTIONAL peer:
      // only a consumer of the `./bun` subpath runs Bun and has it.
      bun: "@types/bun",
    },
  },
  {
    name: "@mxlang/angular",
    dir: "packages/hosts/angular",
    extraTopLevel: [],
    declarations: true,
  },
  {
    name: "@mxlang/angular-checker",
    dir: "packages/tooling/angular-checker",
    extraTopLevel: [],
    declarations: true,
  },
  {
    name: "@mxlang/typescript-plugin",
    dir: "packages/tooling/typescript-plugin",
    extraTopLevel: [],
    distFiles: [
      // The Angular worker declarations must never ship: ng-worker.ts is
      // excluded from the declaration emit and build/strip-ng-declarations.ts
      // removes ng-diagnostics.d.ts (its types reach the devDependency
      // @mxlang/angular-checker and @angular/compiler-cli). A stray
      // ng-*.d.ts here means the strip stopped running. file-kinds.d.ts is
      // stripped too: its registry-private pipeline types must not ship.
      "dist/amx-language.d.ts",
      "dist/astro-language.d.ts",
      "dist/failed-module-stub.d.ts",
      "dist/host-policy-diagnostics.d.ts",
      "dist/index.cjs",
      "dist/index.d.ts",
      "dist/language.d.ts",
      "dist/mx-language.d.ts",
      "dist/ng-worker.cjs",
      "dist/own-location-header.d.ts",
    ],
    declarations: true,
  },
  {
    name: "@mxlang/language-server",
    dir: "packages/tooling/language-server",
    extraTopLevel: [],
    declarations: true,
  },
  // A CLI bundle only: `bun build` emits no declarations, so there is no `types`.
  {
    name: "@mxlang/tsc",
    dir: "packages/tooling/tsc",
    extraTopLevel: [],
    declarations: false,
  },
];

export function pkgDirOf(p: PackedPackage): string {
  return join(repoRoot, p.dir);
}

export function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/** The paths `bun pm pack` would put in the tarball, without writing one. */
export function packedFiles(dir: string): string[] {
  if (!existsSync(join(dir, "dist"))) {
    throw new Error(
      `${dir}/dist is missing: run \`bun run build\` first (the tarball is only meaningful after a build)`,
    );
  }
  const out = execFileSync("bun", ["pm", "pack", "--dry-run"], {
    cwd: dir,
    encoding: "utf8",
  });
  return [...out.matchAll(/^packed\s+\S+\s+(.+)$/gm)].map((m) =>
    (m[1] ?? "").trim(),
  );
}

/**
 * Packed files that bake the machine they were built on: a `file:///` literal
 * or the build root. Bun's CJS output inlines `import.meta.url` as the build
 * machine's absolute URL, so a `createRequire(import.meta.url)` resolved from
 * the build tree instead of the installed package (see
 * `scripts/bundled-build.ts`). Only text files are read.
 */
export function bakedBuildPaths(
  dir: string,
  packed: string[],
  root: string = repoRoot,
): string[] {
  return packed
    .filter((f) => /\.(c|m)?js$/.test(f))
    .filter(
      (f) => bakedPathsIn(readFileSync(join(dir, f), "utf8"), root).length > 0,
    );
}

/** Every string a `main`/`types`/`bin`/`exports` field points at, as a tarball path. */
export function entryTargets(pkg: PackageJson): string[] {
  const targets: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string") targets.push(posix.normalize(v));
    else if (v && typeof v === "object")
      for (const x of Object.values(v)) add(x);
  };
  add(pkg.main);
  add(pkg.types);
  add(pkg.bin);
  add(pkg.exports);
  return [...new Set(targets)];
}

/** Missing JS entry artifacts: a successful bundler exit alone proves nothing. */
export function missingRuntimeEntries(dir: string, pkg: PackageJson): string[] {
  return entryTargets(pkg).filter(
    (entry) => /\.(?:m|c)?js$/.test(entry) && !existsSync(join(dir, entry)),
  );
}

/** The `exports` subpaths as import specifiers (`@mxlang/html`, `@mxlang/html/bun`). */
export function exportSpecifiers(pkg: PackageJson): string[] {
  const exp = pkg.exports;
  if (!exp || typeof exp !== "object") return [pkg.name];
  const keys = Object.keys(exp);
  // A conditions-only map (`{ types, default }`) is the root export.
  if (!keys.some((k) => k.startsWith("."))) return [pkg.name];
  return keys.map((k) => (k === "." ? pkg.name : `${pkg.name}/${k.slice(2)}`));
}

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

export interface SpecifierRef {
  specifier: string;
  file: string;
}

/**
 * Every module specifier a declaration file refers to: `import`/`export … from`,
 * `import x = require()`, `import("x")` types, and `/// <reference types|path>`.
 */
export function moduleSpecifiers(file: string): SpecifierRef[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const refs: SpecifierRef[] = [];
  const push = (specifier: string) => refs.push({ specifier, file });
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      push(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const ref of sf.typeReferenceDirectives) push(ref.fileName);
  for (const ref of sf.referencedFiles) push(ref.fileName);
  return refs;
}

export function isBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return builtinModules.includes(packageNameOf(specifier));
}

/** All `.d.ts` files under `dir` (absolute paths). */
export function declarationFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".d.ts")) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** A relative specifier in `file` that resolves outside `root`. */
export function escapesRoot(
  file: string,
  specifier: string,
  root: string,
): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(file), specifier);
  return target !== root && !target.startsWith(`${root}/`);
}

/** Names a package must declare (dependencies or peers) for `specifier` to resolve. */
export function declaredNames(pkg: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

/** Shipped runtime files under `<dir>/<distRel>` (`.js`, `.mjs`, `.cjs`). */
export function runtimeFiles(dir: string, distRel = "dist"): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:m|c)?js$/.test(name)) out.push(p);
    }
  };
  const root = join(dir, distRel);
  if (existsSync(root)) walk(root);
  return out.sort();
}

/**
 * Every module specifier a runtime file loads: `import`/`export … from`,
 * `import("x")` and `require("x")` with a literal argument.
 */
export function runtimeSpecifiers(file: string): SpecifierRef[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const refs: SpecifierRef[] = [];
  const push = (specifier: string) => refs.push({ specifier, file });
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0] as ts.Expression)
    ) {
      push((node.arguments[0] as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

/**
 * Bare imports in the shipped runtime that the package does not declare
 * (dependency or peer), as `relative/file: specifier`. Node builtins, relative
 * paths and the package's own name (`@mxlang/angular/runtime`) are fine. There
 * is no allowlist: a runtime import with no declaration installs fine and
 * throws `Cannot find module` on first use.
 */
export function undeclaredRuntimeImports(
  dir: string,
  pkg: PackageJson,
  selfName: string,
  distRel = "dist",
): string[] {
  const declared = declaredNames(pkg);
  const bad: string[] = [];
  for (const file of runtimeFiles(dir, distRel)) {
    for (const { specifier } of runtimeSpecifiers(file)) {
      if (specifier.startsWith(".") || isBuiltin(specifier)) continue;
      const name = packageNameOf(specifier);
      if (name === selfName || declared.has(name)) continue;
      bad.push(`${file.slice(dir.length + 1)}: ${specifier}`);
    }
  }
  return bad;
}
