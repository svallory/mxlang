import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createMxLanguagePlugin } from "@mxlang/typescript-plugin";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupProjects,
  type FakeTarget,
  fakeProject,
  fakeWorkspace,
  specifier,
} from "../../../../test-fixtures/third-party-targets/support.ts";
import { resolveTargetPolicyDetailed } from "../../../target-registry/src/index.ts";
import {
  diagnoseDocument,
  type RelatedDiagnostics,
} from "../../language-server/src/diagnose.ts";
import { runInProcess } from "./in-process.ts";

/**
 * A third-party target loaded from `package.json#mx.target` / `mx.host`
 * (registration PR 7), through three of the four tools: the language server,
 * the TypeScript plugin and `mx-tsc`. (Vite is pinned by the dispatch golden
 * rows; it follows PR 6.) One project per case, one `mx-tsc` run over all of
 * them.
 */

interface Case {
  /** Directory name. */
  name: string;
  mx: unknown;
  install?: readonly FakeTarget[];
  source?: string;
}

const OK = { target: specifier("ok") };
/** A page html rejects (an event handler needs a runtime) that a third-party target may accept. */
const STATEFUL = "<let/x=1/>\n<button onClick() { x++ }>${x}</button>\n";
const CASES: readonly Case[] = [
  { name: "ok", mx: OK, install: ["ok"] },
  { name: "ok-let", mx: OK, install: ["ok"], source: STATEFUL },
  {
    name: "missing-rejected",
    mx: { target: specifier("missing") },
    source: STATEFUL,
  },
  { name: "ok-host", mx: { host: specifier("ok") }, install: ["ok"] },
  { name: "ok-fail", mx: OK, install: ["ok"], source: "<p>FAIL</p>\n" },
  {
    name: "own-core",
    mx: { target: specifier("own-core") },
    install: ["own-core"],
  },
  {
    name: "own-core-fail",
    mx: { target: specifier("own-core") },
    install: ["own-core"],
    source: "<p>FAIL</p>\n",
  },
  { name: "missing", mx: { target: specifier("missing") } },
  { name: "throws", mx: { target: specifier("throws") }, install: ["throws"] },
  {
    name: "invalid",
    mx: { target: specifier("invalid") },
    install: ["invalid"],
  },
  {
    name: "version",
    mx: { target: specifier("version") },
    install: ["version"],
  },
  {
    name: "hostless-under-mx-host",
    mx: { host: specifier("hostless") },
    install: ["hostless"],
  },
];

let workspace: string;
const file = (name: string) => join(workspace, name, "a.mx");
let tscOutput = "";
let tscStatus = 0;

beforeAll(() => {
  workspace = fakeWorkspace();
  for (const { name, mx, install, source } of CASES) {
    fakeProject({
      root: join(workspace, name),
      mx,
      install,
      files: { "a.mx": source ?? "<p>hi</p>\n" },
    });
  }
  writeFileSync(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        target: "esnext",
        jsx: "preserve",
        types: [],
        allowImportingTsExtensions: true,
      },
      include: ["**/*.mx"],
    }),
  );
  const run = runInProcess(["-p", workspace, "--pretty", "false"]);
  tscStatus = run.status;
  tscOutput = stripVTControlCharacters(`${run.stdout}\n${run.stderr}`);
}, 120_000);
afterAll(cleanupProjects);

const sourceOf = (name: string): string =>
  CASES.find((c) => c.name === name)?.source ?? "<p>hi</p>\n";
const norm = (text: string): string =>
  text.replaceAll(workspace, "<ws>").replaceAll(/(?:\.\.\/)+<ws>/g, "<ws>");

function lsLeg(name: string) {
  const path = file(name);
  const { policy, diagnostics } = resolveTargetPolicyDetailed(path);
  const related: RelatedDiagnostics[] = [];
  const unexpected: string[] = [];
  const reported = diagnoseDocument(
    sourceOf(name),
    pathToFileURL(path).href,
    policy,
    (error) => unexpected.push(String(error)),
    "mx",
    undefined,
    related,
    undefined,
    diagnostics,
  );
  return { policy, reported, related, unexpected };
}

