/**
 * A dialect's `unknownTags` (and `structural`) in the language server: the
 * server passes none of the lowering options, so the dialect's module states
 * them, and an edit to the module alone re-checks the open file. Runs the
 * built server over stdio.
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

/** The probe dialect's module (CommonJS) with the lowering `fields` as source text. */
const dialectModule = (fields: string) =>
  `module.exports = { default: { tagRules: "none", table: {}, contracts: { entity: {} }, ${fields} } };\n`;

const UNKNOWN_WIDGET =
  "MX_UNKNOWN_TAG: `<widget>` is not a known tag in the `probe` dialect";
const STATIC_IF =
  "MX_STRUCTURAL_CONSTRUCT: the data tree is static; this file's consumer does not evaluate `<if>`";

it("a module that closes the vocabulary reaches an open file, and an edit to the module alone re-checks it", async () => {
  const project = probeProject({ "dialect.cjs": dialectModule("") });
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
      text: "<entity/>\n<widget/>\n<if=true><entity/></if>\n",
    },
  });
  // The module states nothing: the open set, the structural constructs pass.
  expect(await until(1)).toEqual([]);

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

  // `unknownTags: "reject"` added to the module: the misspelt tag is reported.
  expect(await edit(dialectModule('unknownTags: "reject"'), 2)).toEqual([
    UNKNOWN_WIDGET,
  ]);
  // `structural: "reject"` too: the `<if>` joins it, in position order.
  expect(
    await edit(dialectModule('unknownTags: "reject", structural: "reject"'), 3),
  ).toEqual([UNKNOWN_WIDGET, STATIC_IF]);
  // A value outside the set fails the dialect, at the module.
  const broken = await edit(dialectModule('unknownTags: "deny"'), 4);
  expect(broken).toHaveLength(1);
  expect(broken?.[0]).toContain('`unknownTags` must be "allow" or "reject"');
  // Back to nothing: the failure and the strictness are not served from a cache.
  expect(await edit(dialectModule(""), 5)).toEqual([]);
}, 30000);
