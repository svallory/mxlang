/**
 * The stdio transport: wires `diagnoseDocument` (see `diagnose.ts`) and
 * `resolveHostPolicy` (see `/core`'s `host-policy.ts`) into a `vscode-languageserver`
 * connection.
 *
 * Diagnostics only (decision 71/72): `textDocumentSync` is the one
 * capability advertised. No completion, hover, or go-to-definition — Marko's
 * own language server keeps those; this server exists only to surface the
 * host-policy errors Marko's server cannot see (`host-diagnostics.md` §1,
 * `<let>` under a strict policy being valid Marko syntax and therefore
 * invisible to it).
 */

import { fileURLToPath } from "node:url";
import {
  resolveHostPolicyDetailed,
  withCalleeInputSources,
} from "@mxlang/core";
import {
  createConnection,
  type Diagnostic,
  DidChangeWatchedFilesNotification,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  diagnoseDocument,
  isSolidMxDocument,
  type RelatedDiagnostics,
} from "./diagnose.ts";

/** Milliseconds to wait after the last edit before compiling (brief §3). */
const DEBOUNCE_MS = 150;

/**
 * The `languageId`s an editor may attach to an MX document. Checked in
 * addition to the file suffix, since some clients open a buffer with no
 * `file://` URI (e.g. `untitled:`) — the suffix check alone would miss it.
 */
const MX_LANGUAGE_IDS = new Set(["mx"]);

function isMxDocument(uri: string, languageId: string): boolean {
  return (
    isSolidMxDocument(uri, languageId) ||
    MX_LANGUAGE_IDS.has(languageId) ||
    uri.endsWith(".mx")
  );
}

/**
 * Starts the server on stdio. Returns the connection so a test can drive it
 * over an in-memory duplex instead (see `server.test.ts`).
 */
