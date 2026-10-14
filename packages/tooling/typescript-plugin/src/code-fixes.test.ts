/**
 * `getCodeFixesAtPosition` through the tsserver plugin: the `fixes` an MX
 * diagnostic carries (`IrDiagnostic.fixes`), offered as code fixes. The pin is
 * the reserved `<effect>` tag's one fix, "Rename to `<script>`".
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { astroTemplateDeclarations } from "@mxlang/host-astro/template";
import type ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { applicableFixes, mxCodeFixes } from "./code-fixes.ts";
import { createMutablePluginService } from "./fixtures/plugin-service.ts";
import type { MxCompileDiagnostic } from "./language.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CODE = "MX_RESERVED_EFFECT_TAG";
const TITLE = "Rename to `<script>`";

/** What a client sends: the string code, as tsserver forwards it untouched. */
const asked = (...codes: Array<string | number | null>) =>
  codes as unknown as number[];

/** Applies a code fix's text changes to `source`, last change first. */
function apply(source: string, fix: ts.CodeFixAction, fileName: string) {
  expect(fix.changes.map((change) => change.fileName)).toEqual([fileName]);
  const changes = [...(fix.changes[0]?.textChanges ?? [])].sort(
    (a, b) => b.span.start - a.span.start,
  );
  let out = source;
  for (const change of changes) {
    out =
      out.slice(0, change.span.start) +
      change.newText +
      out.slice(change.span.start + change.span.length);
  }
  return out;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

/** A `.mx` page of the html host, loaded the way an editor loads it. */
function htmlPage(source: string) {
  const page = `${here}/fixtures/html-tags/effect.mx`;
  const consumer = `${here}/fixtures/html-tags/effect-consumer.ts`;
  const mutable = createMutablePluginService(
    { [page]: source, [consumer]: 'import "./effect.mx";\n' },
    [consumer],
  );
  mutable.service.getSemanticDiagnostics(consumer);
  return { ...mutable, page, consumer };
}

describe("the `<effect>` rename fix as a tsserver code fix", () => {
  const SOURCE = "<div>\n  <effect>go()</effect>\n</div>\n";

  it("returns the one fix, whose edits rename both names in the .mx file", () => {
    const { service, page } = htmlPage(SOURCE);
    const [diagnostic] = service.getSyntacticDiagnostics(page);
    expect(diagnostic).toMatchObject({
      start: SOURCE.indexOf("effect"),
      length: "effect".length,
      code: CODE,
    });

    const fixes = service.getCodeFixesAtPosition(
      page,
      diagnostic?.start ?? 0,
      (diagnostic?.start ?? 0) + (diagnostic?.length ?? 0),
      asked(CODE),
      {},
      {},
    );

    expect(fixes).toEqual([
      {
        fixName: CODE,
        description: TITLE,
        changes: [
          {
            fileName: page,
            textChanges: [
              { span: { start: 9, length: 6 }, newText: "script" },
              { span: { start: 22, length: 6 }, newText: "script" },
            ],
          },
        ],
      },
    ]);
    expect(apply(SOURCE, fixes[0] as ts.CodeFixAction, page)).toBe(
      "<div>\n  <script>go()</script>\n</div>\n",
    );
  });

  it("answers a cursor anywhere in the diagnostic's range, and at either end", () => {
    const { service, page } = htmlPage(SOURCE);
    const start = SOURCE.indexOf("effect");
    const ask = (from: number, to: number) =>
      service.getCodeFixesAtPosition(page, from, to, asked(CODE), {}, {})
        .length;
    expect(ask(start, start)).toBe(1);
    expect(ask(start + 3, start + 3)).toBe(1);
    expect(ask(start + 6, start + 6)).toBe(1);
    expect(ask(0, SOURCE.length)).toBe(1);
    // A range that stops before the name, or starts after it: none.
    expect(ask(0, start - 1)).toBe(0);
    expect(ask(start + 7, SOURCE.length)).toBe(0);
  });

  it("matches on the requested codes: its own, a client's NaN, not another's", () => {
    const { service, page } = htmlPage(SOURCE);
    const start = SOURCE.indexOf("effect");
    const ask = (...codes: Array<string | number | null>) =>
      service.getCodeFixesAtPosition(
        page,
        start,
        start,
        asked(...codes),
        {},
        {},
      ).length;
    expect(ask(CODE)).toBe(1);
    // A client that turns every code into a number sends `null` for a name.
    expect(ask(null)).toBe(1);
    expect(ask(Number.NaN)).toBe(1);
    expect(ask(2304, CODE)).toBe(1);
    expect(ask("MX_INVALID_FOR")).toBe(0);
    expect(ask(2304)).toBe(0);
    expect(ask(80001)).toBe(0);
    expect(ask()).toBe(0);
  });

  it("is the same fix in a CRLF file with a non-BMP character before the tag", () => {
    const source =
      "<p>😀</p>\r\n<div>\r\n  <effect>go()</effect>\r\n</div>\r\n";
    const { service, page } = htmlPage(source);
    const start = source.indexOf("effect");
    const [fix] = service.getCodeFixesAtPosition(
      page,
      start,
      start,
      asked(CODE),
      {},
      {},
    );
    expect(fix?.changes[0]?.textChanges.map((c) => c.span.start)).toEqual([
      source.indexOf("effect"),
      source.lastIndexOf("effect"),
    ]);
    expect(apply(source, fix as ts.CodeFixAction, page)).toBe(
      "<p>😀</p>\r\n<div>\r\n  <script>go()</script>\r\n</div>\r\n",
    );
  });

  it("follows an edit: the offsets are those of the text the request is about", () => {
    const { service, page, setFile } = htmlPage(SOURCE);
    service.getSyntacticDiagnostics(page);
    const edited = `<h1>a longer heading than before</h1>\n${SOURCE}`;
    setFile(page, edited);
    // No diagnostics request in between: the code fix brings the compile up to date.
    const start = edited.indexOf("effect");
    const [fix] = service.getCodeFixesAtPosition(
      page,
      start,
      start,
      asked(CODE),
      {},
      {},
    );
    expect(apply(edited, fix as ts.CodeFixAction, page)).toBe(
      edited.replaceAll("effect", "script"),
    );
  });

  it("offers nothing for a diagnostic with no fix, and for a clean file", () => {
    const withoutFix = htmlPage("<else/>\n");
    const [diagnostic] = withoutFix.service.getSyntacticDiagnostics(
      withoutFix.page,
    );
    expect(diagnostic).toBeDefined();
    expect(
      withoutFix.service.getCodeFixesAtPosition(
        withoutFix.page,
        0,
        7,
        asked(diagnostic?.code as string | number),
        {},
        {},
      ),
    ).toEqual([]);

    const clean = htmlPage("<div>ok</div>\n");
    expect(
      clean.service.getCodeFixesAtPosition(
        clean.page,
        0,
        12,
        asked(CODE),
        {},
        {},
      ),
    ).toEqual([]);
  });
});

describe("a region file's fix, at the region's offset in the whole file", () => {
  // Every JSX host refuses `<effect>` in its own words and with no fix, so the
  // reachable carrier of a fix at a base offset is a template that starts
  // after other text: an `.astro.mx` page, whose template follows its fence.
  // Astro's own row is removed so core's error, with the rename, is reached.
  it("an .astro.mx template after a fence holding a non-BMP character", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-code-fixes-")));
    dirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      '{"name":"a","mx":{"host":"astro"}}',
    );
    const tags = astroTemplateDeclarations.tags as { effect?: unknown };
    const row = tags.effect;
    delete tags.effect;
    try {
      const page = join(dir, "page.astro.mx");
      const consumer = join(dir, "consumer.ts");
      const source =
        "---\r\nconst a = '\u{1F600}';\r\n---\r\n<div>\r\n<effect>go()</effect>\r\n</div>\r\n";
      const { service } = createMutablePluginService(
        { [page]: source, [consumer]: 'import "./page.astro.mx";\n' },
        [consumer, page],
        { config: { astro: true } },
      );
      service.getSemanticDiagnostics(consumer);
      const [diagnostic] = service.getSyntacticDiagnostics(page);
      expect(diagnostic?.code).toBe(CODE);

      const [fix] = service.getCodeFixesAtPosition(
        page,
        diagnostic?.start ?? 0,
        diagnostic?.start ?? 0,
        asked(CODE),
        {},
        {},
      );
      expect(fix?.description).toBe(TITLE);
      expect(apply(source, fix as ts.CodeFixAction, page)).toBe(
        source.replaceAll("effect", "script"),
      );
    } finally {
      tags.effect = row;
    }
  });

  it("mxCodeFixes takes the offsets as they are, whatever the range's base", () => {
    // A diagnostic far into a file, as a region at a base offset leaves it.
    const source = `${"x".repeat(1000)}<effect/>`;
    const diagnostic: MxCompileDiagnostic = {
      fileName: "/p/page.preact.mx",
      message: "m",
      offset: 1001,
      length: 6,
      source,
      category: "error",
      diagnosticCode: CODE,
      fixes: [
        {
          title: TITLE,
          edits: [{ offset: 1001, end: 1007, newText: "script" }],
        },
      ],
    };
    expect(mxCodeFixes([diagnostic], 1003, 1003, [CODE])).toEqual([
      {
        fixName: CODE,
        description: TITLE,
        changes: [
          {
            fileName: "/p/page.preact.mx",
            textChanges: [
              { span: { start: 1001, length: 6 }, newText: "script" },
            ],
          },
        ],
      },
    ]);
    expect(mxCodeFixes([diagnostic], 0, 1000, [CODE])).toEqual([]);
  });
});

