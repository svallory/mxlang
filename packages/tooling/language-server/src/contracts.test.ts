import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  createMessageConnection,
  type MessageConnection,
  NotificationType,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

interface Published {
  uri: string;
  diagnostics: Array<{
    message: string;
    source?: string;
    severity?: number;
    range: { start: { line: number; character: number } };
  }>;
}
const published = new NotificationType<Published>(
  "textDocument/publishDiagnostics",
);
let child: ChildProcess | undefined;
let connection: MessageConnection | undefined;
let directory: string | undefined;
afterEach(() => {
  connection?.dispose();
  child?.kill();
  if (directory) rmSync(directory, { recursive: true, force: true });
  connection = undefined;
  child = undefined;
  directory = undefined;
});

function nextDiagnostics(
  conn: MessageConnection,
  uri: string,
): Promise<Published> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`no diagnostics published for ${uri}`));
    }, 5000);
    const disposable = conn.onNotification(published, (params) => {
      if (params.uri !== uri) return;
      clearTimeout(timeout);
      disposable.dispose();
      resolve(params);
    });
  });
}

// Real stdio and file:// URI. Core's walk needs a filesystem path, not a raw
// URI; the server converts it before calling the registry scan. `style` is
// host-delegated, so a declaration-only module needs no template/transform.
it("reports a positioned mx.contracts error and reloads the edited module on Bun re-diagnosis", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-contracts-")));
  directory = dir;
  const module = join(dir, "contracts.ts");
  const page = join(dir, "page.mx");
  const uri = pathToFileURL(page).href;
  const source = "<style>\n  .x { color: red }\n</style>\n";
  const declaration = (name: string) =>
    `export default { style: { attributes: { ${name}: { type: 'string', required: true } } } };\n`;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      mx: { host: "html", contracts: "./contracts.ts" },
    }),
  );
  writeFileSync(module, declaration("nonce"));
  writeFileSync(page, source);

  // The built server runs on Bun; Node ESM/TS edits instead need restart
  // (TODO sync-esm-reload-node). No server outlives this test.
  child = spawn(
    "bun",
    [join(import.meta.dirname, "../dist/bin.js"), "--stdio"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (!child.stdout || !child.stdin) throw new Error("missing stdio streams");
  const conn = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection = conn;
  conn.listen();
  await conn.sendRequest("initialize", {
    processId: null,
    rootUri: null,
    capabilities: {},
  });
  conn.sendNotification("initialized", {});
  const initial = nextDiagnostics(conn, uri);
  conn.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "mx", version: 1, text: source },
  });
  const first = await initial;
  expect(first.diagnostics).toHaveLength(1);
  expect(first.diagnostics[0]).toMatchObject({
    severity: 1,
    source: "mxlang",
    message: "`<style>`: missing required attribute `nonce`",
    range: { start: { line: 0, character: 0 } },
  });

  writeFileSync(module, declaration("media"));
  const updated = nextDiagnostics(conn, uri);
  // Module-only watcher re-diagnosis is the separately approved LS fix.
  // Here a page re-diagnosis proves the contracts module reloads on Bun.
  conn.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: source }],
  });
  const second = await updated;
  expect(second.diagnostics).toHaveLength(1);
  expect(second.diagnostics[0]).toMatchObject({
    message: "`<style>`: missing required attribute `media`",
    range: { start: { line: 0, character: 0 } },
  });
}, 15000);
