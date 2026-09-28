/**
 * A dedicated file (not `index.test.ts`) so `vi.mock` on `@mxlang/preact`
 * cannot leak into any other suite in this package.
 *
 * `readCalleeInput`'s own `MAX_ALIAS_DEPTH` (4) bounds how many hops a real
 * `AttrTag<Alias>` chain can reveal within a single compile, independent of
 * `compileWithDependencies`'s own `MAX_COMPILE_PASSES` (8) — see
 * `AGENTS.md`'s `compileWithDependencies` entry for the measured detail. A
 * real caller therefore cannot organically drive the pass loop to its
 * literal cap through the only public dependency-producing mechanism this
 * codebase has. To still prove the real wiring — `compileWithDependencies`
 * itself, plus `mx-language.ts`'s `warnings.map(...)` into
 * `compileDiagnostics` → `getCompileDiagnostics` — carries a cap warning
 * through end to end, this mocks only the host compile function
 * `mx-language.ts` calls for the "preact" host policy (`compilePreactMx`),
 * so every pass genuinely goes through `compileWithDependencies`'s real
 * loop and the caller's real diagnostic plumbing; only the dependency
 * *discovery* itself (normally `readCalleeInput`, walled off by
 * `MAX_ALIAS_DEPTH`) is stood in for.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MxWarning } from "@mxlang/core";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mxlang/preact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mxlang/preact")>();
  let compiles = 0;
  return {
    ...actual,
    compilePreactMx: (
      _source: string,
      _filename: string,
      options: { warnings?: MxWarning[] } = {},
    ) => {
      compiles++;
      // Every pass reports one more dependency than the last, so the
      // dependency set is never stable and `compileWithDependencies`'s
      // loop only stops at `MAX_COMPILE_PASSES`.
      const dependencies = Array.from(
        { length: compiles },
        (_, index) => `/project/Dep${index}.mx`,
      );
      // The real `compilePreactMx` pushes onto the caller-supplied
      // `options.warnings` array by reference; this stand-in never itself
      // hits the cap (that is `compileWithDependencies`'s job), so it
      // leaves that array untouched.
      void options;
      return {
        code: "<div/>",
        map: { version: 3, sources: [], names: [], mappings: "" },
        mappings: [],
        dependencies,
      };
    },
  };
});

const { createMxLanguagePlugin, MX_LANGUAGE_ID } = await import(
  "./mx-language.ts"
);

describe("compileWithDependencies cap warning through a real caller (mocked dependency discovery)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces exactly one cap diagnostic, with the chain text, through getCompileDiagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-cap-real-caller-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"mx":{"host":"preact"}}\n');
      const callerPath = join(dir, "caller.mx");
      const callerSource = "<div/>\n";
      writeFileSync(callerPath, callerSource);

      // A dependency set that keeps growing needs a host reader present at
      // all -- `compileWithDependencies` returns immediately with no
      // `readSource` (see its own doc comment). The reader's actual answers
      // are irrelevant here: the mocked `compilePreactMx` above is what
      // grows the dependency set every pass, not the freshness of any
      // dependency's own text.
      const readSource = (fileName: string) => `stub-text-for-${fileName}`;

      const plugin = createMxLanguagePlugin(ts, { readSource });
      const virtual = plugin.createVirtualCode?.(
        callerPath,
        MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(callerSource),
        { getAssociatedScript: () => undefined },
      );
      if (!virtual) throw new Error("Expected MX virtual code");
      expect(plugin.getSyntaxError?.(callerPath)).toBeUndefined();

      const diagnostics = plugin.getCompileDiagnostics(callerPath);
      const warnings = diagnostics.filter((d) => d.category === "warning");
      expect(warnings).toHaveLength(1);
      const warning = warnings[0];
      if (!warning) throw new Error("expected a warning diagnostic");
      expect(warning.fileName).toBe(callerPath);
      expect(warning.message).toContain("8 passes");
      expect(warning.message).toContain("did not settle");
      expect(warning.message).toContain("/project/Dep0.mx");
      expect(warning.message).toContain("/project/Dep7.mx");
      // Positioned at the file's own start (line 1, column 1): `offset` 0
      // into `caller.mx`'s own source.
      expect(warning.offset).toBe(0);
      expect(warning.source).toBe(callerSource);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
