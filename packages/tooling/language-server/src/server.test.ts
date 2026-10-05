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
import { builtinFileKinds } from "@mxlang/target-registry";
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
  it.each([
    ["<p>ok</p>\n\n<div>\n", 3, 0, 'Missing ending "div" tag', undefined],
    // An aggregate callee: the callee's own diagnostic counts what the first
    // reason leaves out, since only the frame shows the rest.
    [
      "<div a=(x +)/>\n<span>",
      1,
      11,
      "Unexpected token (+1 more)",
      'Missing ending "span" tag',
    ],
  ] as const)(
    "publishes a child template syntax error on the child's URI and range",
    async (source, line, column, message, frameReason) => {
      const directory = mkdtempSync(join(tmpdir(), "mx-lsp-callee-"));
      try {
        writeFileSync(
          join(directory, "package.json"),
          '{"name":"x","mx":{"host":"html"}}',
        );
        mkdirSync(join(directory, "tags"));
        writeFileSync(join(directory, "tags/broken.mx"), source);
        const conn = startClient();
        await conn.sendRequest("initialize", {
          processId: null,
          rootUri: null,
          capabilities: {},
        });
        const childUri = `file://${join(directory, "tags/broken.mx")}`;
        const published = nextDiagnostics(
          conn,
          (params) => params.uri === childUri,
        );
        await conn.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri: `file://${join(directory, "page.mx")}`,
            languageId: "marko",
            version: 1,
            text: "<main>\n  <broken/>\n</main>\n",
          },
        });
        const result = await published;
        expect(result.uri).toBe(childUri);
        expect(result.diagnostics[0]?.message).toContain(message);
        if (frameReason !== undefined) {
          const frame = (
            result.diagnostics[0] as { data?: { codeFrame?: string } }
          ).data?.codeFrame;
          expect(frame).toContain(frameReason);
        }
        expect((result.diagnostics[0] as { range?: unknown }).range).toEqual({
          start: { line: line - 1, character: column },
          end: { line: line - 1, character: column + 1 },
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
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

  it("clears a closed document's own diagnostics", async () => {
    const conn = startClient();
    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    // Same fixture (host: "astro", strict: true) as the strict-policy test
    // above: `<let>` is a compile error under that policy, so opening it
    // publishes one diagnostic.
    const uri = `file://${join(import.meta.dirname, "fixtures/explicit-field/nested/CloseMe.mx")}`;
    const invalid = nextDiagnostics(
      conn,
      (params) => params.uri === uri && params.diagnostics.length > 0,
    );
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "mx",
        version: 1,
        text: "<let/count=1/>\n",
      },
    });
    expect((await invalid).diagnostics).toHaveLength(1);

    const cleared = nextDiagnostics(
      conn,
      (params) => params.uri === uri && params.diagnostics.length === 0,
    );
    conn.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
    expect((await cleared).diagnostics).toEqual([]);
  }, 15000);

  it("stops re-diagnosing a caller once it is closed, even when its open callee changes again", async () => {
    // Reuses the dependency-rediagnosis fixture and flow (§ above), but
    // closes the caller after the first round-trip, then changes the callee
    // again the same way the first test does. `onDidClose` deletes the
    // caller's `callerDependencies` edge, so `scheduleDependents` finds
    // nothing to re-diagnose for it and no further publish for the caller's
    // URI ever arrives.
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
    const calleeUri = `file://${join(directory, "CloseCard.mx")}`;
    const callerUri = `file://${join(directory, "CloseCaller.mx")}`;
    const optional =
      "export interface Input { tab?: AttrTag<{ attrs: { title?: string } }> }\n\n<div/>\n";
    const required =
      "export interface Input { tab: AttrTag<{ attrs: { title?: string } }> }\n\n<div/>\n";
    const caller = 'import Card from "./CloseCard.mx"\n\n<Card/>\n';

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

    // Close the caller: `onDidClose` clears its diagnostics and deletes its
    // `callerDependencies` edge.
    const closedCaller = nextDiagnostics(
      conn,
      (params) => params.uri === callerUri && params.diagnostics.length === 0,
    );
    conn.sendNotification("textDocument/didClose", {
      textDocument: { uri: callerUri },
    });
    await closedCaller;

    // Changing the still-open callee would, before the close, have
    // re-diagnosed the caller with a "tab" error (proven by the earlier
    // test). With the caller closed, no publish for its URI should follow.
    // `conn.onNotification` replaces rather than chains handlers for the
    // same notification type, so every publish (caller or callee) is
    // observed through one shared listener rather than two concurrent
    // `nextDiagnostics` calls racing to register their own.
    const seenUris: string[] = [];
    const calleeRediagnosed = new Promise<void>((resolve) => {
      conn.onNotification(PublishDiagnosticsNotification, (params) => {
        seenUris.push(params.uri);
        if (params.uri === calleeUri) resolve();
      });
    });
    conn.sendNotification("textDocument/didChange", {
      textDocument: { uri: calleeUri, version: 2 },
      contentChanges: [{ text: required }],
    });
    await calleeRediagnosed;
    expect(seenUris).not.toContain(callerUri);
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

  it("publishes a package.json problem on package.json too, and clears it on close", async () => {
    const conn = startClient();
    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});

    type Published = {
      uri: string;
      diagnostics: Array<{
        message: string;
        range: { start: { line: number; character: number } };
        relatedInformation?: Array<{ location: { uri: string } }>;
      }>;
    };
    const seen: Published[] = [];
    conn.onNotification(PublishDiagnosticsNotification, (params) => {
      seen.push(params as Published);
    });
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 300 && !done(); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    const dir = join(import.meta.dirname, "fixtures/bad-mx-tags");
    const uri = `file://${join(dir, "page.mx")}`;
    const pkgUri = `file://${join(dir, "package.json")}`;
    conn.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "mx", version: 1, text: "<p>x</p>\n" },
    });
    await until(
      () =>
        seen.some((p) => p.uri === uri) && seen.some((p) => p.uri === pkgUri),
    );

    // The .mx gets 1:1 plus a pointer; package.json gets the real range.
    const onPage = seen.find((p) => p.uri === uri)?.diagnostics[0];
    expect(onPage?.range.start).toEqual({ line: 0, character: 0 });
    expect(onPage?.message).toMatch(/package\.json:\d+:\d+: /);
    expect(onPage?.relatedInformation?.[0]?.location.uri).toBe(pkgUri);
    const onPkg = seen.find((p) => p.uri === pkgUri)?.diagnostics[0];
    expect(onPkg?.message).toContain("does-not-exist");

    // Closing the only document that reported it clears package.json.
    conn.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
    await until(() =>
      seen.some((p) => p.uri === pkgUri && p.diagnostics.length === 0),
    );
    expect(
      seen.some((p) => p.uri === pkgUri && p.diagnostics.length === 0),
    ).toBe(true);
  }, 15000);

  it("keeps a shared package.json problem until the last document closes, and clears all of it when package.json is fixed", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-pkg-")));
    try {
      const pkgPath = join(dir, "package.json");
      const bad = JSON.stringify({ name: "t", mx: { host: "htmll" } }, null, 2);
      const good = JSON.stringify({ name: "t", mx: { host: "html" } }, null, 2);
      writeFileSync(pkgPath, bad);
      const pkgUri = `file://${pkgPath}`;
      const uriA = `file://${join(dir, "a.mx")}`;
      const uriB = `file://${join(dir, "b.mx")}`;

      const conn = startClient();
      await conn.sendRequest("initialize", {
        processId: null,
        rootUri: null,
        capabilities: {},
      });
      conn.sendNotification("initialized", {});
      const latest = new Map<string, number>();
      conn.onNotification(PublishDiagnosticsNotification, (params) => {
        latest.set(params.uri, params.diagnostics.length);
      });
      const until = async (done: () => boolean) => {
        for (let i = 0; i < 300 && !done(); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      const open = (uri: string) =>
        conn.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: "mx",
            version: 1,
            text: "<p>x</p>\n",
          },
        });
      open(uriA);
      open(uriB);
      await until(
        () =>
          latest.get(uriA) === 1 &&
          latest.get(uriB) === 1 &&
          latest.get(pkgUri) === 1,
      );
      expect([latest.get(uriA), latest.get(uriB), latest.get(pkgUri)]).toEqual([
        1, 1, 1,
      ]);

      // Closing A must not clear what B still shows.
      conn.sendNotification("textDocument/didClose", {
        textDocument: { uri: uriA },
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(latest.get(pkgUri)).toBe(1);

      // Reopen A, then fix package.json and send only the watcher event:
      // neither document is edited.
      open(uriA);
      await until(() => latest.get(uriA) === 1);
      writeFileSync(pkgPath, good);
      conn.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pkgUri, type: 2 }],
      });
      await until(
        () =>
          latest.get(uriA) === 0 &&
          latest.get(uriB) === 0 &&
          latest.get(pkgUri) === 0,
      );
      expect([latest.get(uriA), latest.get(uriB), latest.get(pkgUri)]).toEqual([
        0, 0, 0,
      ]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }, 30000);

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

  it("recognizes both solid language ids but not an ordinary .ts document", () => {
    expect(isMxDocument("untitled:App", "solidmx")).toBe(true);
    expect(isMxDocument("untitled:App", "solid")).toBe(true);
    expect(isMxDocument("file:///project/App.ts", "typescript")).toBe(false);
  });

  it("recognizes every registered suffix, but only region language ids on their own", () => {
    for (const kind of builtinFileKinds) {
      expect(isMxDocument(`file:///app/card.${kind.segment}.mx`, "")).toBe(
        true,
      );
      for (const id of kind.languageIds ?? []) {
        expect(isMxDocument("untitled:App", id)).toBe(
          kind.pipeline === "region",
        );
      }
    }
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
