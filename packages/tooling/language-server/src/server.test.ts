import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { pathToFileURL } from "node:url";
import { MX_CONFIG_SEARCH_PLACES } from "@mxlang/core";
import { builtinFileKinds } from "@mxlang/targets";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMessageConnection,
  type MessageConnection,
  NotificationType,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  cleanupProbeProjects,
  PROBE_DEPENDS_ON_HOOK_MODULE,
  PROBE_SOURCES,
  probeProject,
  tagDiscoveryProject,
} from "../../../../test-fixtures/dialects/probe.ts";
import { isMxDocument, WATCHED_FILE_GLOBS } from "./server.ts";

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
  diagnostics: Array<{ message: string; source?: string; code?: string }>;
}>("textDocument/publishDiagnostics");

let child: ChildProcess | undefined;
let connection: MessageConnection | undefined;

afterEach(() => {
  cleanupProbeProjects();
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
  it("publishes a dialect file's diagnostic with the dialect's name and code over stdio", async () => {
    const project = probeProject();
    const conn = startClient();
    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    const uri = pathToFileURL(project.path("a.probe")).href;
    const published = nextDiagnostics(conn, (params) => params.uri === uri);
    await conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "plaintext",
        version: 1,
        text: PROBE_SOURCES.bad,
      },
    });
    const result = await published;
    expect(result.diagnostics).toEqual([
      {
        severity: 1,
        source: "Probe",
        code: "PROBE_BAD",
        message: "bad probe",
        range: {
          start: { line: 0, character: 3 },
          end: { line: 0, character: 4 },
        },
      },
    ]);
    cleanupProbeProjects();
  });

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

  it("fixing a tag file clears its diagnostics and re-publishes the dialect file that calls it, with no edit to either", async () => {
    const project = tagDiscoveryProject({
      "concepts/money.thing.probe": "<x/>\n<!-- BAD -->\n",
    });
    const tagFile = project.path("concepts/money.thing.probe");
    const tagUri = pathToFileURL(tagFile).href;
    const pageUri = pathToFileURL(project.path("page.probe")).href;
    const conn = startClient();
    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});
    const latest = new Map<string, string[]>();
    conn.onNotification(PublishDiagnosticsNotification, (params) => {
      latest.set(
        params.uri,
        params.diagnostics.map((d) => String(d.code ?? d.message)),
      );
    });
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 300 && !done(); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pageUri,
        languageId: "probe",
        version: 1,
        text: "<p/>\n<money/>\n",
      },
    });
    await until(() => latest.get(tagUri)?.length === 1);
    expect(latest.get(pageUri)).toEqual(["MX_TAG_FILE_ERROR", "KIT_BAD"]);
    expect(latest.get(tagUri)).toEqual(["KIT_BAD"]);

    writeFileSync(tagFile, "<x/>\n");
    conn.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: tagUri, type: 2 }],
    });
    await until(
      () =>
        latest.get(tagUri)?.length === 0 && latest.get(pageUri)?.length === 0,
    );
    expect(latest.get(tagUri)).toEqual([]);
    expect(latest.get(pageUri)).toEqual([]);
  }, 30000);

  it("an unsaved fix to an open tag file clears the dialect file that calls it, before any save", async () => {
    const project = tagDiscoveryProject({
      "concepts/money.thing.probe": "<x/>\n<!-- BAD -->\n",
    });
    const tagUri = pathToFileURL(
      project.path("concepts/money.thing.probe"),
    ).href;
    const pageUri = pathToFileURL(project.path("page.probe")).href;
    const conn = startClient();
    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    conn.sendNotification("initialized", {});
    const latest = new Map<string, string[]>();
    conn.onNotification(PublishDiagnosticsNotification, (params) => {
      latest.set(
        params.uri,
        params.diagnostics.map((d) => String(d.code ?? d.message)),
      );
    });
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 300 && !done(); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pageUri,
        languageId: "probe",
        version: 1,
        text: "<p/>\n<money/>\n",
      },
    });
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: tagUri,
        languageId: "probe",
        version: 1,
        text: "<x/>\n<!-- BAD -->\n",
      },
    });
    await until(() => latest.get(pageUri)?.length === 2);
    expect(latest.get(pageUri)).toEqual(["MX_TAG_FILE_ERROR", "KIT_BAD"]);
    expect(latest.get(tagUri)).toEqual(["KIT_BAD"]);

    // The fix is in the editor only: nothing is written to disk.
    conn.sendNotification("textDocument/didChange", {
      textDocument: { uri: tagUri, version: 2 },
      contentChanges: [{ text: "<x/>\n" }],
    });
    await until(() => latest.get(pageUri)?.length === 0);
    expect(latest.get(tagUri)).toEqual([]);
    expect(latest.get(pageUri)).toEqual([]);

    // The unsaved break comes back the same way.
    conn.sendNotification("textDocument/didChange", {
      textDocument: { uri: tagUri, version: 3 },
      contentChanges: [{ text: "<x/>\n<!-- BAD -->\n" }],
    });
    await until(() => latest.get(pageUri)?.length === 2);
    expect(latest.get(pageUri)).toEqual(["MX_TAG_FILE_ERROR", "KIT_BAD"]);

    // Fixed again, then closed without saving: the disk's text is back in
    // force, and so is its error.
    conn.sendNotification("textDocument/didChange", {
      textDocument: { uri: tagUri, version: 4 },
      contentChanges: [{ text: "<x/>\n" }],
    });
    await until(() => latest.get(pageUri)?.length === 0);
    expect(latest.get(pageUri)).toEqual([]);
    conn.sendNotification("textDocument/didClose", {
      textDocument: { uri: tagUri },
    });
    await until(() => latest.get(pageUri)?.length === 2);
    expect(latest.get(pageUri)).toEqual(["MX_TAG_FILE_ERROR", "KIT_BAD"]);
  }, 30000);

  describe("a file a tag file's hook names with ctx.dependsOn", () => {
    const setup = async () => {
      const project = tagDiscoveryProject({
        "dialect.cjs": PROBE_DEPENDS_ON_HOOK_MODULE,
        "concepts/money.thing.probe": "<x/>\n",
        "concepts/money.json": "ok\n",
        "concepts/other.json": "ok\n",
      });
      const pageUri = pathToFileURL(project.path("page.probe")).href;
      const conn = startClient();
      const watchers: Array<{
        id: string;
        watchers: Array<{
          globPattern: string | { baseUri: string; pattern: string };
        }>;
      }> = [];
      conn.onRequest(
        "client/registerCapability",
        (params: {
          registrations: Array<{
            id: string;
            method: string;
            registerOptions: {
              watchers: Array<{
                globPattern: string | { baseUri: string; pattern: string };
              }>;
            };
          }>;
        }) => {
          for (const registration of params.registrations) {
            if (registration.method === "workspace/didChangeWatchedFiles") {
              watchers.push({
                id: registration.id,
                watchers: registration.registerOptions.watchers,
              });
            }
          }
        },
      );
      conn.onRequest("client/unregisterCapability", () => null);
      await conn.sendRequest("initialize", {
        processId: null,
        rootUri: pathToFileURL(project.dir).href,
        capabilities: {
          workspace: {
            didChangeWatchedFiles: {
              dynamicRegistration: true,
              relativePatternSupport: true,
            },
          },
        },
      });
      conn.sendNotification("initialized", {});
      const published: string[][] = [];
      conn.onNotification(PublishDiagnosticsNotification, (params) => {
        if (params.uri === pageUri) {
          published.push(
            params.diagnostics.map((d) => String(d.code ?? d.message)),
          );
        }
      });
      const until = async (done: () => boolean) => {
        for (let i = 0; i < 300 && !done(); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      conn.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: pageUri,
          languageId: "probe",
          version: 1,
          text: "<p/>\n<money/>\n",
        },
      });
      await until(() => published.length > 0);
      return { project, conn, published, watchers, until };
    };

    it("re-checks the dialect file when it changes on disk, and asks the client to watch it", async () => {
      const { project, conn, published, watchers, until } = await setup();
      expect(published.at(-1)).toEqual([]);
      const moneyJson = project.path("concepts/money.json");
      const watched = watchers
        .flatMap((registration) => registration.watchers)
        .map((watcher) => watcher.globPattern)
        .filter((glob) => typeof glob !== "string");
      expect(watched).toEqual([
        {
          baseUri: pathToFileURL(project.path("concepts")).href,
          pattern: "money.json",
        },
      ]);
      writeFileSync(moneyJson, "BAD\n");
      conn.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(moneyJson).href, type: 2 }],
      });
      await until(() => published.at(-1)?.length === 2);
      expect(published.at(-1)).toEqual(["MX_TAG_FILE_ERROR", "KIT_BAD"]);
    }, 30000);

    it("leaves the dialect file alone when a file nobody names changes", async () => {
      const { project, conn, published, until } = await setup();
      const before = published.length;
      const otherJson = project.path("concepts/other.json");
      writeFileSync(otherJson, "BAD\n");
      conn.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(otherJson).href, type: 2 }],
      });
      // Longer than the debounce, then the named file proves the server is live.
      await new Promise((r) => setTimeout(r, 800));
      expect(published.length).toBe(before);
      const moneyJson = project.path("concepts/money.json");
      writeFileSync(moneyJson, "BAD\n");
      conn.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(moneyJson).href, type: 2 }],
      });
      await until(() => published.length > before);
      expect(published.length).toBe(before + 1);
    }, 30000);
  });

  describe("diagnostics published against one URI are the union of its parts", () => {
    type Published = {
      code?: string;
      message: string;
      source?: string;
      severity?: number;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    };
    // The tag file on disk is wrong (`<!-- BAD -->`: the project's tag hook adds
    // KIT_BAD 2:4 for a caller); the text the editor holds of it is wrong in
    // another way (`!bad`: an invalid attribute name, 1:3).
    const KIT_BAD = {
      severity: 1,
      source: "Probe",
      code: "KIT_BAD",
      message: "bad concept",
      range: {
        start: { line: 1, character: 4 },
        end: { line: 1, character: 5 },
      },
    };
    // A tag file is checked under tag-file rules, where `!bad` is no trigger.
    const OWN = {
      severity: 1,
      source: "Probe",
      message:
        "Invalid attribute name `!bad` — an attribute name may use letters, digits and `._:-`",
      range: {
        start: { line: 0, character: 3 },
        end: { line: 0, character: 4 },
      },
    };
    // The editor's text of the tag file: the callers read it (not the
    // disk's), so it carries the `BAD` that makes the hook raise KIT_BAD.
    const OWN_TEXT = "<y !bad/>\n<!-- BAD -->\n";
    const CALLER_TEXT = "<p/>\n<money/>\n";

    async function session() {
      const project = tagDiscoveryProject({
        "concepts/money.thing.probe": "<x/>\n<!-- BAD -->\n",
      });
      const tagFile = project.path("concepts/money.thing.probe");
      const uris = {
        tag: pathToFileURL(tagFile).href,
        a: pathToFileURL(project.path("a.probe")).href,
        b: pathToFileURL(project.path("b.probe")).href,
      };
      const conn = startClient();
      await conn.sendRequest("initialize", {
        processId: null,
        rootUri: null,
        capabilities: {},
      });
      conn.sendNotification("initialized", {});
      const latest = new Map<string, Published[]>();
      conn.onNotification(PublishDiagnosticsNotification, (params) => {
        latest.set(params.uri, params.diagnostics as Published[]);
      });
      const until = async (done: () => boolean) => {
        for (let i = 0; i < 300 && !done(); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      const open = (uri: string, text: string) =>
        conn.sendNotification("textDocument/didOpen", {
          textDocument: { uri, languageId: "probe", version: 1, text },
        });
      return { project, tagFile, uris, conn, latest, until, open };
    }
    const codes = (list: Published[] | undefined) =>
      (list ?? []).map((d) => d.code);

    it("two callers and the file's own diagnostic are all there, whichever published last", async () => {
      const { uris, latest, until, open } = await session();
      open(uris.a, CALLER_TEXT);
      open(uris.b, CALLER_TEXT);
      await until(() => codes(latest.get(uris.tag)).length > 0);
      // Both callers raise the same KIT_BAD on the tag file: one diagnostic.
      expect(latest.get(uris.tag)).toEqual([KIT_BAD]);

      // The tag file is opened; its own diagnostic must not replace the callers'.
      open(uris.tag, OWN_TEXT);
      await until(() => codes(latest.get(uris.tag)).length === 2);
      expect(latest.get(uris.tag)).toEqual([OWN, KIT_BAD]);

      // A caller is edited, so it publishes again: the own diagnostic stays.
      open(uris.a, `${CALLER_TEXT}<p/>\n`);
      await new Promise((r) => setTimeout(r, 700));
      expect(latest.get(uris.tag)).toEqual([OWN, KIT_BAD]);
    }, 30000);

    it("shrinks both ways: a caller closing or fixing removes only its part, the file's own change keeps the callers'", async () => {
      const { uris, conn, latest, until, open } = await session();
      open(uris.tag, OWN_TEXT);
      await until(() => codes(latest.get(uris.tag)).length === 1);
      expect(latest.get(uris.tag)).toEqual([OWN]);
      open(uris.a, CALLER_TEXT);
      open(uris.b, CALLER_TEXT);
      await until(() => codes(latest.get(uris.tag)).length === 2);
      expect(latest.get(uris.tag)).toEqual([OWN, KIT_BAD]);

      // The file's own diagnostics change (the `!bad` is fixed in the
      // editor): the callers' stay.
      conn.sendNotification("textDocument/didChange", {
        textDocument: { uri: uris.tag, version: 2 },
        contentChanges: [{ text: "<y/>\n<!-- BAD -->\n" }],
      });
      await until(() => codes(latest.get(uris.tag)).join() === "KIT_BAD");
      expect(latest.get(uris.tag)).toEqual([KIT_BAD]);

      // Back to a bad own text, then one caller closes: the other's part and
      // the own part stay.
      conn.sendNotification("textDocument/didChange", {
        textDocument: { uri: uris.tag, version: 3 },
        contentChanges: [{ text: OWN_TEXT }],
      });
      await until(() => codes(latest.get(uris.tag)).length === 2);
      conn.sendNotification("textDocument/didClose", {
        textDocument: { uri: uris.a },
      });
      await until(() => latest.get(uris.a)?.length === 0);
      await new Promise((r) => setTimeout(r, 300));
      expect(latest.get(uris.tag)).toEqual([OWN, KIT_BAD]);

      // The tag file is fixed in the editor, unsaved: the remaining caller
      // stops raising on it, and so does the file's own check.
      conn.sendNotification("textDocument/didChange", {
        textDocument: { uri: uris.tag, version: 4 },
        contentChanges: [{ text: "<y/>\n" }],
      });
      await until(() => latest.get(uris.tag)?.length === 0);
      expect(latest.get(uris.tag)).toEqual([]);
      expect(latest.get(uris.b)).toEqual([]);
    }, 30000);

    it("closing the last caller leaves the file's own diagnostic; closing the file leaves the callers'", async () => {
      const { uris, conn, latest, until, open } = await session();
      open(uris.a, CALLER_TEXT);
      open(uris.tag, OWN_TEXT);
      await until(() => codes(latest.get(uris.tag)).length === 2);
      conn.sendNotification("textDocument/didClose", {
        textDocument: { uri: uris.tag },
      });
      await until(() => codes(latest.get(uris.tag)).join() === "KIT_BAD");
      // Its own part is gone with the document; the caller's part is not.
      expect(latest.get(uris.tag)).toEqual([KIT_BAD]);
      conn.sendNotification("textDocument/didClose", {
        textDocument: { uri: uris.a },
      });
      await until(() => latest.get(uris.tag)?.length === 0);
      expect(latest.get(uris.tag)).toEqual([]);
    }, 30000);
  });

  it("asks the client to watch a dialect's tag-file extension, even one no claimed extension ends", async () => {
    const project = probeProject(
      {},
      { manifest: { tagDirs: ["concepts"], tagExtensions: [".concept"] } },
    );
    const conn = startClient();
    const registered = new Promise<string[]>((resolve) => {
      conn.onRequest(
        "client/registerCapability",
        (params: {
          registrations: Array<{
            method: string;
            registerOptions: { watchers: Array<{ globPattern: string }> };
          }>;
        }) => {
          const watch = params.registrations.find(
            (r) => r.method === "workspace/didChangeWatchedFiles",
          );
          if (watch) {
            resolve(watch.registerOptions.watchers.map((w) => w.globPattern));
          }
        },
      );
    });
    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: pathToFileURL(project.dir).href,
      capabilities: {
        workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
      },
    });
    conn.sendNotification("initialized", {});
    const globs = await registered;
    expect(globs.filter((glob) => !WATCHED_FILE_GLOBS.includes(glob))).toEqual([
      "**/*.probe",
      "**/*.probe.mx",
      "**/*.concept",
    ]);
  }, 15000);

  it("a dialect file of a project whose dialect manifest is invalid shows the manifest error on itself and on package.json", async () => {
    const project = probeProject({}, { manifest: { tagDirs: 7 as never } });
    const packageFile = project.path("package.json");
    const conn = startClient();
    await conn.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    const uri = pathToFileURL(project.path("a.probe")).href;
    const packageUri = pathToFileURL(packageFile).href;
    const seen = new Map<string, unknown[]>();
    conn.onNotification(PublishDiagnosticsNotification, (params) => {
      seen.set(params.uri, params.diagnostics);
    });
    conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "plaintext",
        version: 1,
        text: PROBE_SOURCES.ok,
      },
    });
    for (let i = 0; i < 100 && !(seen.has(uri) && seen.has(packageUri)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const message =
      '`mx.dialect.tagDirs` must be an array of the directory names the dialect\'s files discover tags in (`["components"]`), or `[]` for none';
    const onPackage = {
      start: { line: 0, character: 130 },
      end: { line: 0, character: 131 },
    };
    expect(seen.get(uri)).toEqual([
      {
        severity: 1,
        source: "mxlang",
        message: `${message} (in ${packageFile}:1:131)`,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        relatedInformation: [
          { location: { uri: packageUri, range: onPackage }, message },
        ],
      },
    ]);
    expect(seen.get(packageUri)).toEqual([
      { severity: 1, source: "mxlang", message, range: onPackage },
    ]);
  }, 15000);

  it.each([...MX_CONFIG_SEARCH_PLACES])(
    "asks the client to watch the MX config search place %s",
    (place) => {
      const matched = (path: string) =>
        WATCHED_FILE_GLOBS.filter((glob) => matchesGlob(path, glob));
      expect(matched(`/project/${place}`)).not.toEqual([]);
      expect(matched(`/project/app/${place}`)).not.toEqual([]);
    },
  );

  it("re-diagnoses an open document when its project's mx.config.json is created, then fixed", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-config-")));
    try {
      writeFileSync(join(dir, "package.json"), '{"name":"t"}');
      const configPath = join(dir, "mx.config.json");
      const configUri = `file://${configPath}`;
      const uri = `file://${join(dir, "a.mx")}`;
      const conn = startClient();
      await conn.sendRequest("initialize", {
        processId: null,
        rootUri: null,
        capabilities: {},
      });
      conn.sendNotification("initialized", {});
      const latest = new Map<string, string[]>();
      conn.onNotification(PublishDiagnosticsNotification, (params) => {
        latest.set(
          params.uri,
          params.diagnostics.map((d) => d.message),
        );
      });
      const until = async (done: () => boolean) => {
        for (let i = 0; i < 300 && !done(); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "mx", version: 1, text: "<p>x</p>\n" },
      });
      await until(() => latest.get(uri)?.length === 0);
      expect(latest.get(uri)).toEqual([]);

      // The file did not exist when the document compiled: only the watcher
      // event says it does now.
      writeFileSync(configPath, '{\n  "host": "htmll"\n}\n');
      conn.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: configUri, type: 1 }],
      });
      await until(() => latest.get(configUri)?.length === 1);
      expect(latest.get(uri)).toHaveLength(1);
      expect(latest.get(configUri)?.[0]).toContain('"htmll"');

      writeFileSync(configPath, '{\n  "host": "html"\n}\n');
      conn.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: configUri, type: 2 }],
      });
      await until(
        () =>
          latest.get(uri)?.length === 0 && latest.get(configUri)?.length === 0,
      );
      expect([latest.get(uri), latest.get(configUri)]).toEqual([[], []]);
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

  it("recognizes a dialect's files by the extensions its package claims, and no other", () => {
    const project = probeProject();
    const uri = (name: string) => pathToFileURL(project.path(name)).href;
    expect(isMxDocument(uri("a.probe"), "")).toBe(true);
    expect(isMxDocument(uri("a.probe.mx"), "")).toBe(true);
    expect(isMxDocument(uri("a.probes"), "")).toBe(false);
    expect(isMxDocument(uri("a.ts"), "typescript")).toBe(false);
    // The same extension in a project with no dialect is no MX document.
    const plain = probeProject({}, { manifest: null });
    expect(isMxDocument(pathToFileURL(plain.path("a.probe")).href, "")).toBe(
      false,
    );
    cleanupProbeProjects();
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
