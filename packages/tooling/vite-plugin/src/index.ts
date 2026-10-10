import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as core from "@mxlang/core";
import {
  type CustomTag,
  isTranslateError,
  otherErrorsText,
  type TargetPolicyDiagnostic,
} from "@mxlang/core";
import type { MxRegionCompile } from "@mxlang/tsx-bridge";
import { print } from "@mxlang/tsx-bridge";
import type { Plugin } from "vite";

/**
 * Keep the registry behind a cached dynamic import, never load compilers while
 * evaluating vite.config.ts. Registry creation installs lazy callee readers;
 * only descriptor load()/compileRegion() reaches the heavy compile leaves.
 */
type RegistryModule = typeof import("@mxlang/targets");
let registryModule: Promise<RegistryModule> | undefined;

function loadRegistry(): Promise<RegistryModule> {
  registryModule ??= import("@mxlang/targets");
  return registryModule;
}

/** The dialect check, behind its own lazy import for the same reason. */
type DialectCheckModule = typeof import("@mxlang/targets/dialect-check");
let dialectCheckModule: Promise<DialectCheckModule> | undefined;

function loadDialectCheck(): Promise<DialectCheckModule> {
  dialectCheckModule ??= import("@mxlang/targets/dialect-check");
  return dialectCheckModule;
}

/**
 * The refusal for a dialect file the build was asked to import, or
 * `undefined` when `file` is no dialect file. Building a file asks its
 * dialect for an emit, and a dialect registers none, so the import is
 * refused with exactly
 * `<dialect> files cannot be imported: the dialect registers no emit`,
 * whatever else is wrong with the file: its own errors are what the checkers
 * report, and the build's answer is the refusal.
 *
 * Positioned where the author has to act: at the specifier in the importing
 * file (`from`: the importer's authored file and the specifier as written),
 * and, for an entry, a hand-built id or an import the emitter added, at the
 * head of the dialect file. The one exception to the text is a file whose
 * extension the project hands to dialects without the routing settling which:
 * no dialect has a name to put in the sentence, so the routing error is the
 * refusal.
 */
async function dialectFileRefusal(
  file: string,
  from?: { importer: string; specifier: string },
): Promise<Error | undefined> {
  const { checkDialectFile, FALLBACK_DIAGNOSTIC_SOURCE, isDialectFile } =
    await loadDialectCheck();
  if (!isDialectFile(file)) return undefined;
  const text = readTemplateSource(file);
  if (text === undefined) return undefined;
  const check = checkDialectFile(file, text);
  if (check === undefined) return undefined;
  const unsettled = check.source === FALLBACK_DIAGNOSTIC_SOURCE;
  const message = unsettled
    ? (check.diagnostics[0]?.message ??
      `${check.source} files cannot be imported: the dialect registers no emit`)
    : `${check.source} files cannot be imported: the dialect registers no emit`;
  const importerText =
    from === undefined || unsettled
      ? undefined
      : readTemplateSource(from.importer)?.replace(/\r\n?/g, "\n");
  const at =
    from === undefined || importerText === undefined
      ? undefined
      : findImportSpecifier(importerText, from.specifier);
  // The authored position goes in `pluginCode` too, so Vite does not map it
  // through the importer's sourcemap (see `unresolvedImport`).
  if (from !== undefined && importerText !== undefined && at !== undefined) {
    return locate(
      Object.assign(new Error(), { plugin: "mx", pluginCode: importerText }),
      { file: from.importer, ...at, source: importerText, message },
    );
  }
  const first = unsettled ? check.diagnostics[0] : undefined;
  return locate(
    Object.assign(new Error(), { plugin: "mx", pluginCode: text }),
    {
      file,
      line: first?.line ?? 1,
      column: first?.column ?? 0,
      source: text,
      message,
    },
  );
}

/** The unnamed tag's name for a file the Vite plugin prints (a `.solid.mx`), resolved quietly: the page transform already reported the policy's warnings. */
async function regionDefaultTag(file: string): Promise<string> {
  const { defaultTagFor, resolveTargetPolicy } = await loadRegistry();
  return defaultTagFor(file, resolveTargetPolicy(file, { quiet: true }));
}

/**
 * The region compile of the file kind `file`'s suffix names, through the
 * registry and the file's project lookup (`lookupFor(policy)`): `.solid.mx`
 * gets Solid's region entry, and every other registered region kind its own
 * host's. A file no region kind claims (only reachable
 * when `extensions` lists a suffix no kind serves) is an error naming it.
 */
async function loadRegionCompile(
  file: string,
  dependencies?: Set<string>,
): Promise<MxRegionCompile> {
  const { lookupFor, regionCompileFor, resolveTargetPolicy } =
    await loadRegistry();
  // The file's own project lookup, as the language server uses: the same
  // answer for a built-in policy, and a loaded target's kinds when it has any.
  const targets = lookupFor(resolveTargetPolicy(file, { quiet: true }));
  const compile = regionCompileFor(file, {
    targets,
    onDependency: (dependency) => dependencies?.add(dependency),
  });
  if (!compile) {
    throw new Error(
      `@mxlang/vite-plugin: no registered host compiles MX regions for "${file}"; a region file is \`.<segment>.mx\` for a host file kind with a region entry`,
    );
  }
  // Core keeps the parser's hoisted AST nodes opaque to avoid a cycle.
  return compile as MxRegionCompile;
}

/**
 * The extensions the plugin claims when `extensions` is not given: every
 * registered region file kind (`.solid.mx`, …) then `.mx`, read from the
 * registry so a new region host needs no edit here.
 */
export async function defaultExtensions(): Promise<string[]> {
  const { regionFileKinds } = await loadRegistry();
  return [...regionFileKinds().map((kind) => `.${kind.segment}.mx`), ".mx"];
}

/** Whole-file compilation selects a target, never the policy's host name. */
async function compileMarko(
  source: string,
  filename: string,
  strict: boolean,
  customTags: Record<string, CustomTag> | undefined,
  resolveImport:
    | ((specifier: string, importer: string) => string | undefined)
    | undefined,
): Promise<core.TargetCompileResult> {
  const { defaultTagFor, lookupFor, resolveTargetPolicy } =
    await loadRegistry();
  const policy = resolveTargetPolicy(filename);
  // The project's lookup: a target loaded from a package specifier included.
  const lookup = lookupFor(policy);
  const descriptor = lookup.target(policy.target);
  const load = descriptor?.load;
  if (!load) {
    const identity = descriptor?.host
      ? `${descriptor.host.name} host`
      : `${policy.target} target`;
    throw new Error(
      `the ${identity} is not wired into @mxlang/vite-plugin yet${descriptor?.pending ? ` (${descriptor.pending})` : ""}`,
    );
  }
  return load(core).compileModule(source, filename, {
    // D1: build strictness is caller-owned, even for an always-strict target.
    strict,
    customTags,
    defaultTag: defaultTagFor(filename, policy),
    // D2: descriptors decide which compile leaves receive the Vite resolver.
    resolveImport,
    targets: lookup,
  });
}