export function startServer(
  connectionFactory: () => ReturnType<typeof createConnection> = () =>
    createConnection(ProposedFeatures.all),
) {
  const connection = connectionFactory();
  const documents = new TextDocuments(TextDocument);

  // One pending debounce timer per document URI; a superseded run is
  // cancelled by clearing and replacing its timer, never by racing two
  // compiles for the same document.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  // Template URIs each open document last published diagnostics against, so
  // they can be cleared when that document stops reporting them. Keyed by the
  // *caller*: a template is not itself open, so nothing else would ever clear
  // its diagnostics.
  const templateDiagnostics = new Map<string, Set<string>>();

  // Compile-result edges in both directions. Paths are filesystem paths,
  // while callers stay document URIs so their current in-memory text can be
  // fetched from `TextDocuments` when a dependency changes.
  const callerDependencies = new Map<string, Set<string>>();
  const dependencyCallers = new Map<string, Set<string>>();

  const pathOf = (uri: string): string => {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  };

  const openSources = (): Map<string, string> =>
    new Map(
      documents
        .all()
        .map((document) => [pathOf(document.uri), document.getText()]),
    );

  function recordDependencies(uri: string, current: Set<string>): void {
    for (const dependency of callerDependencies.get(uri) ?? []) {
      const callers = dependencyCallers.get(dependency);
      callers?.delete(uri);
      if (callers?.size === 0) dependencyCallers.delete(dependency);
    }
    callerDependencies.set(uri, current);
    for (const dependency of current) {
      const callers = dependencyCallers.get(dependency) ?? new Set<string>();
      callers.add(uri);
      dependencyCallers.set(dependency, callers);
    }
  }

  function scheduleDiagnostics(uri: string, languageId: string, text: string) {
    if (!isMxDocument(uri, languageId)) return;

    const existing = pending.get(uri);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      pending.delete(uri);
      let filePath = uri;
      try {
        // `fileURLToPath`, not `new URL(uri).pathname`: the latter leaves
        // `%20` etc. percent-encoded and, on Windows, yields a leading-slash
        // form (`/C:/Users/...`) neither `path.join` nor `path.dirname`
        // treats as that drive's root — both would make the package.json
        // walk in `/core`'s host-policy.ts silently find nothing and fall back to
        // the default policy instead of the file's real one.
        filePath = fileURLToPath(uri);
      } catch {
        // Not a file:// URI (e.g. untitled:); resolvePolicyObject/Diagnose
        // work fine on the raw string, they only use it for messages and,
        // for policy resolution, an upward directory walk that will simply
        // find nothing and fall back to the default.
      }

      const { policy: hostPolicy, diagnostics: hostPolicyDiagnostics } =
        resolveHostPolicyDetailed(filePath);
      // Diagnostics raised inside a tag template belong to that file, not to
      // this one, and are published against its own URI below.
      const related: RelatedDiagnostics[] = [];
      // `filePath`, not `uri`: everything `diagnoseDocument` does with this
      // argument is filesystem work — resolving the host, and walking upward
      // for `tags/` directories. `resolve("file:///a/page.mx")` yields
      // `<cwd>/file:/a/page.mx`, a path that exists nowhere, so passing the
      // raw URI made the scan find no tags for any real document while every
      // test that called `diagnoseDocument` with a plain path passed. The URI
      // is still what diagnostics are published against, below.
      const dependencies = new Set<string>();
      const diagnostics: Diagnostic[] = withCalleeInputSources(
        openSources(),
        () =>
          diagnoseDocument(
            text,
            filePath,
            hostPolicy,
            (error) =>
              connection.console.error(
                `@mxlang/language-server: unexpected error compiling ${uri}: ${String(error)}`,
              ),
            languageId,
            undefined,
            related,
            dependencies,
            hostPolicyDiagnostics,
          ),
      );
      recordDependencies(uri, dependencies);
      connection.sendDiagnostics({ uri, diagnostics });

      // Clear whatever this document published against a template last time
      // before publishing what it found now, so a fixed template's diagnostic
      // does not linger once the caller compiles clean.
      const previous = templateDiagnostics.get(uri) ?? new Set<string>();
      const current = new Set(related.map((entry) => entry.uri));
      for (const templateUri of previous) {
        if (!current.has(templateUri)) {
          connection.sendDiagnostics({ uri: templateUri, diagnostics: [] });
        }
      }
      for (const entry of related) {
        connection.sendDiagnostics({
          uri: entry.uri,
          diagnostics: entry.diagnostics,
        });
      }
      if (current.size > 0) templateDiagnostics.set(uri, current);
      else templateDiagnostics.delete(uri);
    }, DEBOUNCE_MS);

    pending.set(uri, timer);
  }

  let watchedFilesDynamicRegistration = false;
  connection.onInitialize((params) => {
    watchedFilesDynamicRegistration =
      params.capabilities.workspace?.didChangeWatchedFiles
        ?.dynamicRegistration === true;
    return {
      capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental },
    };
  });

  connection.onInitialized(() => {
    if (!watchedFilesDynamicRegistration) return;
    void connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: [
        { globPattern: "**/*.mx" },
        { globPattern: "**/*.amx" },
        { globPattern: "**/*.ts" },
        { globPattern: "**/*.tsx" },
      ],
    });
  });

  function scheduleDependents(changedUri: string): void {
    const changedPath = pathOf(changedUri);
    for (const callerUri of dependencyCallers.get(changedPath) ?? []) {
      if (callerUri === changedUri) continue;
      const caller = documents.get(callerUri);
      if (!caller) continue;
      scheduleDiagnostics(caller.uri, caller.languageId, caller.getText());
    }
  }

  documents.onDidOpen((event) => {
    scheduleDiagnostics(
      event.document.uri,
      event.document.languageId,
      event.document.getText(),
    );
  });

  documents.onDidChangeContent((event) => {
    scheduleDiagnostics(
      event.document.uri,
      event.document.languageId,
      event.document.getText(),
    );
    scheduleDependents(event.document.uri);
  });

  documents.onDidSave((event) => {
    scheduleDiagnostics(
      event.document.uri,
      event.document.languageId,
      event.document.getText(),
    );
    scheduleDependents(event.document.uri);
  });

  connection.onDidChangeWatchedFiles((params) => {
    for (const change of params.changes) {
      const document = documents.get(change.uri);
      if (document) {
        scheduleDiagnostics(
          document.uri,
          document.languageId,
          document.getText(),
        );
      }
      scheduleDependents(change.uri);
    }
  });

  documents.onDidClose((event) => {
    const timer = pending.get(event.document.uri);
    if (timer) {
      clearTimeout(timer);
      pending.delete(event.document.uri);
    }
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    for (const templateUri of templateDiagnostics.get(event.document.uri) ??
      []) {
      connection.sendDiagnostics({ uri: templateUri, diagnostics: [] });
    }
    templateDiagnostics.delete(event.document.uri);
    recordDependencies(event.document.uri, new Set());
    callerDependencies.delete(event.document.uri);
  });

  documents.listen(connection);
  connection.listen();

  return connection;
}

export { isMxDocument, MX_LANGUAGE_IDS };
