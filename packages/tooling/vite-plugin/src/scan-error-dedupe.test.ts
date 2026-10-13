import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { build, createLogger, createServer } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import mx from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Inside the package tree, like the other build tests: a compiled page
// imports its host package by bare specifier.
const root = mkdtempSync(join(here, "..", ".tmp-scan-error-dedupe-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Printed text is asserted ANSI-stripped: agent shells set NO_COLOR, CI does not.
const plain = (text: string): string => stripVTControlCharacters(text);

const reserved = (name: string): string =>
  `MX_RESERVED_TAG: \`<${name}>\` cannot name a data tag: it is reserved — core consumes the structural names (\`if\`, \`else\`, \`else-if\`, \`for\`, \`const\`, \`define\`, \`return\`, \`import\`, \`export\`, \`static\`) and \`<try>\` before a target sees them`;

function write(project: string, rel: string, source: string): string {
  const path = join(root, project, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function project(
  name: string,
  tags: string[],
  callers: string[],
): {
  dir: string;
  tag: (tag: string) => string;
  caller: (n: string) => string;
} {
  write(
    name,
    "package.json",
    JSON.stringify({ name, type: "module", mx: { host: "html" } }),
  );
  for (const tag of tags) write(name, `tags/${tag}.mx`, "<p>x</p>\n");
  for (const caller of callers) write(name, `${caller}.mx`, "<p>page</p>\n");
  return {
    dir: join(root, name),
    tag: (tag) => join(root, name, `tags/${tag}.mx`),
    caller: (n) => join(root, name, `${n}.mx`),
  };
}

/** Every error a failed `vite build` of the callers reports, one per entry. */
async function buildErrors(
  dir: string,
  callers: string[],
  errors: string[],
): Promise<void> {
  const logger = createLogger("silent");
  try {
    await build({
      root: dir,
      configFile: false,
      customLogger: logger,
      plugins: [mx()],
      build: {
        ssr: true,
        outDir: join(dir, "dist"),
        emptyOutDir: true,
        minify: false,
        rollupOptions: {
          input: Object.fromEntries(
            callers.map((caller) => [caller, join(dir, `${caller}.mx`)]),
          ),
        },
      },
    });
  } catch (err) {
    const { errors: inner } = err as { errors?: Error[] };
    for (const e of inner ?? [err as Error]) errors.push(plain(e.message));
  }
}

/**
 * Opens one dev server and runs the steps against it; each step transforms
 * callers (or edits the project) and the result is what Vite printed so far.
 */
async function serve(
  dir: string,
  steps: Array<(transform: (caller: string) => Promise<unknown>) => unknown>,
): Promise<string[][]> {
  const printed: string[] = [];
  const logger = createLogger("warn");
  logger.warn = (message) => {
    printed.push(plain(message));
  };
  const server = await createServer({
    root: dir,
    configFile: false,
    customLogger: logger,
    plugins: [mx()],
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
  });
  const after: string[][] = [];
  try {
    for (const step of steps) {
      await step((caller) =>
        server.environments.ssr.transformRequest(join(dir, `${caller}.mx`)),
      );
      after.push([...printed]);
    }
  } finally {
    await server.close();
  }
  return after;
}

describe("a scan error is reported once, not once per caller", () => {
  it("gives one build error for two callers of one broken tag file", async () => {
    const p = project("build-one", ["try"], ["a", "b"]);
    const errors: string[] = [];
    await buildErrors(p.dir, ["a", "b"], errors);
    const mentioning = errors.filter((e) => e.includes("MX_RESERVED_TAG"));
    expect(mentioning).toHaveLength(1);
    expect(mentioning[0]).toContain(`${p.tag("try")}:1:1: ${reserved("try")}`);
  });

  it("still gives one error per broken tag file", async () => {
    const p = project("build-two", ["try", "if"], ["a", "b"]);
    const errors: string[] = [];
    await buildErrors(p.dir, ["a", "b"], errors);
    // One thrown error lists both files (the first, then "1 more error").
    const all = errors.join("\n");
    expect(all.match(/MX_RESERVED_TAG/g)).toHaveLength(2);
    expect(all).toContain(`${p.tag("if")}:1:1: ${reserved("if")}`);
    expect(all).toContain(`${p.tag("try")}:1:1: ${reserved("try")}`);
  });
});

describe("a scan error under vite serve", () => {
  it("warns once for two callers of one broken tag file, naming the tag file", async () => {
    const p = project("serve-one", ["try"], ["a", "b"]);
    const [afterBoth] = await serve(p.dir, [
      async (transform) => {
        await transform("a");
        await transform("b");
      },
    ]);
    expect(afterBoth).toHaveLength(1);
    expect(afterBoth?.[0]).toBe(
      [
        `warning: @mxlang/vite-plugin: ${p.tag("try")}:1:1: ${reserved("try")}`,
        `  Plugin: mx`,
        `  File: ${p.tag("try")}:1:0`,
        `  1  |  <p>x</p>`,
        `     |  ^`,
        `  2  |  `,
      ].join("\n"),
    );
  });

  it("warns again when the tag file is touched, and when it is fixed and breaks again", async () => {
    const p = project("serve-edit", ["try"], ["a", "b", "c", "d", "e"]);
    const bump = (): void => {
      const later = new Date(Date.now() + 10_000 * ++clock);
      utimesSync(p.tag("try"), later, later);
    };
    let clock = 0;
    const counts = (
      await serve(p.dir, [
        (transform) => transform("a"),
        (transform) => transform("b"),
        (transform) => {
          bump();
          return transform("c");
        },
        (transform) => {
          rmSync(p.tag("try"));
          return transform("d");
        },
        (transform) => {
          write("serve-edit", "tags/try.mx", "<p>x</p>\n");
          bump();
          return transform("e");
        },
      ])
    ).map((printed) => printed.length);
    // a: first warning; b: same file version, nothing; c: the file was edited
    // (the error is the same), warns again; d: the file is gone, nothing to
    // say; e: the file is back and broken again, warns again.
    expect(counts).toEqual([1, 1, 2, 2, 3]);
  });
});
