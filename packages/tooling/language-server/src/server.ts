/**
 * The stdio transport: wires `diagnoseDocument` (see `diagnose.ts`) and
 * `resolveTargetPolicy` (see `/core`'s `host-policy.ts`) into a `vscode-languageserver`
 * connection.
 *
 * Diagnostics only (decision 71/72): `textDocumentSync` is the one
 * capability advertised. No completion, hover, or go-to-definition — Marko's
 * own language server keeps those; this server exists only to surface the
 * host-policy errors Marko's server cannot see (`host-diagnostics.md` §1,
 * `<let>` under a strict policy being valid Marko syntax and therefore
 * invisible to it).
 */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  findMxConfig,
  mxConfigSearchPaths,
  withCalleeInputSources,
} from "@mxlang/core";
import { resolveTargetPolicyDetailed } from "@mxlang/targets";
import {
  dialectExtensionsUnder,
  isDialectFile,
} from "@mxlang/targets/dialect-check";
import {
  createConnection,
  type Diagnostic,
  DidChangeWatchedFilesNotification,
  type Disposable,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  diagnoseDocument,
  REGION_LANGUAGE_IDS,
  type RelatedDiagnostics,
} from "./diagnose.ts";

/** Milliseconds to wait after the last edit before compiling (brief §3). */
/**
 * The files the server asks the client to watch. Installed contracts modules
 * may export JavaScript, not TypeScript. A host-policy diagnostic is about a
 * package.json or MX config file, so fixing it must re-diagnose the documents
 * that reported it, and creating or editing a config file changes what they
 * compile to: every MX config search place matches one of these.
 */
export const WATCHED_FILE_GLOBS: readonly string[] = [
  "**/*.mx",
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.mjs",
  "**/*.cjs",
  "**/package.json",
  "**/mx.config.*",
  "**/.mxrc",
  "**/.mxrc.*",
  "**/.config/mxrc",
  "**/.config/mxrc.*",
];

/** `name` as a glob pattern that matches only itself. */
function escapeGlob(name: string): string {
  return name.replace(/[*?[{}]/g, "[$&]");
}

/**
 * A test for a path against one of the watched globs: `**\/` then a file
 * name pattern (`*` matches within a name), or a directory and a file name.
 */
export function globMatcher(glob: string): (file: string) => boolean {
  const tail = glob
    .replace(/^\*\*\//, "")
    .split("/")
    .map((segment) =>
      segment
        .split("*")
        .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, "\\$&"))
        .join("[^/\\\\]*"),
    )
    .join("[\\\\/]");
  const pattern = new RegExp(`(?:^|[\\\\/])${tail}$`);
  return (file) => pattern.test(file);
}

const DEBOUNCE_MS = 150;

/**
 * The `languageId`s an editor may attach to an MX document. Checked in
 * addition to the file suffix, since some clients open a buffer with no
 * `file://` URI (e.g. `untitled:`) — the suffix check alone would miss it.
 */
const MX_LANGUAGE_IDS = new Set(["mx", ...REGION_LANGUAGE_IDS]);

function isMxDocument(uri: string, languageId: string): boolean {
  return (
    MX_LANGUAGE_IDS.has(languageId) ||
    uri.endsWith(".mx") ||
    isDialectFile(uriPath(uri))
  );
}

