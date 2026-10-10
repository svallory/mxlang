import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  createAmxLanguagePlugin,
  createMxLanguagePlugin,
  createNgMxLanguagePlugin,
  createSolidMxLanguagePlugin,
  type MxDiagnosticLanguagePlugin,
} from "@mxlang/typescript-plugin";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import {
  diagnoseDocument,
  type RelatedDiagnostics,
} from "../../language-server/src/diagnose.ts";
import mxVite, { MX_SUFFIX } from "../../vite-plugin/dist/index.js";
import { runInProcess } from "./in-process.ts";

/**
 * Pins, per fixture directory, what each tool produces today for the same
 * source: the language server's diagnostics, the TypeScript plugin's
 * generated text, mappings and diagnostics, the Vite transform's output, and
 * `mx-tsc`'s output. The goldens under `fixtures/host-dispatch/__golden__/`
 * are the contract a refactor of the per-target dispatch must leave unchanged
 * (design note host-self-registration, §6.2).
 *
 * They record behaviour at the base commit, warts included. Where one tool
 * disagrees with another (D1–D6 of the design note, §1.5), or a later PR
 * changes a row on purpose, the row says so below; the golden still holds
 * whatever the tools print today. Regenerate with `-u` (see AGENTS.md of this
 * package) and call the rewrite out in the PR.
 *
 * `mx-tsc` runs once, in this process, over one tsconfig that includes every
 * fixture directory: each file's target comes from its nearest package.json,
 * so one program covers all rows, and the output is split per row by path.
 */

const here = import.meta.dirname;
const root = realpathSync(join(here, "fixtures", "host-dispatch"));
const repo = realpathSync(join(here, "..", "..", "..", ".."));
const goldens = join(root, "__golden__");

/**
 * Rows the plan names as changing on purpose in a later PR, and the
 * disagreements that PR 0 pins as they are today. Rows not listed here must
 * stay byte-identical through every refactor PR.
 *
 * - html-strict, astro: D1. Vite compiles with `options.strict ?? false`,
 *   while the language server and the TypeScript plugin force `astro` strict.
 *   Pinned as is; the Vite leg of both rows shows it.
 * - alias-html/-preact/-react/-hono: D2. `resolveImport` reaches the compile
 *   in Vite only, so the `~/Card.mx` import resolves there and nowhere else.
 * - every row's TypeScript plugin `mappings`: D3. The mapping pass always
 *   looks tags up through html's translator, whatever the target.
 * - angular: D4. A page `.mx` is silent in the language server, throws in the
 *   TypeScript plugin and in Vite.
 * - astro: D5. The language server has no branch of its own for it; it takes
 *   the html compile.
 * - astro-mx-html-host: D6. The `.astro.mx` scan filter is the literal "astro", so a
 *   tag restricted to `hosts: ["astro"]` stays visible to an `.astro.mx` page in a
 *   package whose own target is html.
 * - tags-x-ng: PR 3 (design note §5.1, rule (d), case 1) produced **no**
 *   change to these bytes: the host-module message is worded the same and is
 *   now produced through the registry lookup, so the row still passes as it
 *   stood.
 * - tags-icon-small: changed in PR 3 (§5.1, rule (d), case 2: a dotted tag
 *   name that cannot be called is rejected with a diagnostic; it was indexed
 *   silently). Regenerated.
 * - tags-hosts-package: changed in PR 3 (§5, condition 5: `mx.tags[].hosts`
 *   naming a package specifier must not warn, and the specifier is still not a
 *   filter value this project can match). Regenerated. The bare-word warning
 *   stays, as tags-hosts-bogus pins.
 * - html-with-solid-dep: `mx.host: "html"` beats rule 2 (a lone `@mxlang/host-solid`
 *   dependency would otherwise pick solid). PR 3 rewrites rule 2.
 * - translator: the deprecated alias for html and its warning.
 * - tags-hosts-html: a `hosts: ["html"]` tag restriction on an html project
 *   stays visible; PR 3 moves the unknown-name check, not this match.
 * - unknown-host, bad-package-json: #215's policy diagnostics. PR 7 adds new
 *   codes beside them and leaves these.
 */
