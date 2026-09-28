import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMessageConnection,
  type MessageConnection,
  NotificationType,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { isMxDocument } from "./server.ts";

/**
 * The one stdio end-to-end test the brief asks for (§5): spawn the real
 * `dist/bin.js` over stdio, `initialize`, `didOpen` a document that a strict
 * policy rejects, and wait for the resulting `publishDiagnostics`
 * notification — proving the whole transport, not just `diagnoseDocument`.
 *
 * Requires `bun run build` to have produced `dist/bin.js` (see AGENTS.md
 * "Running tests in a fresh worktree" — the root `verify` script builds
 * before it tests, so this only bites a package run standalone).
 */

const BIN_PATH = join(import.meta.dirname, "../dist/bin.js");

const PublishDiagnosticsNotification = new NotificationType<{
  uri: string;
  diagnostics: Array<{ message: string; source?: string }>;
}>("textDocument/publishDiagnostics");

let child: ChildProcess | undefined;
let connection: MessageConnection | undefined;

afterEach(() => {
  connection?.dispose();
  connection = undefined;
  // The load rule requires killing what a test starts.
  child?.kill();
  child = undefined;
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

function nextDiagnostics(
  conn: MessageConnection,
  predicate: (params: {
    uri: string;
    diagnostics: Array<{ message: string; source?: string }>;
  }) => boolean,
): Promise<{
  uri: string;
  diagnostics: Array<{ message: string; source?: string }>;
}> {
  return new Promise((resolve) => {
    const disposable = conn.onNotification(
      PublishDiagnosticsNotification,
      (params) => {
        if (!predicate(params)) return;
        disposable.dispose();
        resolve(params);
      },
    );
  });
}

describe("stdio server (e2e)", () => {
  it("re-diagnoses an open caller from an open callee's unsaved Input changes", async () => {
    const conn = startClient();
    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    const directory = join(
      import.meta.dirname,
      "fixtures/dependency-rediagnosis",
    );
    const calleeUri = `file://${join(directory, "Card.mx")}`;
    const callerUri = `file://${join(directory, "Caller.mx")}`;
    const optional =
      "export interface Input { tab?: AttrTag<{ attrs: { title?: string } }> }\n\n<div/>\n";
    const required =
      "export interface Input { tab: AttrTag<{ attrs: { title?: string } }> }\n\n<div/>\n";
    const caller = 'import Card from "./Card.mx"\n\n<Card/>\n';

    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: calleeUri,
        languageId: "mx",
        version: 1,
        text: optional,
      },
    });
    const initialCaller = nextDiagnostics(
      conn,
      (params) => params.uri === callerUri,
    );
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: callerUri,
        languageId: "mx",
        version: 1,
        text: caller,
      },
    });
    expect((await initialCaller).diagnostics).toEqual([]);

    const newlyInvalid = nextDiagnostics(
      conn,
      (params) => params.uri === callerUri && params.diagnostics.length > 0,
    );
    conn.sendNotification("textDocument/didChange", {
      textDocument: { uri: calleeUri, version: 2 },
      contentChanges: [{ text: required }],
    });
    expect((await newlyInvalid).diagnostics[0]?.message).toContain("tab");

    const validAgain = nextDiagnostics(
      conn,
      (params) => params.uri === callerUri && params.diagnostics.length === 0,
    );
    conn.sendNotification("textDocument/didChange", {
      textDocument: { uri: calleeUri, version: 3 },
      contentChanges: [{ text: optional }],
    });
    expect((await validAgain).diagnostics).toEqual([]);
  }, 15000);

  it("re-diagnoses an open caller from an on-disk callee change reported by watched-file events", async () => {
    // The callee here is never opened in the editor — only a `didChangeWatchedFiles`
    // notification tells the server it changed on disk (a save from another
    // editor, a checkout, a codegen step). This is the dependent path
    // `didOpen`/`didChange` on the *open* callee already covers; the watcher
    // path is untested until now.
    // No `workspace.didChangeWatchedFiles.dynamicRegistration` capability:
    // `onDidChangeWatchedFiles` runs on an incoming notification regardless
    // of how the client came to send it, and declaring that capability would
    // need this client to also answer the server's `client/registerCapability`
    // request, which is unrelated to what this test covers.
    const conn = startClient();
    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    const directory = join(
      import.meta.dirname,
      "fixtures/dependency-rediagnosis-watched",
    );
    const calleePath = join(directory, "Card.mx");
    const calleeUri = `file://${calleePath}`;
    const callerUri = `file://${join(directory, "Caller.mx")}`;
    const optional =
      "export interface Input { tab?: AttrTag<{ attrs: { title?: string } }> }\n\n<div/>\n";
    const required =
      "export interface Input { tab: AttrTag<{ attrs: { title?: string } }> }\n\n<div/>\n";
    const caller = 'import Card from "./Card.mx"\n\n<Card/>\n';

    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      '{ "mx": { "host": "html" } }\n',
    );
    writeFileSync(calleePath, optional);

    try {
      const initialCaller = nextDiagnostics(
        conn,
        (params) => params.uri === callerUri,
      );
      conn.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: callerUri,
          languageId: "mx",
          version: 1,
          text: caller,
        },
      });
      expect((await initialCaller).diagnostics).toEqual([]);

      const newlyInvalid = nextDiagnostics(
        conn,
        (params) => params.uri === callerUri && params.diagnostics.length > 0,
      );
      writeFileSync(calleePath, required);
      conn.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: calleeUri, type: 2 /* Changed */ }],
      });
      expect((await newlyInvalid).diagnostics[0]?.message).toContain("tab");

      const validAgain = nextDiagnostics(
        conn,
        (params) => params.uri === callerUri && params.diagnostics.length === 0,
      );
      writeFileSync(calleePath, optional);
      conn.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: calleeUri, type: 2 /* Changed */ }],
      });
      expect((await validAgain).diagnostics).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);

  it("publishes a diagnostic for a strict-policy document opened over stdio", async () => {
    const conn = startClient();

    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    const diagnosticsReceived = new Promise<{
      uri: string;
      diagnostics: Array<{ message: string; source?: string }>;
    }>((resolve) => {
      conn.onNotification(PublishDiagnosticsNotification, (params) => {
        resolve(params);
      });
    });

    // This file's nearest package.json (fixtures/explicit-field) declares
    // `"mx": { "host": "astro", "strict": true }`, which resolves to the
    // translator's strictPolicy — under which <let> is a compile error.
    const uri = `file://${join(import.meta.dirname, "fixtures/explicit-field/nested/App.mx")}`;
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "mx",
        version: 1,
        text: "<let/count=1/>\n",
      },
    });

    const params = await diagnosticsReceived;

    expect(params.uri).toBe(uri);
    expect(params.diagnostics).toHaveLength(1);
    expect(params.diagnostics[0]?.source).toBe("mxlang");
    expect(params.diagnostics[0]?.message).toMatch(/let/i);
  }, 15000);

  it("discovers a tag from the document's own path, given a file:// URI", async () => {
    const conn = startClient();

    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    const diagnosticsReceived = new Promise<{
      uri: string;
      diagnostics: Array<{ message: string; source?: string }>;
    }>((resolve) => {
      conn.onNotification(PublishDiagnosticsNotification, resolve);
    });

    // Opened the way an editor opens it: a `file://` URI, not a path. The
    // server converts before scanning — `resolve("file:///a/page.mx")` yields
    // `<cwd>/file:/a/page.mx`, which exists nowhere, so passing the raw URI
    // through discovered no tags for any real document while a unit test that
    // called `diagnoseDocument` with a plain path stayed green.
    const uri = `file://${join(import.meta.dirname, "fixtures/discovered-tag/page.mx")}`;
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "mx",
        version: 1,
        text: "<stamp/>\n",
      },
    });

    const params = await diagnosticsReceived;

    // No diagnostics at all: `<stamp>` resolved. Undiscovered, it would be a
    // compile error naming the tag.
    expect(params.uri).toBe(uri);
    expect(params.diagnostics).toEqual([]);
  }, 15000);

  it("warns about a misconfigured mx.tags over stdio", async () => {
    const conn = startClient();

    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    const diagnosticsReceived = new Promise<{
      uri: string;
      diagnostics: Array<{
        message: string;
        source?: string;
        severity?: number;
      }>;
    }>((resolve) => {
      conn.onNotification(PublishDiagnosticsNotification, resolve);
    });

    // The document itself compiles fine; the problem is in its
    // `package.json`. Without this the typo is silent everywhere and an
    // author sees only that a tag never resolves.
    const uri = `file://${join(import.meta.dirname, "fixtures/bad-mx-tags/page.mx")}`;
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "mx",
        version: 1,
        text: "<p>hello</p>\n",
      },
    });

    const params = await diagnosticsReceived;

    expect(params.diagnostics).toHaveLength(1);
    // A warning, not an error: the scan carried on and the rest of the
    // package still compiles.
    expect(params.diagnostics[0]?.severity).toBe(2);
    // Names the file to fix, since LSP publishes against the open document
    // and the problem is in a different one.
    expect(params.diagnostics[0]?.message).toContain("package.json");
    expect(params.diagnostics[0]?.message).toContain("does-not-exist");
  }, 15000);

  it.each(["typescript", "marko"])(
    "diagnoses a .solid.mx URI with the %s language id",
    async (languageId) => {
      const conn = startClient();

      await conn.sendRequest("initialize", {
        processId: null,
        rootUri: null,
        capabilities: {},
      });
      conn.sendNotification("initialized", {});

      const diagnosticsReceived = new Promise<{
        uri: string;
        diagnostics: Array<{ message: string; source?: string }>;
      }>((resolve) => {
        conn.onNotification(PublishDiagnosticsNotification, resolve);
      });

      const uri = "file:///project/App.solid.mx";
      conn.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text: "export const view = () => <let/count=1/>;\n",
        },
      });

      const params = await diagnosticsReceived;
      expect(params.uri).toBe(uri);
      expect(params.diagnostics).toHaveLength(1);
      expect(params.diagnostics[0]?.message).toMatch(/let/i);
    },
    15000,
  );

  it("diagnoses a document identified by the solidmx language id", async () => {
    const conn = startClient();

    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    const diagnosticsReceived = new Promise<{
      uri: string;
      diagnostics: Array<{ message: string; source?: string }>;
    }>((resolve) => {
      conn.onNotification(PublishDiagnosticsNotification, resolve);
    });

    const uri = "file:///project/App.ts";
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "solidmx",
        version: 1,
        text: "export const view = () => <let/count=1/>;\n",
      },
    });

    const params = await diagnosticsReceived;
    expect(params.uri).toBe(uri);
    expect(params.diagnostics).toHaveLength(1);
    expect(params.diagnostics[0]?.message).toMatch(/let/i);
  }, 15000);

  it("diagnoses a .mx document resolved to the Solid host", async () => {
    const conn = startClient();

    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    const diagnosticsReceived = new Promise<{
      uri: string;
      diagnostics: Array<{ message: string; source?: string }>;
    }>((resolve) => {
      conn.onNotification(PublishDiagnosticsNotification, resolve);
    });

    const uri = `file://${join(import.meta.dirname, "fixtures/solid-dependency/App.mx")}`;
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "mx",
        version: 1,
        text: "<let/count=1/>\n",
      },
    });

    const params = await diagnosticsReceived;
    expect(params.uri).toBe(uri);
    expect(params.diagnostics).toHaveLength(1);
    expect(params.diagnostics[0]?.message).toMatch(/let/i);
  }, 15000);

  it("recognizes both SolidMX language ids but not an ordinary .ts document", () => {
    expect(isMxDocument("untitled:App", "solidmx")).toBe(true);
    expect(isMxDocument("untitled:App", "SolidMX")).toBe(true);
    expect(isMxDocument("file:///project/App.ts", "typescript")).toBe(false);
  });

  it("does not recognize a .marko document or the marko language id", () => {
    // MX only supports the MX 1.0 subset of Marko syntax, so a real .marko
    // file is not diagnosed as MX even though it shares a taglib origin.
    expect(isMxDocument("file:///project/App.marko", "marko")).toBe(false);
    expect(isMxDocument("untitled:App", "marko")).toBe(false);
  });

  it("resolves the policy correctly for a file:// URI with a percent-encoded space in its path", async () => {
    // Regression for the `new URL(uri).pathname` bug: that API leaves
    // `%20` percent-encoded, so the package.json walk in host-policy.ts
    // would look for a directory literally named "space%20in%20name" and
    // find nothing, silently falling back to the default (non-strict)
    // policy instead of this fixture's strict one. `fileURLToPath` decodes
    // it, so the walk finds the real "space in name" directory.
    const conn = startClient();

    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    const diagnosticsReceived = new Promise<{
      uri: string;
      diagnostics: Array<{ message: string; source?: string }>;
    }>((resolve) => {
      conn.onNotification(PublishDiagnosticsNotification, (params) => {
        resolve(params);
      });
    });

    const filePath = join(import.meta.dirname, "fixtures/space in name/App.mx");
    const uri = `file://${filePath.replaceAll(" ", "%20")}`;
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "mx",
        version: 1,
        text: "<let/count=1/>\n",
      },
    });

    const params = await diagnosticsReceived;

    expect(params.uri).toBe(uri);
    expect(params.diagnostics).toHaveLength(1);
    expect(params.diagnostics[0]?.message).toMatch(/let/i);
  }, 15000);
});