function pluginLeg(name: string) {
  const path = file(name);
  const plugin = createMxLanguagePlugin(ts);
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    const text = sourceOf(name);
    const virtual = plugin.createVirtualCode?.(
      path,
      "mx",
      ts.ScriptSnapshot.fromString(text),
      { getAssociatedScript: () => undefined } as never,
    );
    return {
      generated: virtual
        ? virtual.snapshot.getText(0, virtual.snapshot.getLength())
        : null,
      compileDiagnostics: plugin.getCompileDiagnostics(path),
      policyDiagnostics: plugin.getTargetPolicyDiagnostics(path),
      logged,
    };
  } finally {
    console.warn = warn;
  }
}

/**
 * The error each failing case must produce, and where: the `package.json`
 * position is the key's value (1-based line and column), `length` its JSON text.
 */
const FAILURES = [
  {
    name: "missing",
    code: "target-not-found",
    at: [3, 15, 18],
    message:
      "mx.target \"@fake/mx-missing\" cannot be resolved from <ws>/missing: Cannot find module '@fake/mx-missing'. Install it (bun add -d @fake/mx-missing) or use a built-in target: html, astro-html, solid-jsx, preact-jsx, react-jsx, hono-jsx, angular-template.",
  },
  {
    name: "throws",
    code: "target-load-failed",
    at: [3, 15, 17],
    message:
      'mx.target "@fake/mx-throws" failed to load: boom: the fixture target exploded on load. (<ws>/throws/node_modules/@fake/mx-throws/index.cjs)',
  },
  {
    name: "invalid",
    code: "target-invalid-descriptor",
    at: [3, 15, 18],
    message:
      'mx.target "@fake/mx-invalid" must export a target descriptor (default export or "mxTarget"): "name" is missing, expected a string. See the TargetDescriptor contract (unstable).',
  },
  {
    name: "version",
    code: "target-invalid-descriptor",
    at: [3, 15, 18],
    message:
      'mx.target "@fake/mx-version" targets descriptor version 1; this mx supports 0.',
  },
  {
    name: "hostless-under-mx-host",
    code: "host-invalid-descriptor",
    at: [3, 13, 19],
    message:
      'mx.host "@fake/mx-hostless" exports a target with no host. Use mx.target "@fake/mx-hostless", or give the descriptor a "host" part.',
  },
] as const;

describe.each(FAILURES)("$name: $code", ({ name, code, at, message }) => {
  const [line, column, length] = at;

  it("language server: an error on the document, linked to the key's value", () => {
    const { reported, related, policy } = lsLeg(name);
    // No fallback to a guessed target: the policy is the default, the error stands.
    expect(policy.target).toBe("html");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ severity: 1, source: "mxlang" });
    expect(norm(String(reported[0]?.message ?? ""))).toBe(
      `<ws>/${name}/package.json:${line}:${column}: ${message}`,
    );
    const range = {
      start: { line: line - 1, character: column - 1 },
      end: { line: line - 1, character: column - 1 + length },
    };
    expect(reported[0]?.relatedInformation?.[0]?.location.range).toEqual(range);
    expect(related[0]?.diagnostics[0]?.range).toEqual(range);
  });

  it("TypeScript plugin: the code, the pointer on the page and the policy diagnostic", () => {
    const { compileDiagnostics, policyDiagnostics } = pluginLeg(name);
    expect(policyDiagnostics).toHaveLength(1);
    expect(policyDiagnostics[0]).toMatchObject({
      code,
      severity: "error",
      line,
      column: column - 1,
      length,
    });
    expect(norm(policyDiagnostics[0]?.message ?? "")).toBe(message);
    expect(compileDiagnostics).toHaveLength(1);
    expect(compileDiagnostics[0]).toMatchObject({
      category: "error",
      offset: 0,
    });
    expect(norm(compileDiagnostics[0]?.message ?? "")).toBe(
      `target not loaded: see <ws>/${name}/package.json(${line},${column})`,
    );
  });

  it("mx-tsc: TS80003 at the key's value, TS80001 on the page, a failing exit code", () => {
    expect(tscStatus).toBe(1);
    expect(norm(tscOutput)).toContain(
      `<ws>/${name}/package.json(${line},${column}): error TS80003: ${message}`,
    );
    expect(norm(tscOutput)).toContain(
      `<ws>/${name}/a.mx(1,1): error TS80001: target not loaded: see <ws>/${name}/package.json(${line},${column})`,
    );
  });
});

