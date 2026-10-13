import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Diagnostic = {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code?: string;
  message: string;
};

const state = vi.hoisted(() => ({ diagnostics: [] as unknown[] }));
vi.mock("@mxlang/targets", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mxlang/targets")>();
  return {
    ...original,
    scanCached: (...args: Parameters<typeof original.scanCached>) => ({
      ...original.scanCached(...args),
      diagnostics: state.diagnostics,
    }),
  };
});

import mx, { MX_SUFFIX } from "./index.ts";

type Hooks = {
  configResolved(config: unknown): void;
  buildStart(): Promise<void>;
  transform(this: unknown, code: string, id: string): Promise<unknown>;
  handleHotUpdate(ctx: unknown): unknown;
};

const dirs: string[] = [];
afterEach(() => {
  state.diagnostics = [];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function setup(command: "build" | "serve") {
  const dir = mkdtempSync(join(tmpdir(), "mx-vite-scan-dedupe-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), '{"mx":{"target":"html"}}');
  const tagA = join(dir, "tags/a.mx");
  const tagB = join(dir, "tags/b.mx");
  const hooks = mx() as unknown as Hooks;
  hooks.configResolved({ command, root: dir, resolve: { alias: [] } });
  const warnings: unknown[] = [];
  const transform = async (caller: string): Promise<void> => {
    await hooks.transform.call(
      { warn: (warning: unknown) => warnings.push(warning) },
      "<p>x</p>\n",
      join(dir, `${caller}.mx`) + MX_SUFFIX,
    );
  };
  const diagnostic = (
    file: string,
    over: Partial<Diagnostic> = {},
  ): Diagnostic => ({
    file,
    line: 1,
    column: 0,
    severity: "error",
    code: "MX_E1",
    message: "broken",
    ...over,
  });
  mkdirSync(join(dir, "tags"));
  for (const file of [tagA, tagB]) {
    writeFileSync(file, "<p/>\n");
  }
  return { hooks, warnings, transform, tagA, tagB, diagnostic };
}

describe("scan error dedupe key: file, position, code and message", () => {
  it("a build fails the first caller and not the next one for the same error", async () => {
    const t = setup("build");
    state.diagnostics = [t.diagnostic(t.tagA)];
    await expect(t.transform("one")).rejects.toMatchObject({
      message: `${t.tagA}:1:1: MX_E1: broken`,
    });
    await expect(t.transform("two")).resolves.toBeUndefined();
  });

  it("one file with two distinct scan errors raises both, once", async () => {
    const t = setup("build");
    state.diagnostics = [
      t.diagnostic(t.tagA, { code: "MX_E1", message: "first" }),
      t.diagnostic(t.tagA, { code: "MX_E2", message: "second" }),
    ];
    await expect(t.transform("one")).rejects.toMatchObject({
      message: `${t.tagA}:1:1: MX_E1: first\n\n1 more error:\n  ${t.tagA}:1:1: MX_E2: second`,
    });
    await expect(t.transform("two")).resolves.toBeUndefined();
  });

  it.each<[string, Partial<Diagnostic>]>([
    ["position", { line: 2 }],
    ["column", { column: 3 }],
    ["code", { code: "MX_E9" }],
    ["message", { message: "other" }],
  ])("a different %s is a different error", async (_name, over) => {
    const t = setup("build");
    state.diagnostics = [t.diagnostic(t.tagA)];
    await expect(t.transform("one")).rejects.toThrow("MX_E1: broken");
    state.diagnostics = [t.diagnostic(t.tagA), t.diagnostic(t.tagA, over)];
    // Only the new error is raised; the one already raised is not repeated.
    const message = `${t.tagA}:${over.line ?? 1}:${(over.column ?? 0) + 1}: ${over.code ?? "MX_E1"}: ${over.message ?? "broken"}`;
    await expect(t.transform("two")).rejects.toMatchObject({ message });
  });

  it("a second broken tag file is raised after the first", async () => {
    const t = setup("build");
    state.diagnostics = [t.diagnostic(t.tagA)];
    await expect(t.transform("one")).rejects.toThrow("broken");
    state.diagnostics = [t.diagnostic(t.tagA), t.diagnostic(t.tagB)];
    await expect(t.transform("two")).rejects.toMatchObject({
      loc: { file: t.tagB },
    });
  });

  it("a new build raises the same error again", async () => {
    const t = setup("build");
    state.diagnostics = [t.diagnostic(t.tagA)];
    await expect(t.transform("one")).rejects.toThrow("broken");
    await t.hooks.buildStart();
    await expect(t.transform("two")).rejects.toThrow("broken");
  });
});

describe("a scan error under serve is a warning positioned at the tag file", () => {
  it("passes the tag file as id and loc, once per caller set", async () => {
    const t = setup("serve");
    state.diagnostics = [t.diagnostic(t.tagA, { line: 3, column: 4 })];
    await t.transform("one");
    await t.transform("two");
    expect(t.warnings).toEqual([
      {
        message: `@mxlang/vite-plugin: ${t.tagA}:3:5: MX_E1: broken`,
        id: t.tagA,
        loc: { file: t.tagA, line: 3, column: 4 },
      },
    ]);
  });

  it("two distinct errors in one file warn twice; an edit warns again", async () => {
    const t = setup("serve");
    state.diagnostics = [
      t.diagnostic(t.tagA, { message: "first" }),
      t.diagnostic(t.tagA, { message: "second" }),
    ];
    await t.transform("one");
    await t.transform("two");
    expect(t.warnings).toHaveLength(2);
    const later = new Date(Date.now() + 60_000);
    utimesSync(t.tagA, later, later);
    await t.transform("three");
    expect(t.warnings).toHaveLength(4);
  });

  it("a change to a scan input re-warns the problems still present, once, on any caller", async () => {
    const t = setup("serve");
    state.diagnostics = [t.diagnostic(t.tagA)];
    await t.transform("one");
    // The tag file is deleted and recreated with no request in between; the
    // next request goes to a different caller.
    t.hooks.handleHotUpdate({
      file: t.tagA,
      modules: [],
      server: {
        moduleGraph: { getModuleById: () => undefined, invalidateModule() {} },
      },
    });
    await t.transform("two");
    expect(t.warnings).toHaveLength(2);
    await t.transform("three");
    expect(t.warnings).toHaveLength(2);
  });

  it("a buildStart starts the warnings over", async () => {
    const t = setup("serve");
    state.diagnostics = [t.diagnostic(t.tagA)];
    await t.transform("one");
    await t.hooks.buildStart();
    await t.transform("two");
    expect(t.warnings).toHaveLength(2);
  });

  it("falls back to plain console text when the context has no warn", async () => {
    const t = setup("serve");
    state.diagnostics = [t.diagnostic(t.tagA)];
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await t.hooks.transform.call(
        {},
        "<p>x</p>\n",
        join(t.tagA, "..", "..", "c.mx") + MX_SUFFIX,
      );
      expect(spy).toHaveBeenCalledWith(
        `@mxlang/vite-plugin: ${t.tagA}:1:1: MX_E1: broken`,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
