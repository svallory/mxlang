/**
 * A dialect's own contracts (`Dialect.contracts`) in the language server: an
 * edit to the dialect's module alone, with no edit to the open file,
 * re-checks it. The check reads the module (the scan stamps it), so the
 * module is among the file's dependencies, and a watcher event for it
 * re-publishes the file's diagnostics. Runs the built server over stdio.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { utimesSync, writeFileSync } from "node:fs";
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
import {
  cleanupProbeProjects,
  probeProject,
} from "../../../../test-fixtures/dialects/probe.ts";

const BIN_PATH = join(import.meta.dirname, "../dist/bin.js");

const published = new NotificationType<{
  uri: string;
  diagnostics: Array<{ message: string; code?: string }>;
}>("textDocument/publishDiagnostics");

let child: ChildProcess | undefined;
let connection: MessageConnection | undefined;

afterEach(() => {
  connection?.dispose();
  connection = undefined;
  child?.kill();
  child = undefined;
  cleanupProbeProjects();
});

function startClient(): MessageConnection {
  child = spawn("bun", ["run", BIN_PATH, "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stdin) {
    throw new Error("failed to open the server's stdio streams");
  }
  connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();
  return connection;
}

/** The probe dialect's module (CommonJS) with `contracts` as its source text. */
const dialectModule = (contracts: string) =>
  `module.exports = { default: { tagRules: "none", table: {}, contracts: ${contracts} } };\n`;

const REQUIRED =
  '{ entity: { attributes: { name: { type: "string", required: true } } } }';
const OPTIONAL = '{ entity: { attributes: { name: { type: "string" } } } }';

it("re-checks an open dialect file when only the dialect's module changes", async () => {
  const project = probeProject({ "dialect.cjs": dialectModule(REQUIRED) });
  const module = project.path("dialect.cjs");
  const moduleUri = pathToFileURL(module).href;
  const pageUri = pathToFileURL(project.path("page.probe")).href;
  const conn = startClient();
  await conn.sendRequest("initialize", {
    processId: null,
    rootUri: null,
    capabilities: {},
  });
  conn.sendNotification("initialized", {});
  const latest: Array<Array<string>> = [];
  conn.onNotification(published, (params) => {
    if (params.uri !== pageUri) return;
    latest.push(params.diagnostics.map((d) => `${d.code}: ${d.message}`));
  });
  const until = async (count: number) => {
    for (let i = 0; i < 300 && latest.length < count; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return latest[count - 1];
  };
  conn.sendNotification("textDocument/didOpen", {
    textDocument: {
      uri: pageUri,
      languageId: "probe",
      version: 1,
      text: "<entity/>\n",
    },
  });
  const missing = "`<entity>`: missing required attribute `name`";
  expect(await until(1)).toEqual([`MX_MISSING_ATTRIBUTE: ${missing}`]);

  let tick = Date.now() + 10_000;
  const edit = async (text: string, count: number) => {
    writeFileSync(module, text);
    tick += 10_000;
    const later = new Date(tick);
    utimesSync(module, later, later);
    conn.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: moduleUri, type: 2 }],
    });
    return until(count);
  };

  // The contract relaxed: the call is now valid.
  expect(await edit(dialectModule(OPTIONAL), 2)).toEqual([]);
  // A contract that cannot register fails the dialect, with its code.
  const broken = await edit(dialectModule("{ if: {} }"), 3);
  expect(broken).toHaveLength(1);
  expect(broken?.[0]).toMatch(
    /^MX_INVALID_DIALECT_CONTRACT: `contracts\.if`: `<if>` cannot name a data tag: it is reserved/,
  );
  // Fixed again: the failure is not served from the cache.
  expect(await edit(dialectModule(REQUIRED), 4)).toEqual([
    `MX_MISSING_ATTRIBUTE: ${missing}`,
  ]);
}, 30000);