export interface MxPluginOptions {
  /**
   * File extensions handled by the plugin. Defaults to every registered
   * region file kind (`.solid.mx`) and `.mx` ({@link defaultExtensions}).
   */
  extensions?: string[];
  /**
   * Selects `@mxlang/target-html`'s `strictPolicy` for `.mx` files:
   * reactive constructs (`<let>`, `<effect>`, `<lifecycle>`, `<script>`,
   * `client` blocks, `<id>`) become compile errors naming the construct
   * instead of rendering their initial value or compiling away as inert.
   *
   * A passthrough rather than a policy of this plugin's own: a host that has
   * no reactive target (`@mxlang/host-astro` renders MX to static markup at build
   * time, decision 71) wants an author's `<let>` to fail the build with a
   * loc-bearing error rather than silently render once. The flag reaches
   * `compile()` unchanged; `.solid.mx` is unaffected, since it never goes
   * through the translator at all.
   */
  strict?: boolean;
  /**
   * Custom tags supplied directly by the caller, merged over whatever the
   * scan discovers for each compiled file.
   *
   * Discovery (spec §4) is the ordinary route and needs no configuration: a
   * `tags/icon.tag.ts` beside a template is callable as `<icon>` with no
   * import. This option remains for a caller that builds a tag map itself —
   * a test, or a tool generating tags — and it wins over a discovered tag of
   * the same name, since an explicitly supplied definition is the more
   * specific statement of intent.
   */
  customTags?: Record<string, CustomTag>;
}

/** A Marko tag file, compiled when an MX module imports it. */
const TAG_EXT = ".marko";

/**
 * Multi-dot MX extensions that are *not* this plugin's to compile, but which
 * a shorter registered extension would otherwise swallow.
 *
 * `matchExt` tests a plain `endsWith`, so a registered `.mx` matches
 * `Base.any.mx` just as readily as `Base.mx`. `.solid.mx` is not affected,
 * because it is itself registered and the longest-first sort below puts it
 * ahead of `.mx` — this list is for an extension owned by *another* package's
 * plugin, which this one must decline rather than compile through the `.mx`
 * (`compile()` / string) branch.
 *
 * Today: `.astro.mx` (decision 134), the Astro template kind that
 * `@mxlang/host-astro`'s own plugin lowers. A registered `.mx` would otherwise
 * swallow it: `mx()` rewrote `x.astro.mx` to `x.astro.mx.ts`, the Astro plugin
 * re-resolved that to `x.astro.mx.ts.astro`, and the build failed inside
 * `compileMarko`. Any other multi-dot MX extension belonging to another host
 * goes here.
 *
 * Declared as a list rather than inferred from the dot count so the rule is
 * stated where it can be read: a shorter extension never claims a file whose
 * name ends in one of these.
 */
const FOREIGN_EXTENSIONS: string[] = [".astro.mx"];

/**
 * Appended to the resolved path so the rest of the pipeline sees a JS-family
 * module. See the note on `resolveId` below for why this is necessary.
 *
 * Always `.tsx`, for every extension this plugin handles. `.solid.mx` prints
 * JSX text (`print()`) and needs it; so does a `.mx` compiled through a JSX
 * host (`@mxlang/host-preact` emits a component module). A `.mx` compiled through
 * `@mxlang/target-html` emits no JSX, and used to take `.ts` for that reason — but
 * the suffix has to be decided identically by `resolveId` (which holds the
 * real path) and by `isMxModule` (which holds only the already-suffixed one),
 * and the host is a property of the *file's* nearest `package.json`. Deriving
 * it in both places would mean resolving the host policy from a path that
 * does not exist on disk. One suffix for all of them keeps that round trip
 * exact; a `.tsx` file whose code contains no JSX is still ordinary
 * TypeScript, and rolldown's JSX transform over it is a no-op.
 */
function suffixFor(_ext: string): string {
  return ".tsx";
}

/** `suffixFor(".solid.mx")`, kept as a named export for existing callers/tests. */
export const MX_SUFFIX = ".tsx";

/** A parse error as the vendored Babel parser raises it. */
interface MxSyntaxError extends Error {
  loc?: { line: number; column: number; index?: number };
  pos?: number;
  code?: string;
  reasonCode?: string;
}

/**
 * A parse error about authored source: a `SyntaxError` (by name, since the
 * vendored Babel's class is not this realm's) whose `loc` is Babel-shaped.
 * A plain `Error` that merely has a `loc` is an mx bug on generated output
 * and must keep its stack, so `"loc" in err` alone is not enough.
 */
function isSyntaxError(err: unknown): err is MxSyntaxError {
  if (!(err instanceof Error) || err.name !== "SyntaxError") return false;
  const loc = (err as { loc?: { line?: unknown; column?: unknown } }).loc;
  return typeof loc?.line === "number" && typeof loc.column === "number";
}

