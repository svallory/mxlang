import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makePluginInstall } from "./fixtures/plugin-install.ts";

const built = existsSync(
  path.resolve(import.meta.dirname, "../dist/index.cjs"),
);
const TSSERVER = createRequire(import.meta.url).resolve(
  "typescript/lib/tsserver.js",
);

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Speaks the tsserver protocol over stdio; every request resolves on its
 * response. A request rejects, with tsserver's stderr and the tail of its log
 * in the message, when tsserver exits first or answers nothing in
 * {@link REQUEST_TIMEOUT_MS}; a hung tsserver is killed, never left running.
 */
function startTsserver(args: string[], cwd: string, logFile: string) {
  const child: ChildProcess = spawn(process.execPath, [TSSERVER, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const waiting = new Map<
    number,
    { resolve: (body: unknown) => void; reject: (error: Error) => void }
  >();
  const failAll = (reason: string) => {
    const logTail = existsSync(logFile)
      ? readFileSync(logFile, "utf8").split("\n").slice(-30).join("\n")
      : "(no log file)";
    const error = new Error(
      `${reason}\n--- tsserver stderr ---\n${stderr || "(empty)"}\n--- tsserver log tail ---\n${logTail}`,
    );
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  };
  child.on("exit", (code, signal) => {
    failAll(
      `tsserver exited (code ${code}, signal ${signal}) before answering`,
    );
  });
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
          failAll(
            `tsserver gave no response to "${command}" in ${REQUEST_TIMEOUT_MS} ms`,
          );
          child.kill("SIGKILL");
        }, REQUEST_TIMEOUT_MS);
        waiting.set(id, {
          resolve: (body) => {
            clearTimeout(timer);
            resolve(body);
          },
          reject: (error) => {
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

/** Writes the project files every load test uses; `plugins` is the tsconfig list. */
function writeProject(
  root: string,
  plugins: { name: string }[],
): { file: string; logFile: string } {
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "preserve",
        ...(plugins.length > 0 ? { plugins } : {}),
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
  return {
    file: path.join(root, "index.ts"),
    logFile: path.join(root, "tsserver.log"),
  };
}

/** Opens `index.ts` in one real tsserver and asserts the plugin loaded and typed it. */
async function expectPluginLoaded(
  root: string,
  extraArgs: string[],
  plugins: { name: string }[],
) {
  const { file, logFile } = writeProject(root, plugins);
  const server = startTsserver(
    [
      "--logVerbosity",
      "verbose",
      "--logFile",
      logFile,
      ...extraArgs,
      "--disableAutomaticTypingAcquisition",
    ],
    root,
    logFile,
  );
  try {
    // What an editor sends so the project can hold `.mx` files at all.
    await server.request("configure", {
      extraFileExtensions: [
        { extension: ".mx", isMixedContent: false, scriptKind: 7 },
      ],
    });
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
    await expectPluginLoaded(
      root,
      ["--pluginProbeLocations", root],
      // Declares the plugin the way a user does.
      [{ name: "@mxlang/typescript-plugin" }],
    );
  }, 50_000);
});

// The same load, against the plugin an installed VS Code extension ships:
// `MX_VSIX_EXTENSION_DIR` is the unpacked VSIX's `extension/` directory
// (`packages/editors/vscode`'s `tsserver-load` script sets it). VS Code starts
// tsserver with `--globalPlugins <name>` and the extension dir as a plugin
// probe location for each `contributes.typescriptServerPlugins` entry, so this
// does the same, with no plugin entry in the project's tsconfig.
const extensionDir = process.env.MX_VSIX_EXTENSION_DIR;
describe.skipIf(!extensionDir)(
  "tsserver loads the plugin shipped in the VSIX",
  () => {
    it("loads the VSIX's plugin instead of skipping it", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "mx-vsix-project-"));
      try {
        await expectPluginLoaded(
          root,
          [
            "--globalPlugins",
            "@mxlang/typescript-plugin",
            "--pluginProbeLocations",
            extensionDir as string,
          ],
          [],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 50_000);
  },
);
