import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { makePluginInstall } from "./fixtures/plugin-install.ts";
import { createPluginService } from "./fixtures/plugin-service.ts";
import { createMxLanguagePlugin } from "./mx-language.ts";
import { createTsconfigPathsResolver } from "./tsconfig-paths.ts";

/**
 * tsconfig `paths` reach `.mx` callee imports in the editor plugin (mx-c1cu):
 * the resolver the tsserver factory installs from the project's own compiler
 * options (`info.languageServiceHost.getCompilationSettings`) is the same one
 * these tests build directly, so the plugin leg here covers the wiring and a
 * real tsserver run below covers the factory end to end. The language server
 * has no ts program and stays as it was (its warning is the recorded
 * behaviour there).
 */

const built = existsSync(join(import.meta.dirname, "../dist/index.cjs"));
const TSSERVER = createRequire(import.meta.url).resolve(
  "typescript/lib/tsserver.js",
);
const REQUEST_TIMEOUT_MS = 20_000;

/** The html target's types, mapped the way a scratch project must map them. */
function targetHtmlEntry(dir: string): Record<string, string[]> {
  const packages = realpathSync(join(import.meta.dirname, "..", "..", ".."));
  return {
    "@mxlang/target-html": [
      relative(dir, join(packages, "targets/html/src/index.ts")),
    ],
  };
}

interface Scratch {
  dir: string;
  page: (source: string) => string;
}

/** An html scratch project: `page.mx` beside `src/Card.mx`, with `paths`. */
function scratch(paths: Record<string, string[]>, parent = tmpdir()): Scratch {
  const dir = mkdtempSync(join(parent, "mx-ts-paths-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "html" } }),
  );
  writeFileSync(
    join(dir, "src/Card.mx"),
    "export interface Input { a?: string }\n\n<div/>\n",
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "preserve",
        types: [],
        allowImportingTsExtensions: true,
        ignoreDeprecations: "6.0",
        baseUrl: ".",
        paths,
        plugins: [{ name: "@mxlang/typescript-plugin" }],
      },
      files: ["page.mx"],
    }),
  );
  return {
    dir,
    page: (source: string) => {
      const file = join(dir, "page.mx");
      writeFileSync(file, source);
      return file;
    },
  };
}

/** The compiler options tsc parses for the scratch project's tsconfig. */
function optionsOf(dir: string): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(dir, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (!parsed) throw new Error(`no tsconfig parsed for ${dir}`);
  return parsed.options;
}

/** `ts.ScriptSnapshot` is optional on the namespace type; tests always have it. */
const snapshotOf = (text: string): ts.IScriptSnapshot =>
  (
    ts.ScriptSnapshot as unknown as {
      fromString(source: string): ts.IScriptSnapshot;
    }
  ).fromString(text);

function compileDiagnosticsFor(project: Scratch, page: string) {
  const plugin = createMxLanguagePlugin(ts, {
    resolveImport: createTsconfigPathsResolver(ts, () =>
      optionsOf(project.dir),
    ),
  });
  plugin.createVirtualCode?.(
    page,
    "mx",
    snapshotOf(readFileSync(page, "utf8")),
    { getAssociatedScript: () => undefined },
  );
  return plugin
    .getCompileDiagnostics(page)
    .map(({ message, offset, diagnosticCode }) => ({
      message,
      offset,
      diagnosticCode,
    }));
}