/** The file path of a `file:` URI; any other string is returned as it is. */
function uriPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
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

  // What the server publishes against one URI is the union of its own
  // diagnostics (when it is an open document) and the diagnostics other open
  // documents raise on it: a tag template's errors, a `package.json`'s. Last
  // publish must not win, so each part is kept and the union is published.
  //
  // The open documents' own diagnostics, by document URI.
  const ownDiagnostics = new Map<string, Diagnostic[]>();
  // What each open document (the *caller*) raises on other URIs, by target
  // URI then caller URI. A target is not itself open (or, if it is, has its
  // own diagnostics above), so nothing else would ever clear a caller's part.
  const raisedOn = new Map<string, Map<string, Diagnostic[]>>();
  // The targets each caller last raised on: the reverse of `raisedOn`.
  const raisedBy = new Map<string, Set<string>>();

  // Compile-result edges in both directions. Paths are filesystem paths,
  // while callers stay document URIs so their current in-memory text can be
  // fetched from `TextDocuments` when a dependency changes.
  const callerDependencies = new Map<string, Set<string>>();
  const dependencyCallers = new Map<string, Set<string>>();

  /**
   * Publishes the union for `uri`: its own diagnostics, then the ones each
   * caller raised on it (callers in URI order), identical diagnostics once.
   * Open documents of one package all report the same `package.json` problem,
   * and a tag file's own error is the one its callers raise on it, so the
   * same diagnostic from two parts is one diagnostic.
   */
  function publish(uri: string): void {
    const seen = new Set<string>();
    const union: Diagnostic[] = [];
    const add = (list: readonly Diagnostic[]): void => {
      for (const diagnostic of list) {
        const key = JSON.stringify(diagnostic);
        if (seen.has(key)) continue;
        seen.add(key);
        union.push(diagnostic);
      }
    };
    add(ownDiagnostics.get(uri) ?? []);
    const callers = raisedOn.get(uri);
    if (callers) {
      for (const caller of [...callers.keys()].sort()) {
        add(callers.get(caller) ?? []);
      }
    }
    connection.sendDiagnostics({ uri, diagnostics: union });
  }

  /**
   * Replaces what `caller` raises on other URIs by `now`. Returns the URIs it
   * raised on before and no longer does, which must be published again.
   */
  function setRaised(
    caller: string,
    now: ReadonlyMap<string, Diagnostic[]>,
  ): string[] {
    const dropped: string[] = [];
    for (const target of raisedBy.get(caller) ?? []) {
      if (now.has(target)) continue;
      dropped.push(target);
      const callers = raisedOn.get(target);
      callers?.delete(caller);
      if (callers?.size === 0) raisedOn.delete(target);
    }
    for (const [target, list] of now) {
      const callers = raisedOn.get(target) ?? new Map<string, Diagnostic[]>();
      callers.set(caller, list);
      raisedOn.set(target, callers);
    }
    if (now.size > 0) raisedBy.set(caller, new Set(now.keys()));
    else raisedBy.delete(caller);
    return dropped;
  }

  const nearestPackageJson = (file: string): string | undefined => {
    let dir = dirname(file);
    for (;;) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  };

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
    syncExtraWatchers();
  }

  let watchedFilesDynamicRegistration = false;
  let relativePatternSupport = false;
  // The globs the client was asked to watch at start-up: the static ones and
  // the project's dialect extensions.
  let watchedGlobs: readonly ((file: string) => boolean)[] =
    WATCHED_FILE_GLOBS.map(globMatcher);
  const globWatches = (file: string): boolean =>
    watchedGlobs.some((matches) => matches(file));
  // A file a document depends on that no glob above names (a data file a
  // dialect's tag-file hook reads, `ctx.dependsOn`) is watched by its own
  // path, or its change would never reach the server. The watched set is
  // what the open documents depend on now, in one registration.
  let extraRegistered = "[]";
  let extraRegistration: Promise<Disposable | undefined> | undefined;
  function syncExtraWatchers(): void {
    if (!watchedFilesDynamicRegistration) return;
    const wanted = [...dependencyCallers.keys()]
      .filter((file) => !globWatches(file))
      .sort();
    const key = JSON.stringify(wanted);
    if (key === extraRegistered) return;
    extraRegistered = key;
    const watchers = wanted.map((file) => ({
      globPattern: relativePatternSupport
        ? {
            baseUri: pathToFileURL(dirname(file)).href,
            pattern: escapeGlob(basename(file)),
          }
        : file.split(/[\\/]/).map(escapeGlob).join("/"),
    }));
    const previous = extraRegistration;
    extraRegistration = (async () => {
      (await previous)?.dispose();
      if (watchers.length === 0) return undefined;
      try {
        return await connection.client.register(
          DidChangeWatchedFilesNotification.type,
          { watchers },
        );
      } catch (error) {
        // A client that refuses keeps the globs it has; the next change to
        // the set asks again.
        extraRegistered = "";
        connection.console.warn(
          `The client refused to watch ${wanted.join(", ")}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return undefined;
      }
    })();
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
        resolveTargetPolicyDetailed(filePath);
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
      // The package.json and config files the host resolution read are inputs too: the
      // nearest one (so breaking it re-diagnoses) and every one a diagnostic
      // names (so fixing it does).
      const nearest = nearestPackageJson(filePath);
      if (nearest) dependencies.add(nearest);
      // Every MX config search place ahead of (and including) the one in
      // force: creating a nearer `mx.config.ts` re-diagnoses too.
      const configDir = dirname(filePath);
      for (const place of findMxConfig(configDir)?.watch ??
        mxConfigSearchPaths(configDir))
        dependencies.add(place);
      for (const diagnostic of hostPolicyDiagnostics) {
        dependencies.add(diagnostic.file);
      }
      recordDependencies(uri, dependencies);

      // One URI can arrive in several entries (two problems in one
      // `package.json`): this document's part of it is merged.
      const merged = new Map<string, Diagnostic[]>();
      for (const entry of related) {
        merged.set(entry.uri, [
          ...(merged.get(entry.uri) ?? []),
          ...entry.diagnostics,
        ]);
      }
      // What this document raised last time and no longer does is gone from
      // those URIs, and what other documents raise on them stays.
      ownDiagnostics.set(uri, diagnostics);
      const dropped = setRaised(uri, merged);
      publish(uri);
      for (const target of [...dropped, ...merged.keys()]) {
        if (target !== uri) publish(target);
      }
    }, DEBOUNCE_MS);

    pending.set(uri, timer);
  }

  // The workspace's roots, as paths: the dialect extensions the project
  // uses are read from them when the watchers are registered.
  let workspaceRoots: string[] = [];
  connection.onInitialize((params) => {
    workspaceRoots = [
      ...(params.workspaceFolders?.map((folder) => folder.uri) ?? []),
      ...(params.rootUri ? [params.rootUri] : []),
    ].map(pathOf);
    watchedFilesDynamicRegistration =
      params.capabilities.workspace?.didChangeWatchedFiles
        ?.dynamicRegistration === true;
    relativePatternSupport =
      params.capabilities.workspace?.didChangeWatchedFiles
        ?.relativePatternSupport === true;
    return {
      capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental },
    };
  });

  connection.onInitialized(() => {
    if (!watchedFilesDynamicRegistration) return;
    // A dialect's files (tag files included) are not in the static list: a
    // change to one re-checks the files that call it.
    const dialectGlobs = new Set<string>();
    for (const root of new Set(workspaceRoots)) {
      try {
        for (const extension of dialectExtensionsUnder(root)) {
          dialectGlobs.add(`**/*${extension}`);
        }
      } catch {
        // An unreadable root has no dialects to watch.
      }
    }
    const globs = [...WATCHED_FILE_GLOBS, ...dialectGlobs];
    watchedGlobs = globs.map(globMatcher);
    void connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: globs.map((globPattern) => ({ globPattern })),
    });
    // Documents checked before the client was initialized.
    extraRegistered = "[]";
    syncExtraWatchers();
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
    // Closing drops this document's own diagnostics and what it raised on
    // other URIs; what other documents still raise on this URI stays.
    ownDiagnostics.delete(event.document.uri);
    const dropped = setRaised(event.document.uri, new Map());
    publish(event.document.uri);
    for (const target of dropped) publish(target);
    recordDependencies(event.document.uri, new Set());
    callerDependencies.delete(event.document.uri);
    // The callers read this document's text while it was open, and the disk's
    // from now on: a change nobody saved is discarded with the document.
    scheduleDependents(event.document.uri);
  });

  documents.listen(connection);
  connection.listen();

  return connection;
}

export { isMxDocument, MX_LANGUAGE_IDS };
