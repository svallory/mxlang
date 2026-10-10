import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mxHtmlResolve } from "./html-resolve.ts";

type Resolve = (id: string, importer?: string) => string | null | undefined;

function resolveIn(): Resolve {
  const plugin = mxHtmlResolve();
  const hook = plugin.resolveId as Resolve;
  return (id, importer) => hook.call({}, id, importer);
}

/**
 * An isolated install: a project whose `node_modules` holds `@mxlang/host-astro`
 * and nothing else, as `bun add -d @mxlang/host-astro` leaves it.
 */
function isolatedProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-isolated-")));
  mkdirSync(join(root, "node_modules", "@mxlang"), { recursive: true });
  symlinkSync(
    fileURLToPath(new URL("..", import.meta.url)),
    join(root, "node_modules", "@mxlang", "host-astro"),
  );
  mkdirSync(join(root, "src", "pages"), { recursive: true });
  writeFileSync(join(root, "src", "pages", "index.mx.tsx"), "");
  return root;
}

describe("mxHtmlResolve", () => {
  it("premise: @mxlang/target-html is not resolvable from an isolated project", () => {
    const root = isolatedProject();
    const fromUser = createRequire(join(root, "src", "pages", "index.mx.tsx"));
    expect(() => fromUser.resolve("@mxlang/target-html")).toThrow();
  });

  it("resolves @mxlang/target-html for a compiled .mx module from this package's dependency", () => {
    const root = isolatedProject();
    const importer = join(root, "src", "pages", "index.mx.tsx");
    const resolve = resolveIn();
    expect(resolve("@mxlang/target-html", importer)).toMatch(
      /targets\/html\/dist\/index\.js$/,
    );
  });

  it("resolves subpaths such as @mxlang/target-html/runtime", () => {
    const resolve = resolveIn();
    expect(resolve("@mxlang/target-html/runtime", "/p/src/a.mx.tsx")).toMatch(
      /targets\/html\/dist\/runtime\.js$/,
    );
  });

  it("defers (null) instead of throwing when the package cannot resolve the id", () => {
    expect(
      resolveIn()("@mxlang/target-html/not-exported", "/p/src/a.mx.tsx"),
    ).toBeNull();
  });

  it.each([
    ["an .astro.mx importer", "@mxlang/target-html", "/p/src/a.astro.mx", true],
  ])("answers %s", (_name, id, importer) => {
    expect(resolveIn()(id, importer)).toMatch(
      /targets\/html\/dist\/index\.js$/,
    );
  });

  it.each([
    ["a plain .ts importer", "@mxlang/target-html", "/p/src/a.ts"],
    ["a .astro importer", "@mxlang/target-html", "/p/src/a.astro"],
    ["no importer", "@mxlang/target-html", undefined],
    ["a different package", "@mxlang/html-foo", "/p/src/a.mx.tsx"],
    ["another scope", "@other/html", "/p/src/a.mx.tsx"],
    ["a relative id", "./html", "/p/src/a.mx.tsx"],
  ])("declines %s", (_name, id, importer) => {
    expect(resolveIn()(id, importer)).toBeNull();
  });
});