describe("the plugin resolves aliased .mx callee imports through tsconfig paths", () => {
  it("threads baseUrl through the source plugin factory service", () => {
    const project = scratch({});
    const page = project.page(
      'import Card from "packages/tooling/tsc/src/fixtures/host-dispatch/alias-html/Card-html.mx"\n<Card><@tab/></Card>\n',
    );
    const consumer = join(project.dir, "consumer.ts");
    const service = createPluginService(
      { [page]: readFileSync(page, "utf8"), [consumer]: 'import "./page.mx";' },
      [consumer],
    );
    try {
      service.getSemanticDiagnostics(consumer);
      const diagnostics = service.getSyntacticDiagnostics(page);
      expect(service.getProgram()?.getSourceFile(page)).toBeDefined();
      expect(
        diagnostics.map((d) => ({ code: d.code, message: d.messageText })),
      ).toEqual([]);
    } finally {
      service.dispose();
      rmSync(project.dir, { recursive: true, force: true });
    }
  });
  it.each(["~/Card.mx", "~/Card"])(
    "refreshes misses and hits for %s with the same compiler options",
    (specifier) => {
      const project = scratch({ "~/*": ["src/*", "lib/*"] });
      try {
        const options = optionsOf(project.dir);
        const resolveImport = createTsconfigPathsResolver(ts, () => options);
        const page = project.page("");
        const first = join(project.dir, "src/Card.mx");
        const fallback = join(project.dir, "lib/Card.mx");
        rmSync(first);
        expect(resolveImport(specifier, page)).toBeUndefined();
        writeFileSync(first, "<div/>\n");
        expect(resolveImport(specifier, page)).toBe(first);
        mkdirSync(join(project.dir, "lib"));
        renameSync(first, fallback);
        expect(resolveImport(specifier, page)).toBe(fallback);
        // A still-existing fallback hit must not hide a new preferred file.
        writeFileSync(first, "<span/>\n");
        expect(resolveImport(specifier, page)).toBe(first);
        rmSync(first);
        rmSync(fallback);
        expect(resolveImport(specifier, page)).toBeUndefined();
      } finally {
        rmSync(project.dir, { recursive: true, force: true });
      }
    },
  );
  it("reads updated compiler options without recreating the resolver", () => {
    const project = scratch({ "~/*": ["missing/*"] });
    try {
      let options = optionsOf(project.dir);
      const resolveImport = createTsconfigPathsResolver(ts, () => options);
      const page = project.page("");
      expect(resolveImport("~/Card.mx", page)).toBeUndefined();
      options = { ...options, paths: { "~/*": ["src/*"] } };
      expect(resolveImport("~/Card.mx", page)).toBe(
        join(project.dir, "src/Card.mx"),
      );
      options = { ...options, paths: { "~/*": ["missing/*"] } };
      expect(resolveImport("~/Card.mx", page)).toBeUndefined();
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });
  it("resolves compound .mx callee suffixes without changing caller scope", () => {
    const project = scratch({ "~/*": ["src/*"] });
    try {
      const resolveImport = createTsconfigPathsResolver(ts, () =>
        optionsOf(project.dir),
      );
      const page = project.page("");
      for (const suffix of [
        "astro.mx",
        "ng.mx",
        "solid.mx",
        "preact.mx",
        "react.mx",
        "hono.mx",
      ]) {
        const callee = join(project.dir, `src/Card.${suffix}`);
        writeFileSync(callee, "");
        expect(resolveImport(`~/Card.${suffix}`, page)).toBe(callee);
      }
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });

  it("leaves relative and node_modules resolution to core", () => {
    const project = scratch({ "~/*": ["src/*"] });
    try {
      const pkg = join(project.dir, "node_modules", "cards");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: "cards" }),
      );
      writeFileSync(join(pkg, "Card.mx"), "<div/>\n");
      const resolveImport = createTsconfigPathsResolver(ts, () =>
        optionsOf(project.dir),
      );
      const page = project.page("");
      expect(resolveImport("./src/Card.mx", page)).toBeUndefined();
      expect(resolveImport("cards/Card.mx", page)).toBeUndefined();
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });

  it("reads the callee's Input for a star alias with the extension kept", () => {
    const project = scratch({ "~/*": ["src/*"], ...targetHtmlEntry("") });
    try {
      const page = project.page(
        'import Card from "~/Card.mx"\n\n<Card><@tab/></Card>\n',
      );
      // An attribute tag is what makes an unreadable callee warn; the read
      // being real turns that into "declares no attribute tag `tab`" instead
      // of `MX_UNREADABLE_CALLEE_INPUT`.
      expect(compileDiagnosticsFor(project, page)).toEqual([
        {
          message: "`<Card>` declares no attribute tag `tab`",
          offset: 37,
          diagnosticCode: "MX_UNKNOWN_ATTRIBUTE_TAG",
        },
      ]);
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });

  it("reads it for an extension-omitted alias and an exact alias", () => {
    for (const specifier of ["~/Card", "card"]) {
      const project = scratch({
        ...(specifier === "card" ? { card: ["./src/Card.mx"] } : {}),
        "~/*": ["src/*"],
        ...targetHtmlEntry(""),
      });
      try {
        const page = project.page(
          `import Card from "${specifier}"\n\n<Card><@tab/></Card>\n`,
        );
        expect(compileDiagnosticsFor(project, page)).toEqual([
          expect.objectContaining({
            message: "`<Card>` declares no attribute tag `tab`",
            diagnosticCode: "MX_UNKNOWN_ATTRIBUTE_TAG",
          }),
        ]);
      } finally {
        rmSync(project.dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps the existing warning for an alias that does not resolve", () => {
    const project = scratch({ "~/*": ["src/*"], ...targetHtmlEntry("") });
    try {
      const page = project.page(
        'import Card from "~/Missing.mx"\n\n<Card><@tab/></Card>\n',
      );
      expect(compileDiagnosticsFor(project, page)).toEqual([
        {
          message:
            "couldn't read `<Card>`'s Input (`~/Missing.mx` not resolvable); attribute-tag shape inferred from this call",
          offset: 34,
          diagnosticCode: "MX_UNREADABLE_CALLEE_INPUT",
        },
      ]);
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });
});

/**
 * Speaks just enough of the tsserver protocol for one diagnostics request;
 * the shape is the one `tsserver-load.test.ts` uses, kept local because that
 * file's harness is not exported.
 */
function startTsserver(args: string[], cwd: string) {
  const child: ChildProcess = spawn(process.execPath, [TSSERVER, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map<
    number,
    { resolve: (body: unknown) => void; reject: (error: Error) => void }
  >();
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("{")) continue;
      const message = JSON.parse(line) as {
        type: string;
        request_seq?: number;
        body?: unknown;
      };
      if (message.type === "response" && message.request_seq !== undefined) {
        waiting.get(message.request_seq)?.resolve(message.body);
        waiting.delete(message.request_seq);
      }
    }
  });
  let seq = 0;
  return {
    request(command: string, args: object): Promise<unknown> {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`tsserver gave no response to "${command}"`));
          child.kill("SIGKILL");
        }, REQUEST_TIMEOUT_MS);
        waiting.set(id, {
          resolve: (body) => {
            clearTimeout(timer);
            resolve(body);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin?.write(
          `${JSON.stringify({ seq: id, type: "request", command, arguments: args })}\n`,
        );
      });
    },
    kill: () => child.kill("SIGKILL"),
  };
}