describe.each(["ok", "ok-host"])(
  "%s: a target using the injected core",
  (name) => {
    it("language server compiles through it", () => {
      const { reported, policy } = lsLeg(name);
      expect(policy).toMatchObject({ target: "fake-ok", host: "fake-host" });
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({
        severity: 2,
        message: "fake target compiled a.mx",
      });
    });

    it("TypeScript plugin generates its module", () => {
      const { generated, compileDiagnostics, policyDiagnostics } =
        pluginLeg(name);
      expect(generated).toBe(
        'export default function Page(): string {\n  return "<p>hi</p>\\n";\n}\n',
      );
      expect(
        compileDiagnostics.map(({ message, category }) => [message, category]),
      ).toEqual([["fake target compiled a.mx", "warning"]]);
      expect(policyDiagnostics).toEqual([]);
    });

    it("mx-tsc reports its warning and type-checks the module", () => {
      expect(norm(tscOutput)).toContain(
        `<ws>/${name}/a.mx(1,1): warning TS80002: fake target compiled a.mx`,
      );
      expect(norm(tscOutput)).not.toContain(`<ws>/${name}/a.mx(1,1): error`);
    });
  },
);

describe.each(["ok-fail", "own-core-fail"])(
  "%s: a positioned TranslateError from the target stays positioned",
  (name) => {
    // `own-core-fail` throws another copy of core's class: only the brand
    // check keeps it positioned. Wrapped, it would read `custom tag threw`.
    it("language server", () => {
      const { reported } = lsLeg(name);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({
        severity: 1,
        message: "fake target rejects FAIL",
        range: {
          start: { line: 0, character: 3 },
          end: { line: 0, character: 4 },
        },
      });
    });

    it("TypeScript plugin", () => {
      const { compileDiagnostics } = pluginLeg(name);
      expect(compileDiagnostics).toHaveLength(1);
      expect(compileDiagnostics[0]).toMatchObject({
        category: "error",
        offset: 3,
        message: "fake target rejects FAIL",
      });
    });

    it("mx-tsc", () => {
      expect(norm(tscOutput)).toContain(
        `<ws>/${name}/a.mx(1,4): error TS80001: fake target rejects FAIL`,
      );
      expect(tscOutput).not.toContain("custom tag threw");
    });
  },
);

it("mx-tsc: no output belongs to no case", () => {
  const unowned = norm(tscOutput)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !CASES.some((c) => line.includes(`<ws>/${c.name}/`)));
  expect(unowned).toEqual([]);
});

describe("round 2", () => {
  it("TS plugin and mx-tsc: a page html would reject compiles through the loaded target (no html second lowering)", () => {
    const { generated, compileDiagnostics } = pluginLeg("ok-let");
    expect(generated).toContain("export default function Page(): string");
    expect(generated).not.toContain("__mx$failed$");
    expect(
      compileDiagnostics.map(({ message, category }) => [message, category]),
    ).toEqual([["fake target compiled a.mx", "warning"]]);
    expect(norm(tscOutput)).toContain(
      "<ws>/ok-let/a.mx(1,1): warning TS80002: fake target compiled a.mx",
    );
    expect(norm(tscOutput)).not.toContain("<ws>/ok-let/a.mx(1,1): error");
    expect(norm(tscOutput)).not.toMatch(/ok-let\/a\.mx\(\d+,\d+\): error/);
  });

  it("language server: after a load failure only the policy error is reported, not html's verdict on the page", () => {
    const { reported } = lsLeg("missing-rejected");
    expect(reported).toHaveLength(1);
    expect(String(reported[0]?.message)).toContain(
      "target-not-found".slice(0, 0) +
        'mx.target "@fake/mx-missing" cannot be resolved',
    );
  });

  it("own-core is a real second copy of core, not the tool's", () => {
    const project = fakeProject({ install: ["own-core"] });
    const own = createRequire(join(project.root, "package.json"))(
      "@mxlang/core",
    ) as { TranslateError: unknown };
    const tool = createRequire(import.meta.url)(
      "../../../core/dist/index.js",
    ) as { TranslateError: unknown };
    expect(own.TranslateError).not.toBe(tool.TranslateError);
  });
});