describe("everything that is not an MX diagnostic's is TypeScript's", () => {
  const FILE = `${here}/fixtures/html-tags/spelling.ts`;
  const SOURCE = "const value = 1;\nconsole.log(valu);\n";

  it("a plain .ts file gets TypeScript's own fixes, unchanged", () => {
    const { service } = createMutablePluginService({ [FILE]: SOURCE }, [FILE]);
    const start = SOURCE.indexOf("valu)");
    const fixes = service.getCodeFixesAtPosition(
      FILE,
      start,
      start + 4,
      [2552],
      {},
      {},
    );
    expect(fixes.map((fix) => fix.fixName)).toEqual(["spelling"]);
  });

  it("an .mx file gets TypeScript's fixes for numeric codes, and MX's for its own", () => {
    const page = `${here}/fixtures/html-tags/mixed.mx`;
    const consumer = `${here}/fixtures/html-tags/mixed-consumer.ts`;
    const source = "<div>\n  <effect>go()</effect>\n</div>\n";
    const { service } = createMutablePluginService(
      { [page]: source, [consumer]: 'import "./mixed.mx";\n' },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);
    const start = source.indexOf("effect");
    // A TypeScript code with no TypeScript error here: none; and the MX one: one.
    const fixes = service.getCodeFixesAtPosition(
      page,
      start,
      start,
      asked(2552, CODE),
      {},
      {},
    );
    expect(fixes.map((fix) => fix.fixName)).toEqual([CODE]);
  });
});

