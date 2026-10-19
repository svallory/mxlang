import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache } from "@mxlang/core";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { createMutablePluginService } from "./fixtures/plugin-service.ts";
import { createMxLanguagePlugin } from "./mx-language.ts";

const dirs: string[] = [];
afterEach(() => {
  clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("Angular page dispatch", () => {
  it.each([{ host: "angular" }, { target: "angular-template" }])(
    "skips pages selected by %j without diagnostics or a virtual module",
    (mx) => {
      const dir = mkdtempSync(join(tmpdir(), "mx-angular-page-"));
      dirs.push(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ mx }));
      const file = join(dir, "page.mx");
      const plugin = createMxLanguagePlugin(ts);
      for (const source of ["<p>Hello</p>", "<div>", "<let/count=0/>"]) {
        const virtual = plugin.createVirtualCode?.(
          file,
          "mx",
          ts.ScriptSnapshot.fromString(source),
          { getAssociatedScript: () => undefined },
        );
        expect(virtual).toBeDefined();
        expect(virtual?.snapshot.getLength()).toBe(0);
        expect(virtual?.mappings).toEqual([]);
        expect(plugin.getSyntaxError(file)).toBeUndefined();
        expect(plugin.getCompileDiagnostics(file)).toEqual([]);
        expect(plugin.getTargetPolicyDiagnostics(file)).toEqual([]);
      }
    },
  );

  it.each([{ host: "angular" }, { target: "angular-template" }])(
    "keeps real TypeScript silent on pages selected by %j, without hiding ordinary TS errors",
    (mx) => {
      const dir = mkdtempSync(join(tmpdir(), "mx-angular-page-service-"));
      dirs.push(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ mx }));
      const page = join(dir, "page.mx");
      const control = join(dir, "control.ts");
      const { service, project, setFile } = createMutablePluginService(
        {
          [page]: "<p>Hello</p>",
          [control]:
            'import "./page.mx";\nexport const broken: number = "wrong";',
        },
        [control],
      );
      try {
        for (const source of ["<p>Hello</p>", "<div>", "<let/count=0/>"]) {
          setFile(page, source);
          expect(service.getSyntacticDiagnostics(page)).toEqual([]);
          expect(service.getSemanticDiagnostics(page)).toEqual([]);
          const compiled = service.getProgram()?.getSourceFile(page);
          expect(compiled).toBeDefined();
          if (!compiled) throw new Error("missing page script");
          expect(ts.isExternalModule(compiled)).toBe(false);
        }
        expect(service.getSyntacticDiagnostics(control)).toEqual([]);
        expect(
          service.getSemanticDiagnostics(control).map((d) => d.code),
        ).toEqual([2322]);
      } finally {
        project.close();
        service.dispose();
      }
    },
  );
});