/** Splits a module id into its path and its `?query`/`#hash` suffix. */
function splitId(id: string): [path: string, suffix: string] {
  const index = id.search(/[?#]/);
  return index === -1 ? [id, ""] : [id.slice(0, index), id.slice(index)];
}

/**
 * Queries that mean "do not give me this module's compiled form".
 *
 * Mirrors Vite's own `SPECIAL_QUERY_RE`. `?raw` wants the file's text, `?url`
 * its URL, `?worker`/`?sharedworker` a worker wrapper — in every case Vite
 * serves the real file itself, so MX must not claim the id or print it.
 */
const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url)\b/;

/**
 * A one-line code frame: the offending line plus a caret under `column`.
 *
 * Vite does not export `generateCodeFrame` from its public entry (checked at
 * runtime against 8.2.2: the export is `undefined`), so the frame the error
 * overlay renders is built here instead. `line` is 1-based and `column` is
 * 0-based, matching what the Babel parser raises.
 */
export function codeFrame(
  source: string,
  line: number,
  column: number,
): string {
  const lines = source.split("\n");
  const target = lines[line - 1];
  if (target === undefined) return "";

  const gutter = `${line} | `;
  const caretPad = " ".repeat(gutter.length + Math.max(0, column));
  return `${gutter}${target}\n${caretPad}^`;
}

/**
 * Reads a tag template's current source so a `TranslateError` raised inside
 * it (spec §2's third position rule) can build its Vite overlay frame from
 * the *template's* own text, not the caller's.
 *
 * The named file may no longer exist, or be unreadable (deleted mid-compile,
 * a permissions issue), between the original compile's own read and this
 * one — a failure here must not replace the real diagnostic with a raw
 * ENOENT, so it only ever costs the frame, never the message, `id` or
 * position: `undefined` on failure, never a thrown error.
 *
 * `read` is injected (defaults to `node:fs`'s `readFileSync`) so a test can
 * exercise the failure path directly, without reaching for stack
 * introspection or a real filesystem race.
 */
export function readTemplateSource(
  file: string,
  read: (path: string, encoding: "utf8") => string = (path, encoding) =>
    readFileSync(path, encoding),
): string | undefined {
  try {
    return read(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The Vite/Rollup error shape this plugin raises for a user-facing error. */
type LocatedError = Error & {
  id?: string;
  frame?: string;
  loc?: { file: string; line: number; column: number };
};

/**
 * Re-shapes an error about the *authored* source into what a build log can
 * print compactly: `id`, `loc` and `frame` for the position, and a `stack`
 * that is only `Name: message`.
 *
 * Rolldown (and Vite's overlay) print `error.stack` after the location, so an
 * expected compile error used to drag ~50 internal frames (translator, Babel,
 * rolldown) into every failing build — an agent reading the log pays for them
 * and learns nothing from them. Only errors about the user's source go through
 * here; a bug in mx itself keeps its stack and is rethrown untouched.
 *
 * `column` is 0-based, like every other `loc` this plugin raises.
 */
function locate(
  err: Error,
  at: {
    file: string;
    line: number;
    column: number;
    source: string | undefined;
    message?: string;
  },
): LocatedError {
  const located = err as LocatedError;
  if (at.message !== undefined) located.message = at.message;
  located.id = at.file;
  located.loc = { file: at.file, line: at.line, column: at.column };
  if (at.source !== undefined) {
    located.frame = codeFrame(at.source, at.line, at.column);
  }
  located.stack = `${err.name}: ${located.message}`;
  return located;
}

/**
 * Re-points the *header* of this plugin's own build errors at the authored
 * file, and returns how many it re-labelled.
 *
 * A failing `vite build` prints each diagnostic through rolldown's
 * `getErrorMessage`, which builds its location line from
 * `e.id ?? e.loc?.file` — and, for an error a plugin hook threw, rolldown has
 * already stamped `e.id` with the **module id** (`e.id = this.moduleId` in
 * `TransformPluginContextImpl.error`, and the same for a hook error caught on
 * the way out of `transform`). For MX that module id is the suffixed
 * `<path>.mx.tsx` this plugin minted, a file that does not exist on disk, so
 * the one line an agent follows to a location named a path nobody wrote:
 *
 *     [plugin mx] /…/src/page.mx.tsx:1:0
 *     CompileError: Missing ending "div" tag
 *
 * `locate()` cannot fix that from inside the hook — the position and the
 * authored `loc.file` are already right, and `this.error({ id, loc })` is
 * overwritten before it is ever read. `buildEnd` runs before rolldown
 * aggregates and formats the diagnostics (`aggregateBindingErrorsIntoJsError`
 * → `getErrorMessage`), so rewriting `id` there is the last point at which it
 * is still the plugin's to own.
 *
 * Deliberately narrow, because the aggregate carries every error in the
 * build:
 *
 * - only `plugin === "mx"` entries — another plugin's diagnostic, and every
 *   module id in the graph besides this plugin's own, are left exactly as
 *   they were;
 * - only entries without a `kind`. A `kind` marks a diagnostic rolldown
 *   rendered itself (`[builtin:vite-transform]`, `[PARSE_ERROR]`, …): its
 *   `id` is absent and the generated path is baked into an
 *   already-formatted `message`, whose line:column is a position in
 *   *generated* text. This plugin has no source map for the `.mx` path, so
 *   there is no authored position to offer, and relabelling the path alone
 *   would print a real file with a line that does not exist in it — the same
 *   reason the unresolved-import path leaves those to rolldown (audit item 10);
 * - `authoredId` is the only thing that decides what an id is, so a `.tsx`
 *   file that is not one of ours cannot be renamed.
 *
 * Every write is guarded: the diagnostics are napi-backed objects owned by
 * rolldown, and a diagnostic this cannot re-label must still fail the build.
 */
export function relabelBuildErrors(
  error: unknown,
  authoredId: (id: string) => string | undefined,
): number {
  const errors = (error as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors)) return 0;
  let relabeled = 0;
  for (const entry of errors) {
    if (entry === null || typeof entry !== "object") continue;
    const diagnostic = entry as {
      id?: unknown;
      loc?: { file?: unknown; column?: unknown };
      plugin?: unknown;
      kind?: unknown;
    };
    if (diagnostic.plugin !== "mx" || Object.hasOwn(diagnostic, "kind")) {
      continue;
    }
    try {
      if (typeof diagnostic.id === "string") {
        const authored = authoredId(diagnostic.id);
        if (authored !== undefined) {
          // Rolldown stamps the caller's virtual id even when core's error
          // is measured in a callee. The locator's file and coordinates are
          // a pair; keep that file rather than attaching its line to the caller.
          diagnostic.id =
            typeof diagnostic.loc?.file === "string"
              ? (authoredId(diagnostic.loc.file) ?? diagnostic.loc.file)
              : authored;
          // Only the build-render aggregate is converted. `locate` and the
          // dev overlay keep Vite's 0-based structured columns; rolldown
          // prints this column verbatim, so its header must be 1-based (#227).
          if (typeof diagnostic.loc?.column === "number") {
            diagnostic.loc.column = Math.max(0, diagnostic.loc.column) + 1;
          }
          relabeled++;
        }
      }
      const file = diagnostic.loc?.file;
      if (typeof file === "string") {
        const authored = authoredId(file);
        if (authored !== undefined && diagnostic.loc) {
          diagnostic.loc.file = authored;
        }
      }
    } catch {
      // A frozen (or otherwise unwritable) diagnostic is not this hook's
      // problem to solve: the build still fails, with the generated name.
    }
  }
  return relabeled;
}

/**
 * Extensions a bundler handles itself, on a file no dialect is likely to own:
 * code, styles, data, images, fonts, media and the templates of other tools.
 * An import ending in any other extension may be a dialect's file, whichever
 * package declares the dialect (the root's, the importer's, a sibling's, one
 * in `node_modules`), and is resolved to find out. A dialect that does claim
 * one of these is still found through its own project's extensions.
 */
const NATIVE_EXTENSIONS: ReadonlySet<string> = new Set(
  `js mjs cjs jsx ts tsx mts cts json json5 css scss sass less styl html htm
   svg png jpg jpeg gif webp avif ico bmp woff woff2 ttf otf eot mp3 mp4 webm
   wav ogg txt md mdx wasm vue svelte astro marko mx map node yaml yml toml
   xml csv`.split(/\s+/),
);

/** The lower-cased extension of the last path segment of `path`, without its dot, or `undefined`. */
const extensionOf = (path: string): string | undefined => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : name.slice(dot + 1).toLowerCase();
};

/**
 * A specifier worth asking the resolver about: not a virtual module (`\0…`),
 * a `data:` URL or a remote URL, none of which are files a build resolves.
 */
const isProbeable = (specifier: string): boolean =>
  !specifier.startsWith("\0") && !/^(?:data|https?):/.test(specifier);

/**
 * Where `specifier` is written in an authored `.mx` source as the operand of
 * an import: the 1-based line and 0-based column of its opening quote.
 *
 * The source is scanned rather than the generated module because the `.mx`
 * path has no source map (see `transform`): the specifier is the only thing
 * both texts share. The scan is a small lexer, not a text search, so the same
 * text in a `//` or `/* *\/` comment, or inside a longer string, is not
 * mistaken for the import. A string counts only when it directly follows
 * `from` or `import`, or is the argument of `import(` / `require(`. Quotes are
 * closed at the end of their line (a `'` in template text, as in `don't`, must
 * not swallow the file); backticks may span lines.
 *
 * `undefined` when the specifier is not written as an import operand — an
 * import the emitter added — and the caller then has no authored position.
 */
function findImportSpecifier(
  source: string,
  specifier: string,
): { line: number; column: number } | undefined {
  let line = 1;
  let lineStart = 0;
  let last = "";
  let beforeLast = "";
  const push = (token: string): void => {
    beforeLast = last;
    last = token;
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === "\n") {
      line++;
      lineStart = ++i;
      continue;
    }
    if (ch === "\r" || ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let j = i; j < stop; j++) {
        if (source[j] === "\n") {
          line++;
          lineStart = j + 1;
        }
      }
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      const startLine = line;
      const startColumn = i - lineStart;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") i++;
        else if (source[i] === "\n") {
          if (ch !== "`") break;
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      const closed = source[i] === ch;
      if (closed) i++;
      const isOperand =
        last === "from" ||
        last === "import" ||
        (last === "(" && (beforeLast === "import" || beforeLast === "require"));
      if (closed && isOperand && source.slice(start + 1, i - 1) === specifier) {
        return { line: startLine, column: startColumn };
      }
      push('"');
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i, i + 64));
    if (word) {
      push(word[0]);
      i += word[0].length;
      continue;
    }
    push(ch);
    i++;
  }
  return undefined;
}

