import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkExtensionRoot } from "./check-vsix";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

interface Options {
  plugins?: string[];
  files?: string[];
}

/** Builds a fake unpacked extension root; every `files` path is an empty file. */
function extension({
  plugins = ["@mxlang/typescript-plugin"],
  files = [],
}: Options) {
  const root = mkdtempSync(join(tmpdir(), "check-vsix-test-"));
  roots.push(root);
  const write = (path: string, contents = "") => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  write(
    "package.json",
    JSON.stringify({
      contributes: {
        typescriptServerPlugins: plugins.map((name) => ({ name })),
      },
    }),
  );
  for (const file of files) write(file);
  return root;
}

const pluginFiles = (extra: string[] = []) => [
  "node_modules/@mxlang/typescript-plugin/package.json",
  "node_modules/@mxlang/typescript-plugin/dist/index.cjs",
  ...extra,
];
const runtimeFiles = [
  "node_modules/@marko/compiler/package.json",
  "node_modules/@marko/compiler/index.js",
  "node_modules/@astrojs/compiler/package.json",
  "node_modules/@astrojs/compiler/sync.js",
];

function builtDist(names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "check-vsix-dist-"));
  roots.push(dir);
  for (const name of names) writeFileSync(join(dir, name), "");
  return dir;
}

const manifests = (root: string) => {
  // Resolution needs real manifests, so give each fixture package one.
  for (const [dir, main, exports] of [
    ["@mxlang/typescript-plugin", "dist/index.cjs"],
    ["@marko/compiler", "index.js"],
    ["@astrojs/compiler", "sync.js", { "./sync": "./sync.js" }],
  ] as const) {
    try {
      writeFileSync(
        join(root, "node_modules", dir, "package.json"),
        JSON.stringify({ name: dir, main, exports }),
      );
    } catch {}
  }
  return root;
};

describe("checkExtensionRoot", () => {
  it("passes a root that ships the plugin and its runtime requires", () => {
    const root = manifests(
      extension({ files: [...pluginFiles(), ...runtimeFiles] }),
    );
    expect(checkExtensionRoot(root, builtDist(["index.cjs"]))).toEqual([]);
  });

  it("fails when the plugin is not shipped (today's main)", () => {
    const problems = checkExtensionRoot(extension({}), undefined);
    expect(problems).toEqual([
      expect.stringContaining('"@mxlang/typescript-plugin" does not resolve'),
    ]);
  });

  it("fails when a declared plugin is missing even if another resolves", () => {
    const root = manifests(
      extension({
        plugins: ["@mxlang/typescript-plugin", "@mxlang/other"],
        files: [...pluginFiles(), ...runtimeFiles],
      }),
    );
    const problems = checkExtensionRoot(root, undefined);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("@mxlang/other");
  });

  it("fails when the manifest declares no plugin at all", () => {
    expect(checkExtensionRoot(extension({ plugins: [] }), undefined)).toEqual([
      "package.json declares no typescriptServerPlugins",
    ]);
  });

  it("fails when a dist file the plugin build emits is not shipped", () => {
    const root = manifests(
      extension({ files: [...pluginFiles(), ...runtimeFiles] }),
    );
    const problems = checkExtensionRoot(
      root,
      builtDist(["index.cjs", "ng-worker.cjs"]),
    );
    expect(problems).toEqual([
      '"@mxlang/typescript-plugin" is missing dist/ng-worker.cjs',
    ]);
  });

  it("ignores non-.cjs build output such as declarations", () => {
    const root = manifests(
      extension({ files: [...pluginFiles(), ...runtimeFiles] }),
    );
    expect(
      checkExtensionRoot(root, builtDist(["index.cjs", "index.d.ts"])),
    ).toEqual([]);
  });

  it("fails when a runtime require of the plugin does not resolve", () => {
    const root = manifests(extension({ files: pluginFiles() }));
    const problems = checkExtensionRoot(root, undefined);
    expect(problems).toEqual([
      expect.stringContaining("@marko/compiler"),
      expect.stringContaining("@astrojs/compiler/sync"),
    ]);
  });

  it.each(["@angular/compiler-cli", "typescript"])(
    "fails when %s is shipped",
    (name) => {
      const root = manifests(
        extension({
          files: [
            ...pluginFiles(),
            ...runtimeFiles,
            `node_modules/${name}/package.json`,
          ],
        }),
      );
      expect(checkExtensionRoot(root, undefined)).toEqual([
        expect.stringContaining(`${name} must not be shipped`),
      ]);
    },
  );
});
