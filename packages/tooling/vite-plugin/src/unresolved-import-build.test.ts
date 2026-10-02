import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import mx from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Inside the package, not `tmpdir()`: a compiled page imports `@mxlang/html`
// by bare specifier, which only resolves from within the package tree.
const root = mkdtempSync(join(here, "..", ".tmp-unresolved-import-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Error text is asserted ANSI-stripped: CI colorizes Babel frames.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
const ANSI = /\u001b\[[0-9;]*m/g;
const STACK_FRAME = /^\s+at\s/m;

type Wrapped = Error & {
  id?: string;
  frame?: string;
  loc?: { file: string; line: number; column: number };
};

function write(project: string, rel: string, source: string): string {
  const path = join(root, project, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function html(project: string): void {
  host(project, "html");
}

function host(project: string, name: string): void {
  write(
    project,
    "package.json",
    JSON.stringify({ name: "p", mx: { host: name } }),
  );
}

/** `vite build` of one page as an SSR bundle; resolves to the error, if any. */
async function buildError(
  project: string,
  entry: string,
): Promise<Wrapped | undefined> {
  const projectRoot = join(root, project);
  try {
    await build({
      root: projectRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [mx()],
      build: {
        ssr: join(projectRoot, entry),
        outDir: join(projectRoot, "dist"),
        emptyOutDir: true,
        minify: false,
      },
    });
  } catch (err) {
    return err as Wrapped;
  }
  return undefined;
}

const plain = (text: string): string => text.replace(ANSI, "");

/**
 * Compact and located at the authored line:col, and never the generated file.
 * `column` is 0-based, like every `loc` this plugin raises, and a build prints
 * it as is. A `vite build` error also carries vite's own aggregate stack
 * (`Build failed with 1 error`), which this plugin cannot shorten, so a build
 * is checked on its message; the dev server raises the plugin's error itself,
 * whose stack is only `Error: message`.
 */
function expectLocated(
  error: Wrapped | undefined,
  at: { line: number; column: number; specifier: string },
  via: "build" | "dev",
): void {
  expect(error).toBeInstanceOf(Error);
  const err = error as Wrapped;
  const text = plain(`${err.message}\n${err.frame ?? ""}`);
  expect(text).toContain(`Could not resolve "${at.specifier}"`);
  expect(text).not.toContain(".mx.tsx");
  expect(plain(err.stack ?? "")).not.toContain(".mx.tsx");
  if (via === "build") {
    expect(plain(err.message)).toContain(`page.mx:${at.line}:${at.column}\n`);
  } else {
    expect(plain(err.stack ?? "")).not.toMatch(STACK_FRAME);
  }
  if (via === "dev") {
    // A build wraps the plugin's error in rolldown's aggregate, which keeps
    // the position in its message only; the dev server rethrows ours as is.
    expect(err.loc?.line).toBe(at.line);
    expect(err.loc?.column).toBe(at.column);
    expect(err.loc?.file).toMatch(/page\.mx$/);
    expect(err.id).toMatch(/page\.mx$/);
    expect(err.frame).toContain(at.specifier);
  }
}

describe("an import that does not resolve, built with vite (audit item 10)", () => {
  it("a missing relative .mx import (h15)", async () => {
    html("mx");
    write(
      "mx",
      "src/page.mx",
      `import Card from "./card.mx";
export interface Input { name: string }
<Card title="x"/>
`,
    );
    expectLocated(
      await buildError("mx", "src/page.mx"),
      { line: 1, column: 17, specifier: "./card.mx" },
      "build",
    );
  });

  it("names the authored line, not the generated one, when they differ", async () => {
    html("shifted");
    write(
      "shifted",
      "src/page.mx",
      `export interface Input { name: string }
// a comment line

import Card from "./card.mx";
<Card title="x"/>
`,
    );
    expectLocated(
      await buildError("shifted", "src/page.mx"),
      { line: 4, column: 17, specifier: "./card.mx" },
      "build",
    );
  });

  it("a missing relative .ts import", async () => {
    html("ts");
    write(
      "ts",
      "src/page.mx",
      `import { helper } from "./helper.ts";
export interface Input { name: string }
<p>\${helper(input.name)}</p>
`,
    );
    expectLocated(
      await buildError("ts", "src/page.mx"),
      { line: 1, column: 23, specifier: "./helper.ts" },
      "build",
    );
  });

  it("a bare package that is not installed", async () => {
    html("bare");
    write(
      "bare",
      "src/page.mx",
      `export interface Input { name: string }
import { x } from "mx-no-such-package-xyz";
<p>\${x}</p>
`,
    );
    expectLocated(
      await buildError("bare", "src/page.mx"),
      { line: 2, column: 18, specifier: "mx-no-such-package-xyz" },
      "build",
    );
  });

  it("a multi-line import statement points at the specifier", async () => {
    html("multi");
    write(
      "multi",
      "src/page.mx",
      `import {
  a,
  b,
} from "./gone.ts";
export interface Input { name: string }
<p>\${a}\${b}</p>
`,
    );
    expectLocated(
      await buildError("multi", "src/page.mx"),
      { line: 4, column: 7, specifier: "./gone.ts" },
      "build",
    );
  });

  it("a .solid.mx page importing a missing .solid.mx (s11)", async () => {
    host("solid", "solid");
    write(
      "solid",
      "src/page.solid.mx",
      `import { createSignal } from "solid-js";
import { Gone } from "./Gone.solid.mx";
export function App() {
  return <Gone />;
}
`,
    );
    const error = await buildError("solid", "src/page.solid.mx");
    expect(error).toBeInstanceOf(Error);
    const message = plain((error as Wrapped).message);
    expect(message).toContain('Could not resolve "./Gone.solid.mx"');
    expect(message).toContain("page.solid.mx:2:");
    expect(message).not.toContain(".solid.mx.tsx");
  });

  it("a preact page importing a missing .mx (p10)", async () => {
    host("preact", "preact");
    write(
      "preact",
      "src/App.mx",
      `import Gone from "./Gone.mx";
export interface Input {}
<Gone/>
`,
    );
    const error = await buildError("preact", "src/App.mx");
    expect(error).toBeInstanceOf(Error);
    const message = plain((error as Wrapped).message);
    expect(message).toContain('Could not resolve "./Gone.mx"');
    expect(message).toContain("App.mx:1:17");
    expect(message).not.toContain(".mx.tsx");
  });

  it("a missing import in a tags/*.mx tag names the tag file", async () => {
    html("tag");
    write(
      "tag",
      "src/tags/badge.mx",
      `import { x } from "./gone.ts";\n<b>\${x}</b>\n`,
    );
    write("tag", "src/page.mx", "<badge/>\n");
    const error = await buildError("tag", "src/page.mx");
    expect(error).toBeInstanceOf(Error);
    const message = plain((error as Wrapped).message);
    expect(message).toContain('Could not resolve "./gone.ts"');
    expect(message).toContain("badge.mx:1:");
    expect(message).not.toContain(".mx.tsx");
  });

  it("a page whose only imports are the emitter's still builds", async () => {
    // Imports the emitter adds (the runtime) are not in the authored source,
    // so the probe must neither fail them nor need a position for them.
    html("generated");
    write("generated", "src/page.mx", "<p>hi</p>\n");
    const projectRoot = join(root, "generated");
    const error = await build({
      root: projectRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [mx()],
      build: {
        ssr: join(projectRoot, "src/page.mx"),
        outDir: join(projectRoot, "dist"),
        emptyOutDir: true,
        minify: false,
      },
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeUndefined();
  });

  it("a valid import still builds", async () => {
    html("valid");
    write("valid", "src/helper.ts", "export const helper = (s: string) => s;");
    write("valid", "src/card.mx", `<b>card</b>`);
    write(
      "valid",
      "src/page.mx",
      `import { helper } from "./helper.ts";
import Card from "./card.mx";
export interface Input { name: string }
<p>\${helper(input.name)}<Card/></p>
`,
    );
    expect(await buildError("valid", "src/page.mx")).toBeUndefined();
  });

  it("an explicitly external specifier is not reported as unresolved", async () => {
    html("external");
    write(
      "external",
      "src/page.mx",
      `import { x } from "mx-not-installed-but-external";
export interface Input { name: string }
<p>\${x}</p>
`,
    );
    const projectRoot = join(root, "external");
    await build({
      root: projectRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [mx()],
      build: {
        ssr: join(projectRoot, "src/page.mx"),
        outDir: join(projectRoot, "dist"),
        emptyOutDir: true,
        minify: false,
        rollupOptions: { external: ["mx-not-installed-but-external"] },
      },
    });
  });
});

describe("the same error through the dev server's transform path", () => {
  it("ssrLoadModule names page.mx and the authored position", async () => {
    html("dev");
    write(
      "dev",
      "src/page.mx",
      `export interface Input { name: string }
import Card from "./card.mx";
<Card/>
`,
    );
    const server = await createServer({
      root: join(root, "dev"),
      configFile: false,
      logLevel: "silent",
      plugins: [mx()],
      server: { middlewareMode: true, hmr: false, watch: null },
      appType: "custom",
    });
    try {
      const error = await server
        .ssrLoadModule(join(root, "dev", "src/page.mx"))
        .then(
          () => undefined,
          (err: Wrapped) => err,
        );
      expectLocated(
        error,
        { line: 2, column: 17, specifier: "./card.mx" },
        "dev",
      );
    } finally {
      await server.close();
    }
  });
});