/**
 * The error for an import in an authored `.mx` file that nothing resolves.
 *
 * Left to rolldown it names the generated `page.mx.tsx`, at a position in
 * generated text, with a full stack (audit item 10). Raised here it names the
 * authored file at the specifier, with `loc` and `frame` carrying the position
 * (`column` 0-based, like every other `loc` this plugin raises).
 */
function unresolvedImport(
  source: string,
  specifier: string,
): Error | undefined {
  // Normalized first: a `\r` would reach the code frame, and a lone `\r` is a
  // line break to an editor but not to the scan below.
  const text = readTemplateSource(source)?.replace(/\r\n?/g, "\n");
  const at =
    text === undefined ? undefined : findImportSpecifier(text, specifier);
  if (text === undefined || at === undefined) return undefined;
  const error = Object.assign(new Error(), {
    code: "UNRESOLVED_IMPORT",
    plugin: "mx",
    // The dev server resolves an import while transforming its importer, and
    // Vite then rewrites the error it catches: it maps `err.loc` through that
    // importer's sourcemap as if it were a position in the *generated* module
    // (the authored `page.mx:2:17` became `page.mx.tsx:7:14`, Vite 8.2.2), and
    // stamps its own `plugin`, `pos` and the generated code on it. An error
    // that already has `pluginCode` is returned untouched (`_formatLog`), and
    // this one is already authored, so it carries the authored source there.
    pluginCode: text,
  });
  return locate(error, {
    file: source,
    ...at,
    source: text,
    message: `Could not resolve "${specifier}"`,
  });
}

/** A Marko `CompileError`: a parse error in an authored `.mx` template. */
function isMarkoCompileError(err: unknown): err is Error & {
  label?: unknown;
  loc?: { file?: unknown };
} {
  return err instanceof Error && err.name === "CompileError";
}

/**
 * Reads the position out of a Marko `CompileError`.
 *
 * `err.loc` is `{ file }` only — no line, no column — so the sole source of
 * the position is the `at <path>:<line>:<column>` line the message starts
 * with (1-based column, path relative to the cwd and so not worth printing).
 * Anchored to a whole line so a `:L:C` inside the quoted code frame below it
 * cannot match first. `undefined` when the message has no such line.
 *
 * kleur colourises that header under `FORCE_COLOR` — path, line and column
 * each wrapped in their own SGR runs — so the position is parsed out of a
 * stripped copy; the raw message is left untouched.
 */
function markoPosition(
  err: Error,
): { line: number; column: number } | undefined {
  const match = /^[ \t]*at[ \t]+.+:(\d+):(\d+)[ \t]*$/m.exec(
    stripVTControlCharacters(err.message),
  );
  if (!match) return undefined;
  return { line: Number(match[1]), column: Math.max(0, Number(match[2]) - 1) };
}

/**
 * Compiles `.solid.mx` and `.mx` ahead of the rest of the pipeline.
 *
 * `.solid.mx` prints to JSX source text (`print()`, from `@mxlang/tsx-bridge`)
 * ahead of `@solidjs/vite-plugin`. Ordering: this plugin is `enforce: "pre"`,
 * matching `@solidjs/vite-plugin`'s own hard-coded `enforce: "pre"`, so
 * relative order between the two is the order they appear in the user's
 * `plugins` array — put `mx()` first. Solid then sees ordinary JSX text and
 * runs whichever compiler it is configured for; both the native (default)
 * and Babel backends consume source text, so neither needs special-casing
 * here.
 *
 * `.mx` compiles to a module whose default export is `(input) => string`,
 * carrying the sink entry `render(input, out)` as `.render` (decision 155) (or a JSX component
 * module, per the resolved host) via `compileMarko()` — the same whole-file
 * translator `examples/mx-site` and `@mxlang/target-html/bun` use, so a `.mx`
 * template behaves identically whether it is loaded by Vite or by Bun.
 * `compile()`'s returned map is presently an identity placeholder (see its
 * own doc comment — the translator builds text directly, not from a printed
 * AST), so this plugin has no real source map to hand Vite yet for that
 * extension; `transform` returns `map: null` for it rather than a
 * placeholder Vite would treat as real. `.marko` is not an MX
 * extension: it is never claimed by itself, and `extensions` rejects it. It
 * is only compiled when an MX module imports it (`tags/*.marko`, Marko's own
 * tag discovery), through the host of the tag's own `package.json`.
 *
 * Why `resolveId` rewrites the id to `<path><ext>.tsx`/`.ts` rather than just
 * returning the resolved path — three separate parts of the pipeline dispatch
 * on the file extension, and neither `.solid.mx` nor `.mx` satisfies any of
 * them:
 *
 * 1. Vite routes a module into the JS pipeline only when its extension matches
 *    `JS_TYPES_RE` (`/\.(?:j|t)sx?$|\.mjs$/`). Without a `resolveId` hook the
 *    import is never resolved at all and `transform` never runs.
 * 2. Rolldown picks its parser dialect from the extension, so printed JSX text
 *    parsed as `.mx` would fail ("Unexpected JSX expression"). Returning
 *    `moduleType: "tsx"` from `transform` fixes the parse but then hands the
 *    module to rolldown's own JSX transform, which resolves
 *    `react/jsx-runtime` — irrelevant for `.mx`'s plain compiled function, and
 *    exactly why it gets `.ts` instead.
 * 3. `@solidjs/vite-plugin` only compiles ids passing its `filter`, whose
 *    default is `src/**\/*.{jsx,tsx,tsrx,ts,js,mjs,cjs}`; that test runs
 *    before its `options.extensions` list is consulted, so registering the
 *    extension there cannot bring `.solid.mx` back in. `.mx` never reaches
 *    Solid's plugin at all — its compiled output has no JSX for Solid to see.
 *
 * A suffixed id satisfies all three at once with no configuration on the
 * user's side, which is why the example's `vite.config.ts` is just
 * `plugins: [mx(), solid()]`. `load` reads the real file from disk (strip the
 * suffix) and `transform` prints or compiles it; diagnostics keep the
 * original filename.
 *
 * The path itself comes from Vite's own resolver (`this.resolve`), never from
 * arithmetic here. Doing the path math locally got every non-trivial form
 * wrong: it mangled the importer's directory, treated root-relative and
 * `/@fs/` ids as filesystem paths, and never resolved aliases or bare
 * specifiers at all.
 */
