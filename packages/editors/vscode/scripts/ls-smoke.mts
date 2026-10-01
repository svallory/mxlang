// Starts the language server shipped in the VSIX and proves it works:
//
//   node scripts/ls-smoke.mts [path/to/mxlang.vsix]   (default: ./mxlang.vsix)
//
// Run it with `node` (Node strips the types), not bun: nothing Bun-only may be
// reachable from the shipped server, and the harness itself must not mask it.
//
// Unpacks the VSIX, runs `extension/node_modules/@mxlang/language-server/dist/
// bin.cjs` with plain `node` (what VS Code's own Node does for the extension's
// `LanguageClient` `module` option, over stdio), and speaks LSP to it:
// `initialize`, `initialized`, `textDocument/didOpen` of a `.mx` file that a
// strict host policy rejects (`<let>` under `"mx": { "host": "astro",
// "strict": true }`), then expects exactly one `publishDiagnostics` carrying
// exactly one diagnostic, then `shutdown`/`exit`.
//
// The server is the child of THIS script and nothing else: a hard timeout
// kills it on a hang or an early exit (stderr goes into the error), and a
// final `pgrep` fails the run if anything from the unpacked VSIX is still
// alive. It never starts VS Code and never installs the VSIX.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUNDLED_MAIN } from "../../../tooling/language-server/build/bundled-config.ts";

export const TIMEOUT_MS = 30_000;

interface Message {
  id?: number;
  method?: string;
  params?: {
    uri?: string;
    diagnostics?: { message: string; source?: string }[];
  };
  result?: unknown;
  error?: unknown;
}

const frame = (message: object) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};

/** Pids (other than this process) whose command line mentions `needle`. */
export function pgrepAlive(needle: string): string[] {
  try {
    const out = execFileSync("pgrep", ["-f", needle], { encoding: "utf8" });
    return out.split("\n").filter((pid) => pid && pid !== String(process.pid));
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

export interface SmokeResult {
  uri: string;
  diagnostics: { message: string; source?: string }[];
}

/** Runs the smoke against an unpacked extension root; rejects on any failure. */
export async function smokeLanguageServer(
  extensionRoot: string,
): Promise<SmokeResult> {
  const bin = join(
    extensionRoot,
    "node_modules/@mxlang/language-server/dist",
    BUNDLED_MAIN,
  );
  if (!existsSync(bin)) {
    throw new Error(`the VSIX ships no language server: ${bin} does not exist`);
  }

  // A project whose package.json makes the strict policy apply to App.mx.
  const project = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-smoke-")));
  const file = join(project, "App.mx");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "ls-smoke", mx: { host: "astro", strict: true } }),
  );
  writeFileSync(file, "<let/count=1/>\n");
  const uri = pathToFileURL(file).href;

  // `node` explicitly: never bun, which would hide a Bun-only dependency.
  const child: ChildProcess = spawn("node", [bin, "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((done) => {
    child.on("exit", (code) => done(code));
  });

  try {
    return await new Promise<SmokeResult>((resolveResult, reject) => {
      const fail = (reason: string) =>
        reject(new Error(`${reason}\nserver stderr:\n${stderr || "(empty)"}`));
      const timer = setTimeout(
        () => fail(`no publishDiagnostics within ${TIMEOUT_MS} ms`),
        TIMEOUT_MS,
      );
      child.on("error", (err) => fail(`could not start node: ${err.message}`));
      child.on("exit", (code, signal) =>
        fail(`the server exited early (code ${code}, signal ${signal})`),
      );

      const send = (message: object) => child.stdin?.write(frame(message));
      let buffer = Buffer.alloc(0);
      let published: SmokeResult | undefined;
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd < 0) return;
          const length = /Content-Length: (\d+)/i.exec(
            buffer.subarray(0, headerEnd).toString(),
          )?.[1];
          if (!length) return fail("a message without Content-Length");
          const start = headerEnd + 4;
          if (buffer.length < start + Number(length)) return;
          const message = JSON.parse(
            buffer.subarray(start, start + Number(length)).toString(),
          ) as Message;
          buffer = buffer.subarray(start + Number(length));

          if (message.id === 1 && message.result) {
            send({ method: "initialized", params: {} });
            send({
              method: "textDocument/didOpen",
              params: {
                textDocument: {
                  uri,
                  languageId: "mx",
                  version: 1,
                  text: "<let/count=1/>\n",
                },
              },
            });
          } else if (message.id === 1) {
            fail(`initialize failed: ${JSON.stringify(message.error)}`);
          } else if (message.method === "textDocument/publishDiagnostics") {
            if (published) return fail("a second publishDiagnostics arrived");
            published = {
              uri: message.params?.uri ?? "",
              diagnostics: message.params?.diagnostics ?? [],
            };
            send({ id: 2, method: "shutdown" });
          } else if (message.id === 2) {
            send({ method: "exit" });
            clearTimeout(timer);
            if (published) resolveResult(published);
          }
        }
      });

      send({
        id: 1,
        method: "initialize",
        params: { processId: process.pid, rootUri: null, capabilities: {} },
      });
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    rmSync(project, { recursive: true, force: true });
  }
}

function assertResult(result: SmokeResult, extensionRoot: string): void {
  if (result.diagnostics.length !== 1) {
    throw new Error(
      `expected exactly one diagnostic, got ${result.diagnostics.length}: ${JSON.stringify(result.diagnostics)}`,
    );
  }
  const [diagnostic] = result.diagnostics;
  if (diagnostic?.source !== "mxlang" || !/let/i.test(diagnostic.message)) {
    throw new Error(`unexpected diagnostic: ${JSON.stringify(diagnostic)}`);
  }
  const left = pgrepAlive(extensionRoot);
  if (left.length > 0) {
    throw new Error(
      `processes from the VSIX are still running: ${left.join(", ")}`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const vsix = resolve(process.argv[2] ?? "mxlang.vsix");
  if (!existsSync(vsix)) {
    console.error(`${vsix} does not exist: run \`bun run package\` first`);
    process.exit(1);
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-vsix-ls-")));
  try {
    execFileSync("unzip", ["-q", vsix, "-d", dir]);
    const root = join(dir, "extension");
    const result = await smokeLanguageServer(root);
    assertResult(result, root);
    console.log(
      `LS smoke passed for ${vsix}: 1 diagnostic, ${JSON.stringify(result.diagnostics[0]?.message)}`,
    );
  } catch (err) {
    console.error(
      `LS smoke FAILED for ${vsix}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