const ROWS = [
  "html",
  "html-strict",
  "astro",
  "solid",
  "preact",
  "react",
  "hono",
  "angular",
  "solid-file",
  "ng-file",
  "astro-mx",
  "astro-mx-html-host",
  "alias-html",
  "alias-preact",
  "alias-react",
  "alias-hono",
  "unknown-host",
  "bad-package-json",
  "tags-x-ng",
  "tags-icon-small",
  "tags-hosts-bogus",
  "tags-hosts-package",
  "html-with-solid-dep",
  "translator",
  "tags-hosts-html",
  // PR 3b (§6.2): additive rows only; all earlier goldens stay unchanged.
  "target-html",
  "target-html-solid-dep",
  "target-solid",
  "target-agree-solid",
  "target-agree-html",
  "target-mismatch-host",
  "target-mismatch-hostless",
  "target-mismatch-legacy",
  "target-host-name",
  "target-unknown",
  "target-typo",
  "target-package",
  "target-data",
  "target-unknown-host",
  "tags-hosts-target",
  // Registration PR 7 (§6.2): a package specifier under mx.target / mx.host
  // loads a third-party target. Additive rows. Each target is a local
  // `./target.cjs` re-exporting the shared fake package of
  // `test-fixtures/third-party-targets`.
  "third-party-ok",
  "third-party-ok-host",
  "third-party-fail",
  "third-party-missing",
  "third-party-throws",
  "third-party-invalid",
  "third-party-version",
  "third-party-hostless-under-host",
  // Round 2: a page html would reject (no html second lowering for a loaded
  // target without declarations), and a bare mx.host naming the loaded host.
  "third-party-ok-let",
  "third-party-host-name",
  // Decision 145 (the unnamed tag): the package's `mx.<target>.defaultTag`
  // reaches every tool's compile (`my-card` from `tags/`), an invalid value
  // is one positioned error at the package.json value in each tool and the
  // built-in answers meanwhile.
  "default-tag-html",
  "default-tag-invalid",
  // Decision 146 (the `:name` sugar), PR 3: valid sugar in every position on a
  // string host and a JSX host (the JSX row pins the mapped name/class/id
  // tokens), a typed template tag whose `name` prop gets the wrong type (the
  // TS error lands on the sugar token), and one row per PR 2 error: a second
  // `:` in the tag head, a value on the sugar, sugar right after a default
  // value and a dynamic shorthand in attribute position. The stock-parser error
  // cannot arise here (the repo installs the patched parser); its positions in
  // every tool are pinned by `sugar-stock-parser.test.ts`.
  "sugar-html",
  "sugar-preact",
  "sugar-typed",
  "sugar-second-colon",
  // Decision 146 addendum 4: `=value` / `(params) { body }` after a sugar sets
  // the default attribute, so `sugar-value` is now the second-default-value
  // error (at the second) and `sugar-default-value` the valid forms, on a JSX
  // host so the mapped value is pinned.
  "sugar-value",
  "sugar-default-value",
  "sugar-default-attr",
  "sugar-dynamic-shorthand",
  // A bare `:` in attribute position (leader ruling, PR 3 round 2): one error
  // at the `:`, first, after a value and in concise mode.
  "sugar-bare-colon",
] as const;

/** Rows whose Vite leg resolves `~/` through a configured alias. */
const ALIASED = new Set(ROWS.filter((row) => row.startsWith("alias-")));

// `@mxlang/targets` is the language server's dependency, not this
// package's: resolve it from the server so both sides use the copy the server
// runs. It is where the resolver now lives for a tool (decisions 129/132), and
// its `resolveTargetPolicyDetailed` is core's, bound to the built-in lookup.
const lsRequire = createRequire(
  join(here, "..", "..", "language-server", "package.json"),
);
const { hostFilterKey, resolveTargetPolicyDetailed } = (await import(
  pathToFileURL(lsRequire.resolve("@mxlang/targets")).href
)) as {
  resolveTargetPolicyDetailed(file: string): {
    policy: Parameters<typeof diagnoseDocument>[2];
    diagnostics: NonNullable<Parameters<typeof diagnoseDocument>[8]>;
  };
  hostFilterKey(target: string): string | undefined;
};

/**
 * The resolved policy as the golden records it: the value `mx.tags[].hosts` is
 * matched against, which is the host name for a hosted target and a hostless
 * target's legacy `mx.host` value (`html`). It is the same string the policy
 * carried before the policy named a target first (decisions 129/132), so every
 * row that does not change behaviour keeps its recorded bytes; the tools get
 * the real policy.
 */
function recordedPolicy(policy: Parameters<typeof diagnoseDocument>[2]): {
  host: string;
  strict?: boolean;
} {
  return {
    host: (hostFilterKey(policy.target) ??
      (policy as { descriptor?: { host?: { name: string } } }).descriptor?.host
        ?.name) as string,
    ...(policy.strict === undefined ? {} : { strict: policy.strict }),
  };
}

/**
 * Makes a value comparable across machines and shells: absolute paths become
 * `<root>` (the fixture directory) or `<repo>`, ANSI colour is dropped (agent
 * shells set NO_COLOR, CI colourises), and strings keep their text otherwise.
 * `mx-tsc` prints paths relative to the cwd, so that prefix is replaced too.
 */