// The tsserver leg needs the built plugin (`dist/index.cjs`), which is what a
// real editor loads.
describe.skipIf(!built)(
  "a real tsserver resolves an aliased .mx callee import",
  () => {
    const root = built ? makePluginInstall() : "";
    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it.each([
      { specifier: "~/Card.mx", change: "create-after-miss" },
      { specifier: "~/Card", change: "create-after-miss" },
      { specifier: "~/Card.mx", change: "move-after-hit" },
      { specifier: "~/Card", change: "move-after-hit" },
    ])(
      "refreshes $specifier after $change in the same server",
      async ({ specifier, change }) => {
        const project = scratch({ "~/*": ["src/*", "lib/*"] }, root);
        const { dir } = project;
        const configFile = join(dir, "tsconfig.json");
        const config = JSON.parse(readFileSync(configFile, "utf8"));
        Object.assign(config.compilerOptions.paths, targetHtmlEntry(dir));
        writeFileSync(configFile, JSON.stringify(config));
        const callee = join(dir, "src/Card.mx");
        const source = readFileSync(callee, "utf8");
        if (change === "create-after-miss") rmSync(callee);
        mkdirSync(join(dir, "lib"));
        const text = `import Card from "${specifier}"\n\n<Card><@tab/></Card>\n`;
        const page = project.page(text);
        const server = startTsserver(
          [
            "--pluginProbeLocations",
            root,
            "--disableAutomaticTypingAcquisition",
          ],
          dir,
        );
        const diagnostics = async () => [
          ...((await server.request("semanticDiagnosticsSync", {
            file: page,
          })) as { code: number | string }[]),
          ...((await server.request("syntacticDiagnosticsSync", {
            file: page,
          })) as { code: number | string }[]),
        ];
        try {
          await server.request("configure", {
            extraFileExtensions: [
              { extension: ".mx", isMixedContent: false, scriptKind: 7 },
            ],
          });
          await server.request("open", { file: page, fileContent: text });
          const before = await diagnostics();
          expect(before.map((d) => d.code)).toContain(
            change === "create-after-miss"
              ? "MX_UNREADABLE_CALLEE_INPUT"
              : "MX_UNKNOWN_ATTRIBUTE_TAG",
          );
          if (change === "create-after-miss") writeFileSync(callee, source);
          else renameSync(callee, join(dir, "lib/Card.mx"));
          // No config reload or server restart: a caller edit must re-resolve
          // even though getCompilationSettings still returns the same object.
          await server.request("close", { file: page });
          project.page(`${text}\n`);
          await server.request("open", {
            file: page,
            fileContent: `${text}\n`,
          });
          const after = await diagnostics();
          expect(after.map((d) => d.code)).toContain(
            "MX_UNKNOWN_ATTRIBUTE_TAG",
          );
          expect(after.map((d) => d.code)).not.toContain(
            "MX_UNREADABLE_CALLEE_INPUT",
          );
          expect(after.map((d) => d.code)).not.toContain(2307);
        } finally {
          server.kill();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      50_000,
    );

    it.each([
      { specifier: "~/Card.mx", paths: { "~/*": ["src/*"] }, inherited: false },
      { specifier: "~/Card", paths: { "~/*": ["src/*"] }, inherited: false },
      { specifier: "card", paths: { card: ["src/Card.mx"] }, inherited: false },
      { specifier: "src/Card.mx", paths: {}, inherited: false },
      { specifier: "~/Card.mx", paths: { "~/*": ["src/*"] }, inherited: true },
    ])(
      "reads $specifier (inherited: $inherited) in the real plugin",
      async ({ specifier, paths, inherited }) => {
        // The scratch project lives inside the plugin install's node_modules
        // scope so `@mxlang/typescript-plugin` resolves by name.
        const dir = mkdtempSync(join(root, "project-"));
        const project: Scratch = {
          dir,
          page: (source: string) => {
            const file = join(dir, "page.mx");
            writeFileSync(file, source);
            return file;
          },
        };
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ mx: { host: "html" } }),
        );
        writeFileSync(
          join(dir, "src/Card.mx"),
          "export interface Input { a?: string }\n\n<div/>\n",
        );
        writeFileSync(
          join(dir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "bundler",
              jsx: "preserve",
              types: [],
              allowImportingTsExtensions: true,
              ignoreDeprecations: "6.0",
              baseUrl: ".",
              paths: {
                ...paths,
                ...targetHtmlEntry(dir),
              },
              plugins: [{ name: "@mxlang/typescript-plugin" }],
            },
            files: ["page.mx", "src/Card.mx"],
          }),
        );
        if (inherited) {
          writeFileSync(
            join(dir, "base.json"),
            readFileSync(join(dir, "tsconfig.json")),
          );
          writeFileSync(
            join(dir, "tsconfig.json"),
            JSON.stringify({ extends: "./base.json" }),
          );
        }
        const page = project.page(
          `import Card from "${specifier}"\n\n<Card><@tab/></Card>\n`,
        );
        const server = startTsserver(
          [
            "--pluginProbeLocations",
            root,
            "--disableAutomaticTypingAcquisition",
          ],
          dir,
        );
        try {
          await server.request("configure", {
            extraFileExtensions: [
              { extension: ".mx", isMixedContent: false, scriptKind: 7 },
            ],
          });
          await server.request("open", {
            file: page,
            fileContent: readFileSync(page, "utf8"),
          });
          const diagnostics = [
            ...((await server.request("semanticDiagnosticsSync", {
              file: page,
            })) as {
              code: number | string;
              text: string;
            }[]),
            ...((await server.request("syntacticDiagnosticsSync", {
              file: page,
            })) as {
              code: number | string;
              text: string;
            }[]),
          ];
          // A positive assertion proves the factory installed our resolver,
          // rather than passing because the plugin was never loaded.
          expect(
            diagnostics.some((d) => d.code === "MX_UNKNOWN_ATTRIBUTE_TAG"),
          ).toBe(true);
          expect(
            diagnostics.filter((d) => d.code === "MX_UNREADABLE_CALLEE_INPUT"),
          ).toEqual([]);
          expect(diagnostics.filter((d) => d.code === 2307)).toEqual([]);
          if (inherited) {
            const configFile = join(dir, "base.json");
            const config = JSON.parse(readFileSync(configFile, "utf8"));
            config.compilerOptions.paths["~/*"] = ["missing/*"];
            writeFileSync(configFile, JSON.stringify(config));
            await server.request("reloadProjects", {});
            const missing = (await server.request("syntacticDiagnosticsSync", {
              file: page,
            })) as { code: number | string; text: string }[];
            // Volar retains virtual code for an unchanged source snapshot on
            // reloadProjects. Pin that existing limitation, then prove that
            // the next caller edit uses the newly loaded compiler options.
            expect(
              missing.some((d) => d.code === "MX_UNKNOWN_ATTRIBUTE_TAG"),
            ).toBe(true);
            await server.request("close", { file: page });
            project.page(
              `import Card from "${specifier}"\n\n<Card><@tab/></Card>\n\n`,
            );
            await server.request("open", {
              file: page,
              fileContent: readFileSync(page, "utf8"),
            });
            const refreshed = (await server.request(
              "syntacticDiagnosticsSync",
              { file: page },
            )) as { code: number | string; text: string }[];
            expect(
              refreshed.some((d) => d.code === "MX_UNREADABLE_CALLEE_INPUT"),
            ).toBe(true);
            config.compilerOptions.paths["~/*"] = ["src/*"];
            writeFileSync(configFile, JSON.stringify(config));
            await server.request("reloadProjects", {});
            await server.request("close", { file: page });
            project.page(
              `import Card from "${specifier}"\n\n<Card><@tab/></Card>\n\n\n`,
            );
            await server.request("open", {
              file: page,
              fileContent: readFileSync(page, "utf8"),
            });
            const restored = (await server.request("syntacticDiagnosticsSync", {
              file: page,
            })) as { code: number | string; text: string }[];
            expect(
              restored.some((d) => d.code === "MX_UNKNOWN_ATTRIBUTE_TAG"),
            ).toBe(true);
            expect(
              restored.some((d) => d.code === "MX_UNREADABLE_CALLEE_INPUT"),
            ).toBe(false);
          }
          await server.request("close", { file: page });
          project.page(`import Card from "${specifier}"\n\n<Card a=123/>\n`);
          await server.request("open", {
            file: page,
            fileContent: readFileSync(page, "utf8"),
          });
          const typed = (await server.request("semanticDiagnosticsSync", {
            file: page,
          })) as { code: number | string; text: string }[];
          expect(typed.filter((d) => d.code === 2307)).toEqual([]);
          expect(typed.some((d) => d.code === 2322)).toBe(true);
        } finally {
          server.kill();
        }
      },
      50_000,
    );
  },
);