export default function mx(options: MxPluginOptions = {}): Plugin {
  let aliases: Array<{ find: string | RegExp; replacement: string }> = [];
  const aliasResolver = (specifier: string): string | undefined => {
    for (const alias of aliases) {
      if (typeof alias.find === "string") {
        if (specifier !== alias.find && !specifier.startsWith(`${alias.find}/`))
          continue;
        return alias.replacement + specifier.slice(alias.find.length);
      }
      if (alias.find.test(specifier)) {
        alias.find.lastIndex = 0;
        return specifier.replace(alias.find, alias.replacement);
      }
    }
    return undefined;
  };
  let resolveImport: typeof aliasResolver | undefined;
  // MX only supports the MX 1.0 subset of Marko syntax, so a caller cannot
  // opt back into `.marko` through `extensions` — that would silently claim
  // support this plugin does not have. Rejected eagerly, at plugin
  // construction, rather than left to surface later as a confusing runtime
  // mismatch.
  if (options.extensions?.some((ext) => ext.endsWith(".marko"))) {
    throw new Error(
      "@mxlang/vite-plugin: '.marko' is not a supported extension — MX only compiles the MX 1.0 subset of Marko syntax under '.mx'.",
    );
  }
  // Longest first: `.mx` is a string suffix of `.solid.mx`, so a caller-
  // supplied `extensions` in the other order must not silently misroute a
  // `.solid.mx` file through the `.mx` (compile()/HTML) branch instead of
  // `.solid.mx` (print()/JSX) — sorting once here makes both `matchExt` and
  // `isMxModule` order-independent regardless of the order `extensions` is
  // given in.
  const longestFirst = (list: readonly string[]) =>
    [...list].sort((a, b) => b.length - a.length);
  // The default comes from the registry, which stays behind its lazy import:
  // every async hook awaits `ensureExtensions()` first. Until then the sync
  // hooks (`load`, `handleHotUpdate`) match on `.mx` alone, which is all they
  // need: they strip the module suffix and read or forget the authored file,
  // and every registered extension ends in `.mx`. Which branch compiles the
  // file is decided in `transform`, after the real list is in.
  let extensions: string[] = options.extensions
    ? longestFirst(options.extensions)
    : [".mx"];
  let extensionsResolved = options.extensions !== undefined;
  const ensureExtensions = async (): Promise<void> => {
    if (extensionsResolved) return;
    extensions = longestFirst(await defaultExtensions());
    extensionsResolved = true;
  };
  // A file whose name ends in a multi-dot extension belonging to another MX
  // host is not this plugin's, even when a shorter registered extension is a
  // string suffix of it. Skipped when the caller registered that extension
  // explicitly, so an opt-in `extensions: [".astro.mx"]` still works.
  const isForeign = (file: string): boolean =>
    FOREIGN_EXTENSIONS.some(
      (ext) => file.endsWith(ext) && !extensions.includes(ext),
    );
  /**
   * Which MX modules depend on which compilation *inputs*, so an edit to one
   * can invalidate the callers that used it.
   *
   * Two kinds of input land here, both recorded per transform:
   *
   * - Custom-tag *locations* from the tag scan (below). A custom tag is an
   *   input to compilation that appears nowhere in the importing module's
   *   text, so Vite's own module graph has no edge to follow. Keyed by
   *   **directory as well as file**: keying by file alone only covers tags
   *     that already existed when the scan ran, so creating
   *   `tags/new.tag.ts` matched nothing — and `handleHotUpdate` then fell
   *   through to `matchExt`, which is undefined for `.tag.ts` — leaving
   *   callers serving stale output until a restart. A new file's *directory*
   *   is one the scan already recorded, which is what makes the creation
   *   observable.
   * - The compile result's `dependencies` (decision 106): the callee files
   *   whose `Input` the compiler read to resolve attribute-tag shapes — a
   *   caller imports a component through ordinary ESM, so Vite's graph
   *   *does* contain that edge, but only the compiled module's own HMR
   *   update; the caller's compiled output also changes, and without this
   *   edge it would keep serving the stale shape.
   */
  const dependencySources = new Map<string, Set<string>>();

  /**
   * The scan locations one caller's last transform consulted, so they can be
   * pruned independently from the compile-result dependencies below.
   */
  const dependedOn = new Map<string, Set<string>>();

  /**
   * The tags callable from one MX file: everything discovered around it, with
   * any caller-supplied definition layered on top.
   *
   * Called per transform rather than once per build, because two files in one
   * project can sit under different `tags/` directories. The scan itself is
   * cached and invalidated by mtime, so this costs one filesystem walk per
   * directory per change, not one per file.
   */
  /**
   * Scan diagnostics already reported, so a rebuild does not repeat them.
   *
   * Keyed by the offending file plus its message: the same misconfigured
   * `package.json` is re-read on every transform in that package, and warning
   * once per compiled file would bury the build log in one typo.
   */
  const reported = new Set<string>();

  const tagsFor = async (
    file: string,
    warn: (message: string) => void,
    error: (diagnostic: TargetPolicyDiagnostic) => never,
  ): Promise<Record<string, CustomTag> | undefined> => {
    const { resolveTargetPolicyDetailed, lookupFor, scanCached } =
      await loadRegistry();
    const resolution = resolveTargetPolicyDetailed(file);
    for (const diagnostic of resolution.diagnostics) {
      if (diagnostic.severity === "error") error(diagnostic);
    }
    // The filter value `mx.tags[].hosts` is matched against, read off the
    // target: for a hostless target (`html`) it is the target's legacy
    // `mx.host` value, which is the string existing entries already match.
    const targets = lookupFor(resolution.policy);
    const host = targets.hostFilterKey(resolution.policy.target) ?? null;
    const scan = scanCached(file, { host, targets });

    // Errors were raised above, before warning dedupe: repeating a transform
    // cannot make a bad target pass. Existing malformed-manifest/unknown-host
    // warnings remain non-fatal and are deduped like the scan's.
    for (const diagnostic of resolution.diagnostics) {
      const key = `${diagnostic.file}\u0000${diagnostic.message}`;
      if (reported.has(key)) continue;
      reported.add(key);
      warn(
        `${diagnostic.file}:${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`,
      );
    }

    // A misconfigured `mx.tags` is not fatal — the local `tags/` directories
    // still work — but it is silent without this, which is worse: an author
    // sees a tag simply not resolve, with nothing saying why.
    for (const diagnostic of scan.diagnostics) {
      const key = `${diagnostic.file}\u0000${diagnostic.message}`;
      if (reported.has(key)) continue;
      reported.add(key);
      warn(`${diagnostic.file}: ${diagnostic.message}`);
    }
    const locations = new Set<string>([
      ...scan.directories,
      ...scan.files.map((entry) => entry.path),
      ...scan.packageFiles,
      ...(scan.configFiles ?? []),
    ]);

    // Drop this caller from inputs its previous transform used and this one
    // does not, so a long-lived dev server's map tracks the project rather
    // than every state the project has ever been in.
    for (const stale of dependedOn.get(file) ?? []) {
      if (locations.has(stale)) continue;
      const dependents = dependencySources.get(stale);
      if (!dependents) continue;
      dependents.delete(file);
      if (dependents.size === 0) dependencySources.delete(stale);
    }
    dependedOn.set(file, locations);

    for (const location of locations) {
      const dependents = dependencySources.get(location) ?? new Set<string>();
      dependents.add(file);
      dependencySources.set(location, dependents);
    }

    const discovered = scan.customTags;
    if (!options.customTags) {
      return Object.keys(discovered).length > 0 ? discovered : undefined;
    }
    return { ...discovered, ...options.customTags };
  };

  /** Forgets a caller entirely: it was deleted, or is no longer ours. */
  const forgetCaller = (file: string): void => {
    for (const location of dependedOn.get(file) ?? []) {
      const dependents = dependencySources.get(location);
      if (!dependents) continue;
      dependents.delete(file);
      if (dependents.size === 0) dependencySources.delete(location);
    }
    dependedOn.delete(file);
    for (const dependency of dependencyCallers.get(file) ?? []) {
      const dependents = dependencySources.get(dependency);
      if (!dependents) continue;
      dependents.delete(file);
      if (dependents.size === 0) dependencySources.delete(dependency);
    }
    dependencyCallers.delete(file);
  };

  /**
   * Records the callee files one caller's compile read (decision 106) as
   * dependency edges, pruning edges the previous transform held but this one
   * does not. Empty until the core resolver is wired into lowering, so this
   * is a no-op on today's compiles — the map and its invalidation are in
   * place ahead of the first dependency arriving.
   */
  const recordDependencies = (
    caller: string,
    dependencies: readonly string[] | undefined,
  ): void => {
    const current = dependencies ?? [];
    const previous = dependencyCallers.get(caller) ?? new Set<string>();
    for (const stale of previous) {
      if (current.includes(stale)) continue;
      const dependents = dependencySources.get(stale);
      if (!dependents) continue;
      dependents.delete(caller);
      if (dependents.size === 0) dependencySources.delete(stale);
    }
    dependencyCallers.set(caller, new Set(current));
    for (const dependency of current) {
      const dependents = dependencySources.get(dependency) ?? new Set<string>();
      dependents.add(caller);
      dependencySources.set(dependency, dependents);
    }
  };

  /**
   * The compile dependencies one caller's last transform held, so they can
   * be pruned. Separate from `dependedOn` (the scan locations) only so the
   * two sources stay distinguishable in one caller's entry; both prune the
   * same `dependencySources` map.
   */
  const dependencyCallers = new Map<string, Set<string>>();

  const matchExt = (file: string): string | undefined =>
    isForeign(file) ? undefined : extensions.find((ext) => file.endsWith(ext));
  /**
   * An id this plugin rewrote: an MX module, or a `tags/*.marko` tag that an
   * MX module imports (see `resolveId`). The tag's extension is `.marko`, but
   * it never joins `extensions`: that list decides which *imports* the plugin
   * claims on sight, and a `.marko` file must only be claimed when MX code
   * asked for it.
   */
  const isMxModule = (file: string): string | undefined =>
    extensions.find((ext) => file.endsWith(ext + suffixFor(ext))) ??
    (file.endsWith(TAG_EXT + suffixFor(TAG_EXT)) ? TAG_EXT : undefined);
  /** A file this plugin compiles from disk: matched by extension, or a tag. */
  const sourceExt = (file: string): string | undefined =>
    matchExt(file) ?? (file.endsWith(TAG_EXT) ? TAG_EXT : undefined);
  /** `/a/App.solid.mx.tsx` -> `/a/App.solid.mx`; `/a/x.mx.ts` -> `/a/x.mx` */
  const sourcePath = (file: string, ext: string) =>
    file.slice(0, -suffixFor(ext).length);
  /**
   * The located error for `specifier` imported by `importer`, when `importer`
   * is an MX module and the specifier is written in its authored source;
   * `undefined` otherwise, and the caller leaves the failure to rolldown.
   */
  const unresolvedFrom = (
    importer: string,
    specifier: string,
  ): Error | undefined => {
    const [importerPath] = splitId(importer);
    const ext = isMxModule(importerPath);
    return ext === undefined
      ? undefined
      : unresolvedImport(sourcePath(importerPath, ext), specifier);
  };
  const refuseDialectLoad = async (path: string): Promise<null> => {
    if (await claimedByDialect(path, undefined)) {
      const refusal = await dialectFileRefusal(path);
      if (refusal) throw refusal;
    }
    return null;
  };
  /** The Vite project root, once known (`configResolved`). */
  let projectRoot: string | undefined;
  /**
   * The authored file behind `importer` (the file for a JS/TS importer, the
   * `.mx` source for one of this plugin's virtual ids) and the specifier as
   * written, for a dialect refusal to point at the import.
   */
  const importSite = (
    importer: string | undefined,
    specifier: string,
  ): { importer: string; specifier: string } | undefined => {
    if (importer === undefined) return undefined;
    const [importerPath] = splitId(importer);
    const ext = isMxModule(importerPath);
    return {
      importer:
        ext === undefined ? importerPath : sourcePath(importerPath, ext),
      specifier,
    };
  };
  /**
   * Whether an import of `path` may be a dialect's file, a cheap pre-filter
   * so that not every import is resolved twice: `path` ends in an extension
   * no bundler handles itself (`NATIVE_EXTENSIONS`), or one that a dialect of
   * the project root (any package under it), of the importer's own project or
   * of the file's own directory claims. Whether the resolved file is a
   * dialect's is then decided on the file, by its own package
   * (`isDialectFile`): a workspace package, a sibling of the root or a
   * dependency may declare the dialect that its importer's package does not.
   * Cached per directory for the length of a build: an import of anything
   * else must not read a manifest each time.
   */
  const dialectExtensionsAt = new Map<string, readonly string[]>();
  let rootDialectExtensions: readonly string[] | undefined;
  const claimedByDialect = async (
    path: string,
    importer: string | undefined,
  ): Promise<boolean> => {
    const extension = extensionOf(path);
    if (extension !== undefined && !NATIVE_EXTENSIONS.has(extension)) {
      return true;
    }
    const directory = dirname(importer ?? path);
    const check = await loadDialectCheck();
    if (rootDialectExtensions === undefined) {
      rootDialectExtensions =
        projectRoot === undefined
          ? []
          : check.dialectExtensionsUnder(projectRoot);
    }
    let claimed = dialectExtensionsAt.get(directory);
    if (claimed === undefined) {
      claimed = check.dialectExtensions(directory);
      dialectExtensionsAt.set(directory, claimed);
    }
    const endsWithClaimed = (ext: string) =>
      path.length > ext.length && path.endsWith(ext);
    return (
      claimed.some(endsWithClaimed) ||
      rootDialectExtensions.some(endsWithClaimed)
    );
  };
  /**
   * The authored file behind one of this plugin's virtual module ids, with any
   * `?query`/`#hash` carried across, or `undefined` for an id this plugin did
   * not mint. `relabelBuildErrors`'s only notion of "ours".
   */
  const authoredId = (id: string): string | undefined => {
    const [path, query] = splitId(id);
    const ext = isMxModule(path);
    return ext === undefined ? undefined : sourcePath(path, ext) + query;
  };

  return {
    name: "mx",
    enforce: "pre",

    configResolved(config) {
      projectRoot = config.root;
      aliases = [...config.resolve.alias];
      resolveImport = aliases.length > 0 ? aliasResolver : undefined;
      void loadRegistry();
    },

    async buildStart() {
      dialectExtensionsAt.clear();
      rootDialectExtensions = undefined;
      await ensureExtensions();
    },

    /**
     * Names the authored file in the header of this plugin's own build
     * errors, which rolldown builds from the virtual module id. Runs before
     * the diagnostics are aggregated and formatted, and is a no-op for every
     * error that is not one of ours (see `relabelBuildErrors`).
     */
    buildEnd(error) {
      relabelBuildErrors(error, authoredId);
    },

    async resolveId(id: string, importer: string | undefined) {
      await ensureExtensions();
      const [path, suffix] = splitId(id);

      // `?raw`, `?url`, `?worker`: the caller wants the file itself, not the
      // module MX would print. Decline so Vite serves the real MX file —
      // rewriting here would point its raw handler at a path that does not
      // exist on disk.
      if (SPECIAL_QUERY_RE.test(id)) return null;

      // Already rewritten (a re-resolve of our own id): keep it as is.
      if (isMxModule(path) !== undefined) return id;

      // `import _badge from "./tags/badge.marko"`: the import every host's
      // emitter writes for a `tags/*.marko` tag (#187), as Marko does. Nothing
      // else in a Vite build handles `.marko` (that is `@marko/vite`'s job,
      // and its output is a Marko runtime template, not the function MX's
      // emitted call expects), so the tag is compiled here, by the same
      // whole-file path as the page. Claimed only for an importer that is
      // itself ours — a stray `.marko` import elsewhere stays untouched.
      if (path.endsWith(TAG_EXT)) {
        if (!importer || isMxModule(splitId(importer)[0]) === undefined) {
          return null;
        }
        const resolved = await this.resolve(id, importer, { skipSelf: true });
        if (!resolved) {
          const error = unresolvedFrom(importer, path);
          if (error) throw error;
          return null;
        }
        if (resolved.external) return null;
        const [resolvedPath, resolvedSuffix] = splitId(resolved.id);
        if (!resolvedPath.endsWith(TAG_EXT)) return null;
        return resolvedPath + suffixFor(TAG_EXT) + (resolvedSuffix || suffix);
      }

      const ext = matchExt(path);
      if (ext === undefined) {
        // A dialect file with an extension of its own (`.probe`): nothing else
        // in the build can read it, so the import is refused where it is made.
        if (await claimedByDialect(path, importer)) {
          const resolved = await this.resolve(id, importer, { skipSelf: true });
          if (resolved && !resolved.external) {
            const refusal = await dialectFileRefusal(
              splitId(resolved.id)[0],
              importSite(importer, path),
            );
            if (refusal) throw refusal;
          }
        }
        // Not ours to rewrite, but an import written in an authored MX file
        // that nothing resolves is ours to report: rolldown would name the
        // generated `page.mx.tsx` at a generated position (audit item 10).
        // The probe is a plain `this.resolve` through the rest of the chain —
        // what rolldown would do next — and a hit is returned as is, so the
        // chain below runs once per import, not twice, and a resolvable
        // import resolves exactly as before.
        if (importer && isProbeable(path) && isMxModule(splitId(importer)[0])) {
          const probed = await this.resolve(id, importer, { skipSelf: true });
          if (probed) return probed;
          const error = unresolvedFrom(importer, path);
          if (error) throw error;
        }
        return null;
      }

      // Delegate to Vite: this handles relative ids against the real importer
      // directory, root-relative (`/src/x.mx`) and `/@fs/` forms,
      // `resolve.alias`, and bare specifiers into workspace packages.
      // `skipSelf` stops this hook from recursing into itself.
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (!resolved) {
        const error = importer && unresolvedFrom(importer, path);
        if (error) throw error;
        return null;
      }

      const [resolvedPath, resolvedSuffix] = splitId(resolved.id);
      const resolvedExt = matchExt(resolvedPath);
      if (resolvedExt === undefined) return null;

      // `.probe.mx` is `.mx` to the extension list and a dialect file to its
      // project: the dialect builds it, not this plugin.
      const refusal = await dialectFileRefusal(
        resolvedPath,
        importSite(importer, path),
      );
      if (refusal) throw refusal;

      // Carry the query across the rewrite. Vite appends its own (`?t=` on an
      // HMR re-fetch, `?import`), and dropping it would turn a cache-busted
      // request into a stale one.
      return resolvedPath + suffixFor(resolvedExt) + (resolvedSuffix || suffix);
    },

    load(id: string) {
      const [path] = splitId(id);
      const ext = isMxModule(path);
      if (ext === undefined) {
        // The backstop for a dialect file that reached the build without an
        // import this plugin could see (a dependency's import, an alias, a
        // glob): refused at the head of the file, by its own package.
        // Only an extension no bundler handles itself is asked about here, so
        // an ordinary module costs nothing; a dialect that claims one of the
        // native extensions is refused at its import.
        const extension = extensionOf(path);
        return isAbsolute(path) &&
          extension !== undefined &&
          !NATIVE_EXTENSIONS.has(extension)
          ? refuseDialectLoad(path)
          : null;
      }

      // A real `Foo.solid.mx.tsx` on disk is a different module and must not
      // be shadowed: only claim the id when the un-suffixed MX file is the
      // one that actually exists.
      const source = sourcePath(path, ext);
      if (!existsSync(source)) return null;

      return readFileSync(source, "utf8");
    },

    /**
     * Bridges the on-disk file back to the suffixed module.
     *
     * Vite keys its module graph by the resolved id, which for MX is
     * `<path><ext><suffix>` — a path that does not exist on disk. An edit to
     * the real MX file therefore matches no module, so without this hook Vite
     * finds nothing to invalidate and sends no update at all.
     */
    handleHotUpdate(ctx) {
      const [file] = splitId(ctx.file);
      const graph = ctx.server.moduleGraph;

      // A caller that no longer exists should not keep its edges alive.
      if (matchExt(file) !== undefined && !existsSync(file)) forgetCaller(file);

      // An edited, created or deleted tag file — or a `package.json` carrying
      // `mx.tags` — is not itself a module, but every MX file whose scan read
      // it now compiles differently. Invalidate those, so a saved tag reaches
      // the page without a manual reload.
      //
      // Matched by the file *and* by its directory: a newly created
      // `tags/new.tag.ts` was in no scan's file list, so only the directory
      // entry can connect it to the callers that scanned there.
      const dependents = new Set([
        ...(dependencySources.get(file) ?? []),
        ...(dependencySources.get(dirname(file)) ?? []),
      ]);
      if (dependents.size > 0) {
        const stale = [...dependents]
          .map((dependent) => {
            const dependentExt = sourceExt(dependent);
            return dependentExt === undefined
              ? undefined
              : graph.getModuleById(dependent + suffixFor(dependentExt));
          })
          .filter((mod) => mod !== undefined && mod !== null);
        for (const mod of stale) graph.invalidateModule(mod);
        if (stale.length > 0) return [...ctx.modules, ...stale];
      }

      const ext = sourceExt(file);
      if (ext === undefined) return;

      const mod = graph.getModuleById(file + suffixFor(ext));
      if (!mod) return;

      graph.invalidateModule(mod);
      return [...ctx.modules, mod];
    },

    async transform(code: string, id: string) {
      await ensureExtensions();
      const [path] = splitId(id);
      const ext = isMxModule(path);
      if (ext === undefined) return null;

      // An entry or a hand-built id reaches here without `resolveId`.
      const refusal = await dialectFileRefusal(sourcePath(path, ext));
      if (refusal) throw refusal;

      // Rollup's own warning channel, so a misconfigured `mx.tags` reaches the
      // build log and the dev-server overlay the way any other plugin warning
      // does. `this` is the plugin context here; captured because `tagsFor`
      // runs below inside a `try`.
      // SAFETY: Rollup invokes transform with its PluginContext; direct test
      // callers may omit warn, which is checked before it is invoked.
      const context = this as unknown as {
        warn?: (message: string) => void;
        error?: (error: LocatedError) => never;
      };
      const warn = (message: string): void => {
        if (context.warn) context.warn(`@mxlang/vite-plugin: ${message}`);
        else console.warn(`@mxlang/vite-plugin: ${message}`);
      };

      let policyErrorRaised = false;
      const policyError = (diagnostic: TargetPolicyDiagnostic): never => {
        const error = locate(
          new Error(
            `${diagnostic.file}:${diagnostic.line}:${diagnostic.column + 1}: ${diagnostic.message}`,
          ),
          {
            file: diagnostic.file,
            line: diagnostic.line,
            column: diagnostic.column,
            source: readTemplateSource(diagnostic.file),
          },
        );
        policyErrorRaised = true;
        if (context.error) return context.error(error);
        throw error;
      };

      // Print/compile against the real MX path so the source map and any
      // error position name the file the user actually wrote.
      const source = sourcePath(path, ext);

      try {
        if (ext === ".mx" || ext === TAG_EXT) {
          // Install registered callee readers even for direct hook callers.
          await loadRegistry();
          // `compile()`'s map is presently an identity placeholder (no AST
          // is printed on this path), so there is nothing real to hand Vite
          // — returning it would claim a mapping that does not exist.
          const { code: compiled, dependencies } = await compileMarko(
            code,
            source,
            options.strict ?? false,
            await tagsFor(source, warn, policyError),
            resolveImport,
          );
          recordDependencies(source, dependencies);
          return { code: compiled, map: null };
        }

        // A region file (`.solid.mx`, or any other registered region kind)
        // reaches its host through the parser, which lowers each MX region
        // with the region entry the registry names for this suffix; the
        // registered tags have to travel with it or a tag registered here is
        // unknown inside a region. The parser has no host of its own, so the
        // compile is supplied explicitly here, the same as every region caller.
        const dependencies = new Set<string>();
        const { code: printed, map } = print(code, source, {
          mx: true,
          customTags: await tagsFor(source, warn, policyError),
          defaultTag: await regionDefaultTag(source),
          mxRegionCompile: await loadRegionCompile(source, dependencies),
        });
        recordDependencies(source, [...dependencies]);
        return { code: printed, map };
      } catch (err) {
        // Policy errors already carry package.json coordinates (this.error
        // may wrap them). Other scan/compile errors need the locator below.
        if (policyErrorRaised) throw err;
        // A `TranslateError` raised while compiling a tag template
        // (`tags/x.mx`) carries `.file`, the template's own path (spec §2's
        // third position rule), never a `.loc` — so `isSyntaxError` is
        // always false for it and it used to be rethrown raw, with no
        // position Vite's overlay could show at all. Build the wrapped
        // error from the *template's* source when `.file` names one, the
        // same fallback order `foreignTemplateError`
        // (`@mxlang/typescript-plugin`) uses for the editor side: `.file` is
        // absent for an error about the file being compiled, in which case
        // this still reports against `source`/`code` as before.
        if (isTranslateError(err)) {
          const errorFile = err.file ?? source;
          const errorSource = err.file ? readTemplateSource(err.file) : code;
          // The message opens with the file it is about; `id` and `loc`
          // already say so, and the path is the costliest part of the line.
          const prefix = `${errorFile}: `;
          // A callee parse failure retains Marko's frames, without their path
          // headers. `locate` builds the overlay frame from the callee source
          // at a single position, so only the caret reasons belong in the
          // error message — and *every* frame's reason, not just the first:
          // a callee with several parse errors arrives as one error carrying
          // one frame each, and the other consumers (core's message, the
          // language server's `data.codeFrame`) keep all of them.
          const plain = stripVTControlCharacters(err.message);
          const reasons = /^[ \t]*(?:>[ \t]*)?\d+ \|/.test(plain)
            ? [...plain.matchAll(/^[ \t]*\|[ \t]*\^+[ \t]+(\S.*)$/gm)].map(
                (match) => match[1] as string,
              )
            : [];
          const reason = reasons.length > 0 ? reasons.join("\n") : undefined;
          // A build throws one error; the file's other errors (decision 162)
          // ride in its message, so a fix-all pass sees them in one run.
          const rest = otherErrorsText(err);
          const own =
            reason ??
            (err.message.startsWith(prefix)
              ? err.message.slice(prefix.length)
              : undefined);
          throw locate(err, {
            file: errorFile,
            line: err.line,
            column: err.column,
            source: errorSource,
            message: rest === "" ? own : `${own ?? plain}${rest}`,
          });
        }

        // A Marko `CompileError` (a parse error in a `.mx` template) has no
        // `loc.line`/`loc.column`, only the position in its message, so it
        // used to print `page.mx.tsx:undefined:undefined`.
        if (isMarkoCompileError(err)) {
          const position = markoPosition(err);
          if (!position) throw err;
          const errorFile =
            typeof err.loc?.file === "string" ? err.loc.file : source;
          throw locate(err, {
            file: errorFile,
            ...position,
            source: errorFile === source ? code : readTemplateSource(errorFile),
            // Marko's own message is `\n    at <path>:L:C` plus a code frame;
            // `label` is the reason alone, and `loc` + `frame` replace the
            // rest. Both carry kleur's SGR runs under FORCE_COLOR, and the
            // build log prints `message` verbatim, so the label is stripped.
            message:
              typeof err.label === "string"
                ? stripVTControlCharacters(err.label)
                : undefined,
          });
        }

        if (!isSyntaxError(err) || !err.loc) throw err;

        // Babel appends its own 1-based `(line:column)` to the message while
        // `loc.column` is 0-based. Leaving both in place shows the reader two
        // different columns for one error, so drop the suffix and let `loc`
        // and `frame` carry the position.
        throw locate(err, {
          file: source,
          line: err.loc.line,
          column: err.loc.column,
          source: code,
          message: err.message.replace(/\s*\(\d+:\d+\)\s*$/, ""),
        });
      }
    },
  };
}