describe("applicableFixes", () => {
  const edit = (offset: number, end: number, newText = "x") => ({
    offset,
    end,
    newText,
  });
  const fix = (...edits: ReturnType<typeof edit>[]) => ({ title: "t", edits });

  it("keeps a fix whose edits fit the text, in order, and drops the rest", () => {
    const good = fix(edit(0, 2), edit(2, 4), edit(10, 10));
    expect(applicableFixes([good], 10)).toEqual([good]);
    expect(applicableFixes(undefined, 10)).toEqual([]);
    for (const bad of [
      fix(),
      fix(edit(-1, 2)),
      fix(edit(3, 2)),
      fix(edit(0, 11)),
      fix(edit(0, 4), edit(3, 5)),
      fix(edit(0.5, 2)),
      { title: "t", edits: [{ offset: 0, end: 1 }] },
      { edits: [edit(0, 1)] },
    ]) {
      expect(applicableFixes([bad as never], 10)).toEqual([]);
    }
  });

  it("a fix measured against a longer text is not offered", () => {
    const source = "<effect/>";
    const diagnostic: MxCompileDiagnostic = {
      fileName: "/p/a.mx",
      message: "m",
      offset: 0,
      source,
      category: "error",
      diagnosticCode: CODE,
      fixes: [fix(edit(0, 100))],
    };
    expect(mxCodeFixes([diagnostic], 0, 0, [CODE])).toEqual([]);
  });
});
