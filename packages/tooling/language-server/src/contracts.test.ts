import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

async function startClient(): Promise<MessageConnection> {
  // Real built server on Bun. Long-lived Node ESM/TS loaders instead need
  // restart (TODO sync-esm-reload-node). No server outlives its test.
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
  return conn;
}

const source = "<style>\n  .x { color: red }\n</style>\n";
const declaration = (name: string) =>
  `export default { style: { attributes: { ${name}: { type: 'string', required: true } } } };\n`;
const sidecarDeclaration = (name: string) =>
  `export default { attributes: { ${name}: { type: 'string', required: true } } };\n`;

async function openPage(
  conn: MessageConnection,
  uri: string,
): Promise<Published> {
  const initial = nextDiagnostics(conn, uri);
  conn.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "mx", version: 1, text: source },
  });
  return initial;
}

async function editWatchedFile(
  conn: MessageConnection,
  pageUri: string,
  file: string,
  content: string,
): Promise<Published> {
  writeFileSync(file, content);
  const updated = nextDiagnostics(conn, pageUri);
  // Only a filesystem watcher notification: no page edit, didSave, reopen,
  // or explicit cache clearing. The scan evidence must connect file to caller.
  conn.sendNotification("workspace/didChangeWatchedFiles", {
    changes: [{ uri: pathToFileURL(file).href, type: 2 /* Changed */ }],
  });
  return updated;
}

function expectRequired(params: Published, name: string): void {
  expect(params.diagnostics).toHaveLength(1);
  expect(params.diagnostics[0]).toMatchObject({
    severity: 1,
    source: "mxlang",
    message: `\`<style>\`: missing required attribute \`${name}\``,
    range: { start: { line: 0, character: 0 } },
  });
}

// Core's walk needs a filesystem path, not a raw URI; the server converts a
// real file:// URI before its registry scan. `style` is host-delegated, so
// the module declaration needs no template or transform.
it("reports a positioned mx.contracts error and re-diagnoses its caller on module-only watcher edits (Bun)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-contracts-")));
  directory = dir;
  const module = join(dir, "contracts.ts");
  const page = join(dir, "page.mx");
  const uri = pathToFileURL(page).href;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      mx: { host: "html", contracts: "./contracts.ts" },
    }),
  );
  writeFileSync(module, declaration("nonce"));
  writeFileSync(page, source);
  const conn = await startClient();
  expectRequired(await openPage(conn, uri), "nonce");
  expectRequired(
    await editWatchedFile(conn, uri, module, declaration("media")),
    "media",
  );

  // Dependency edges must survive failed compiles and later successful ones.
  const cleared = await editWatchedFile(
    conn,
    uri,
    module,
    "export default { style: { attributes: {} } };\n",
  );
  expect(cleared.diagnostics).toEqual([]);
  expectRequired(
    await editWatchedFile(conn, uri, module, declaration("nonce")),
    "nonce",
  );
}, 20000);

it("re-diagnoses its caller on sidecar-only watcher edits, retaining scan dependencies after errors and success (Bun)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-sidecar-")));
  directory = dir;
  const tags = join(dir, "tags");
  mkdirSync(tags);
  const sidecar = join(tags, "style.tag.ts");
  const page = join(dir, "page.mx");
  const uri = pathToFileURL(page).href;
  // No mx.contracts: this regression depends only on the scanned sidecar.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "html" } }),
  );
  writeFileSync(sidecar, sidecarDeclaration("nonce"));
  writeFileSync(page, source);
  const conn = await startClient();
  expectRequired(await openPage(conn, uri), "nonce");
  expectRequired(
    await editWatchedFile(conn, uri, sidecar, sidecarDeclaration("media")),
    "media",
  );
  const cleared = await editWatchedFile(
    conn,
    uri,
    sidecar,
    "export default { attributes: {} };\n",
  );
  expect(cleared.diagnostics).toEqual([]);
  expectRequired(
    await editWatchedFile(conn, uri, sidecar, sidecarDeclaration("nonce")),
    "nonce",
  );
}, 20000);
