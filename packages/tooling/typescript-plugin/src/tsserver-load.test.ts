import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makePluginInstall } from "./fixtures/plugin-install.ts";

const built = existsSync(
  path.resolve(import.meta.dirname, "../dist/index.cjs"),
);
const TSSERVER = createRequire(import.meta.url).resolve(
  "typescript/lib/tsserver.js",
);

/** Speaks the tsserver protocol over stdio; every request resolves on its response. */
function startTsserver(args: string[], cwd: string) {
  const child: ChildProcess = spawn(process.execPath, [TSSERVER, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map<number, (body: unknown) => void>();
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("{")) continue; // "Content-Length: n" header / blank line
      const message = JSON.parse(line) as {
        type: string;
        request_seq?: number;
        body?: unknown;
      };
      if (message.type === "response" && message.request_seq !== undefined) {
        waiting.get(message.request_seq)?.(message.body);
        waiting.delete(message.request_seq);
      }
    }
  });
  let seq = 0;
  return {
    request(command: string, args: object): Promise<unknown> {
      const id = ++seq;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin?.write(
          `${JSON.stringify({ seq: id, type: "request", command, arguments: args })}\n`,
        );
      });
    },
    kill: () => child.kill("SIGKILL"),
  };
}

// The plugin-load path tsserver runs (`sys.require` -> `enableProxy`) is the
// only thing that can tell a factory export from an object export, so this
// drives one real tsserver instead of mirroring its check.
describe.skipIf(!built)("tsserver loads the built plugin", () => {
  const root = built ? makePluginInstall() : "";
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("loads the plugin instead of skipping it", async () => {
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        // Declares the plugin the way a user does.
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "preserve",
          plugins: [{ name: "@mxlang/typescript-plugin" }],
        },
        files: ["index.ts"],
      }),
    );
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ mx: { host: "html" } }),
    );
    // Only the plugin can make `./comp.mx` resolve and type as a function.
    writeFileSync(path.join(root, "comp.mx"), "<div>hi</div>\n");
    writeFileSync(
      path.join(root, "index.ts"),
      'import Comp from "./comp.mx";\nconst misuse: number = Comp;\n',
    );
    const logFile = path.join(root, "tsserver.log");

    const server = startTsserver(
      [
        "--logVerbosity",
        "verbose",
        "--logFile",
        logFile,
        "--pluginProbeLocations",
        root,
        "--disableAutomaticTypingAcquisition",
      ],
      root,
    );
    try {
      // What an editor sends so the project can hold `.mx` files at all.
      await server.request("configure", {
        extraFileExtensions: [
          { extension: ".mx", isMixedContent: false, scriptKind: 7 },
        ],
      });
      const file = path.join(root, "index.ts");
      await server.request("open", { file });
      // `open` answers once the project (and its plugins) are loaded.
      const diagnostics = (await server.request("semanticDiagnosticsSync", {
        file,
      })) as { code: number; text: string }[];
      const log = readFileSync(logFile, "utf8");

      expect(log).toMatch(/Loading @mxlang\/typescript-plugin from/);
      expect(log).not.toContain("did not expose a proper factory function");
      expect(log).toContain("Plugin validation succeeded");
      // Skipped plugin: TS2307 "Cannot find module './comp.mx'". Loaded: the
      // import resolves and types, so the misuse is the only error.
      expect(diagnostics.map((d) => d.code)).toEqual([2322]);
      expect(diagnostics[0]?.text).toContain("(input: Input) => string");
    } finally {
      server.kill();
    }
  }, 50_000);
});