function normalise<T>(value: T): T {
  const cwdRelative = relative(process.cwd(), root);
  const clean = (text: string): string => {
    let out = stripVTControlCharacters(text)
      .replaceAll(root, "<root>")
      .replaceAll(repo, "<repo>");
    if (cwdRelative !== "") {
      out = out.replaceAll(`${cwdRelative}/`, "<root>/");
    }
    return out;
  };
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "string" ? clean(v) : v)),
  ) as T;
}

function mxFilesOf(row: string): string[] {
  return readdirSync(join(root, row))
    .filter((name) => /\.mx$/.test(name))
    .sort();
}

type Plugin = MxDiagnosticLanguagePlugin & {
  createVirtualCode?: (
    fileName: string,
    languageId: string,
    snapshot: ts.IScriptSnapshot,
    ctx: unknown,
  ) => { snapshot: ts.IScriptSnapshot; languageId: string; mappings: unknown };
  getTargetPolicyDiagnostics?: (fileName?: string) => unknown;
};

/** The language plugin `mx-tsc` and tsserver pick for a file name. */
function pluginFor(file: string): { plugin: Plugin; languageId: string } {
  if (file.endsWith(".astro.mx")) {
    return {
      plugin: createAmxLanguagePlugin(ts) as Plugin,
      languageId: "astromx",
    };
  }
  if (file.endsWith(".ng.mx")) {
    return {
      plugin: createNgMxLanguagePlugin(ts) as unknown as Plugin,
      languageId: "ngmx",
    };
  }
  if (file.endsWith(".solid.mx")) {
    return {
      plugin: createSolidMxLanguagePlugin(ts) as unknown as Plugin,
      languageId: "solidmx",
    };
  }
  return {
    plugin: createMxLanguagePlugin(ts) as Plugin,
    languageId: "mx",
  };
}

function languageServerLeg(file: string, text: string, languageId: string) {
  const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
  const related: RelatedDiagnostics[] = [];
  const dependencies = new Set<string>();
  const unexpected: string[] = [];
  const reported = diagnoseDocument(
    text,
    pathToFileURL(file).href,
    policy,
    (error) => unexpected.push(String(error)),
    languageId,
    undefined,
    related,
    dependencies,
    diagnostics,
  );
  return {
    policy: recordedPolicy(policy),
    diagnostics: reported,
    related,
    dependencies: [...dependencies].sort(),
    unexpected,
  };
}

/** An untitled buffer: no path, identified only by its language id. */
function untitledLeg(file: string, text: string) {
  const { policy } = resolveTargetPolicyDetailed(file);
  const related: RelatedDiagnostics[] = [];
  const unexpected: string[] = [];
  const diagnostics = diagnoseDocument(
    text,
    "untitled:Untitled-1",
    policy,
    (error) => unexpected.push(String(error)),
    "solidmx",
    undefined,
    related,
  );
  return { policy: recordedPolicy(policy), diagnostics, related, unexpected };
}

function tsPluginLeg(file: string, text: string) {
  const { plugin, languageId } = pluginFor(file);
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    const virtual = plugin.createVirtualCode?.(
      file,
      languageId,
      ts.ScriptSnapshot.fromString(text),
      { getAssociatedScript: () => undefined },
    );
    const compileDiagnostics = plugin.getCompileDiagnostics(file).map(
      // `source` is the whole file again; the offset locates the problem.
      ({ source: _source, ...rest }) => rest,
    );
    return {
      languageId: virtual?.languageId ?? null,
      generated: virtual
        ? virtual.snapshot.getText(0, virtual.snapshot.getLength())
        : null,
      mappings: virtual?.mappings ?? null,
      compileDiagnostics,
      hostPolicyDiagnostics: plugin.getTargetPolicyDiagnostics
        ? plugin.getTargetPolicyDiagnostics(file)
        : "not offered by this plugin",
      logged,
    };
  } finally {
    console.warn = warn;
  }
}

async function viteLeg(row: string, file: string, text: string) {
  if (file.endsWith(".astro.mx"))
    return "not handled: no .astro.mx in this plugin";
  const plugin = mxVite() as unknown as {
    configResolved(config: unknown): void;
    transform(
      this: unknown,
      code: string,
      id: string,
    ): Promise<{ code: string; map: unknown } | null>;
  };
  if (ALIASED.has(row as never)) {
    plugin.configResolved({
      resolve: { alias: [{ find: "~", replacement: join(root, row) }] },
    });
  }
  const warnings: string[] = [];
  try {
    const result = await plugin.transform.call(
      {
        warn: (message: string) => warnings.push(message),
        error: (error: Error) => {
          throw error;
        },
      },
      text,
      file + MX_SUFFIX,
    );
    return { code: result?.code ?? null, map: result?.map ?? null, warnings };
  } catch (cause) {
    const error = cause as Error & {
      id?: string;
      loc?: unknown;
      frame?: string;
    };
    return {
      threw: {
        name: error.name,
        message: error.message,
        id: error.id,
        loc: error.loc,
        frame: error.frame,
      },
      warnings,
    };
  }
}

