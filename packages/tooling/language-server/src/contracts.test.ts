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

interface WatcherRegistration {
  registrations: Array<{
    method: string;
    registerOptions: { watchers: Array<{ globPattern: string }> };
  }>;
}

async function startClient(
  onRegistration?: (params: WatcherRegistration) => void,
): Promise<MessageConnection> {
  // Real built server on Bun. Long-lived Node ESM/TS loaders instead need
  // restart (TODO sync-esm-reload-node). No server outlives its test.
  child = spawn(
    onRegistration ? "node" : "bun",
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
  if (onRegistration) {
    conn.onRequest(
      "client/registerCapability",
      (params: WatcherRegistration) => {
        onRegistration(params);
        return null;
      },
    );
  }
  conn.listen();
  await conn.sendRequest("initialize", {
    processId: null,
    rootUri: null,
    capabilities: onRegistration
      ? { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } }
      : {},
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

const invalidDeclaration =
  "export default { style: { attributes: { nonce: { requried: true } } } };\n";

it.each([false, true])(
  "recovers from invalid contracts discovery on module-only watcher edits (initially invalid=%s)",
  async (initiallyInvalid) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-recovery-")));
    directory = dir;
    const module = join(dir, "contracts.ts");
    const uri = pathToFileURL(join(dir, "page.mx")).href;
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { host: "html", contracts: "./contracts.ts" } }),
    );
    writeFileSync(
      module,
      initiallyInvalid ? invalidDeclaration : declaration("nonce"),
    );
    writeFileSync(join(dir, "page.mx"), source);
    const conn = await startClient();
    let invalid = await openPage(conn, uri);
    if (!initiallyInvalid) {
      expectRequired(invalid, "nonce");
      invalid = await editWatchedFile(conn, uri, module, invalidDeclaration);
    }
    expect(invalid.diagnostics).toHaveLength(1);
    expect(invalid.diagnostics[0]?.message).toContain('Unknown key "requried"');
    expectRequired(
      await editWatchedFile(conn, uri, module, declaration("media")),
      "media",
    );
  },
  20000,
);

it("registers JavaScript watchers and re-diagnoses a cjs module edit through the registered path (Node)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-js-watch-")));
  directory = dir;
  const module = join(dir, "contracts.cjs");
  const uri = pathToFileURL(join(dir, "page.mx")).href;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "html", contracts: "./contracts.cjs" } }),
  );
  const cjs = (name: string) =>
    declaration(name).replace("export default", "module.exports.default =");
  writeFileSync(module, cjs("nonce"));
  writeFileSync(join(dir, "page.mx"), source);
  let registered!: (params: WatcherRegistration) => void;
  const registration = new Promise<WatcherRegistration>((resolve) => {
    registered = resolve;
  });
  const conn = await startClient(registered);
  const params = await registration;
  const watchers = params.registrations.find(
    (entry) => entry.method === "workspace/didChangeWatchedFiles",
  )?.registerOptions.watchers;
  const globs = watchers?.map((watcher) => watcher.globPattern) ?? [];
  expect(globs).toEqual(
    expect.arrayContaining(["**/*.js", "**/*.mjs", "**/*.cjs"]),
  );
  expectRequired(await openPage(conn, uri), "nonce");

  // Simulate a client that sends only events matching the server's registration.
  // Do not manually inject an event for an unregistered extension.
  const extension = module.slice(module.lastIndexOf("."));
  expect(globs.some((glob) => glob === `**/*${extension}`)).toBe(true);
  expectRequired(
    await editWatchedFile(conn, uri, module, cjs("media")),
    "media",
  );
}, 20000);

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