/** One `mx-tsc` program over every fixture; resolved in `beforeAll`. */
interface TscRun {
  status: number;
  byRow: Map<string, string[]>;
  unattributed: string[];
}

function splitByRow(output: string): Pick<TscRun, "byRow" | "unattributed"> {
  const byRow = new Map<string, string[]>();
  const unattributed: string[] = [];
  // A diagnostic starts at column 0 with a path or a tag; whatever is
  // indented under it (code frame, related text) belongs to it.
  const blocks: string[] = [];
  for (const line of output.split("\n")) {
    if (line === "") continue;
    if (/^\s/.test(line) && blocks.length > 0) {
      blocks[blocks.length - 1] += `\n${line}`;
    } else blocks.push(line);
  }
  for (const block of blocks) {
    const row = /<root>\/([^/\s:()]+)\//.exec(block.split("\n")[0] ?? "")?.[1];
    if (row && (ROWS as readonly string[]).includes(row)) {
      byRow.set(row, [...(byRow.get(row) ?? []), block]);
    } else unattributed.push(block);
  }
  return { byRow, unattributed };
}

let tsc: TscRun;

beforeAll(() => {
  const result = runInProcess(
    [
      "--astro",
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      join(root, "tsconfig.json"),
    ],
    here,
  );
  tsc = {
    status: result.status,
    ...splitByRow(normalise(`${result.stdout}\n${result.stderr}`)),
  };
}, 120_000);

describe("dispatch goldens", () => {
  it("covers every fixture directory", () => {
    const onDisk = readdirSync(root)
      .filter((name) => statSync(join(root, name)).isDirectory())
      .filter((name) => name !== "__golden__")
      .sort();
    expect(onDisk).toEqual([...ROWS].sort());
  });

  it.each(ROWS)("%s", { timeout: 60_000 }, async (row) => {
    const files: Record<string, unknown> = {};
    for (const name of mxFilesOf(row)) {
      const file = join(root, row, name);
      const text = readFileSync(file, "utf8");
      if (row === "bad-package-json") {
        // Only the host-policy output is pinned for this row. Compiling a file
        // beside a malformed package.json depends on the process cwd: Marko's
        // Babel config lookup throws "Error while parsing JSON" for it when
        // vitest runs from the repo root (`bun run test`) and not from this
        // package's directory, so generated text, mappings and the compile
        // diagnostics differ between the two. Reported, not fixed here (TODO
        // compile-beside-malformed-package-json-cwd). The policy warning also
        // names the package.json this file's target was taken from instead
        // (`<repo>/packages/tooling/tsc/package.json`), so the golden depends
        // on that file's `mx` field staying `html`.
        const lsLeg = languageServerLeg(file, text, "mx");
        files[name] = {
          languageServer: lsLeg.diagnostics.filter((d) =>
            String(d.message).includes("package.json"),
          ),
          // Keep the recorded JSON key byte-identical; it is not an API name.
          tsPluginHostPolicy: tsPluginLeg(file, text).hostPolicyDiagnostics,
        };
        continue;
      }
      const entry: Record<string, unknown> = {
        languageServer: name.endsWith(".astro.mx")
          ? "watched by the server, not diagnosed"
          : languageServerLeg(
              file,
              text,
              name.endsWith(".solid.mx") ? "solidmx" : "mx",
            ),
        tsPlugin: tsPluginLeg(file, text),
        vite: await viteLeg(row, file, text),
      };
      if (row === "solid-file" && name === "card.solid.mx") {
        entry.languageServerUntitled = untitledLeg(file, text);
      }
      files[name] = entry;
    }
    const golden = normalise({
      files,
      mxTsc: (tsc.byRow.get(row) ?? []).filter(
        // bad-package-json: the host-policy warning only (see its leg above).
        (block) => row !== "bad-package-json" || block.includes("TS80003"),
      ),
    });
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(
      join(goldens, `${row}.json`),
    );
  });

  it("mx-tsc: one program, its exit code and the output no row owns", async () => {
    const golden = normalise({
      status: tsc.status,
      unattributed: tsc.unattributed,
    });
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(
      join(goldens, "_mx-tsc.json"),
    );
  });
});

describe("x.astro.mx file kind (decision 134)", () => {
  it("picks the Astro template plugin, never the plain .mx plugin", () => {
    const astro = pluginFor("/p/card.astro.mx");
    expect(astro.languageId).toBe("astromx");
    expect(createMxLanguagePlugin(ts).getLanguageId("/p/card.astro.mx")).toBe(
      undefined,
    );
    expect(pluginFor("/p/card.mx").languageId).toBe("mx");
  });
});
