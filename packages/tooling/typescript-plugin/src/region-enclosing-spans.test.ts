import { createLanguage, type Language } from "@volar/language-core";
import { transformDiagnostic } from "@volar/typescript/lib/node/transform";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  markoAuthoredSpans,
  ngRegionSource,
  regionAuthoredSpans,
} from "./authored-spans.ts";
import { createNgMxLanguagePlugin } from "./language.ts";
import {
  approximateUnmapped,
  type SpannedVirtualCode,
} from "./unmapped-diagnostics.ts";

/**
 * Decision 161: the file kinds that are not MX throughout expose the spans of
 * their MX regions, so an unmappable diagnostic lands on its enclosing tag.
 */

const FILE = "/p/page.mx";
const texts = (source: string, spans: { start: number; end: number }[]) =>
  spans.map((span) => source.slice(span.start, span.end));

describe("markoAuthoredSpans with a base offset", () => {
  it("shifts every span by the offset of the slice in its file", () => {
    const file = "const a = 1;\n<p title=t>${x}</p>\n";
    const at = file.indexOf("<p");
    const spans = markoAuthoredSpans(file.slice(at), FILE, undefined, at);

    expect(
      texts(
        file,
        spans.filter((span) => span.kind !== "code"),
      ),
    ).toEqual(["<p title=t>${x}</p>", "title=t"]);
    expect(
      texts(
        file,
        spans.filter((span) => span.kind === "code"),
      ),
    ).toEqual(["t", "x"]);
  });
});

describe("regionAuthoredSpans", () => {
  it("collects the spans of every region, each against its own offset", () => {
    const file = "a\n<p>${one}</p>\nb\n<hr class=c/>\n";
    const regions = [
      { source: "<p>${one}</p>", baseOffset: file.indexOf("<p>") },
      { source: "<hr class=c/>", baseOffset: file.indexOf("<hr") },
    ];
    const spans = regionAuthoredSpans(regions, FILE, undefined);

    expect(
      texts(
        file,
        spans.filter((span) => span.kind !== "code"),
      ),
    ).toEqual(["<p>${one}</p>", "<hr class=c/>", "class=c"]);
  });

  it("has no spans for a region that does not parse, and keeps the others", () => {
    const file = "<p>ok</p> <div";
    const spans = regionAuthoredSpans(
      [
        { source: "<p>ok</p>", baseOffset: 0 },
        { source: "<div", baseOffset: 10 },
      ],
      FILE,
      undefined,
    );

    expect(texts(file, spans)).toEqual(["<p>ok</p>"]);
  });

  it("has none for no regions", () => {
    expect(regionAuthoredSpans([], FILE, undefined)).toEqual([]);
  });
});

describe("ngRegionSource", () => {
  const file = "x\n@Component({ template: <><p/><b/></> })";

  it("hands over the children of a fragment region, offset past its `<>`", () => {
    const start = file.indexOf("<>");
    const end = file.indexOf("</>") + 3;

    expect(ngRegionSource(file, { start, end })).toEqual({
      source: "<p/><b/>",
      baseOffset: start + 2,
    });
  });

  it("hands over a region that is not a fragment as it stands", () => {
    const plain = "template: <p>x</p>";
    const start = plain.indexOf("<p>");

    expect(ngRegionSource(plain, { start, end: plain.length })).toEqual({
      source: "<p>x</p>",
      baseOffset: start,
    });
  });
});

describe(".ng.mx exposes its region's spans to the unmapped-diagnostic seam", () => {
  const fileName = "/project/x.component.ng.mx";
  const source = [
    'import { Component } from "./stub.ts";',
    "",
    "@Component({",
    '  selector: "app-x",',
    "  template: <div>",
    "    <p title=missing>${n}</p>",
    "  </div>,",
    "})",
    "export class XComponent { n = 1 }",
  ].join("\n");

  function load() {
    const plugin = createNgMxLanguagePlugin(ts);
    const language = createLanguage<string>(
      [plugin],
      new Map() as never,
      () => undefined,
    );
    language.scripts.set(fileName, {
      getText: (start, end) => source.slice(start, end),
      getLength: () => source.length,
      getChangeRange: () => undefined,
    });
    const script = language.scripts.get(fileName);
    const root = script?.generated?.root as SpannedVirtualCode;
    const generated = root.snapshot.getText(0, root.snapshot.getLength());
    return { language, root, generated };
  }

  it("lists the tags and attributes of its template", () => {
    const { root } = load();

    expect(
      texts(
        source,
        (root.authoredSpans?.() ?? []).filter((span) => span.kind !== "code"),
      ),
    ).toEqual([
      "<div>\n    <p title=missing>${n}</p>\n  </div>",
      "<p title=missing>${n}</p>",
      "title=missing",
    ]);
  });

  it("puts a diagnostic in the generated template on its enclosing attribute, never at 1:1", () => {
    const { language, generated } = load();
    // The template literal's text maps to no source: aim into the `<p`,
    // which the source holds between `<p` and its mapped `missing` value.
    const at = generated.indexOf("<p");
    expect(at).toBeGreaterThan(0);
    const diagnostic: ts.Diagnostic = {
      file: ts.createSourceFile(fileName, "", ts.ScriptTarget.Latest),
      start: source.length + at,
      length: 2,
      category: ts.DiagnosticCategory.Error,
      code: 2322,
      source: "ts",
      messageText: "Type 'number' is not assignable to type 'string'.",
    };

    const placed = transformDiagnostic(
      language as Language<string>,
      approximateUnmapped(language, diagnostic),
      undefined,
      false,
    );

    expect(placed).toBeDefined();
    expect(
      source.slice(placed?.start, (placed?.start ?? 0) + (placed?.length ?? 0)),
    ).toBe("title=missing");
    // A synthetic diagnostic on emitter-written text, spelled nowhere in the
    // source: placed on the construct, marked as code MX wrote, never "unknown".
    expect(String(placed?.messageText)).toMatch(
      / \(in MX-generated code, not yours: an MX bug; generated \d+:\d+\)$/,
    );
    expect(String(placed?.messageText)).not.toContain("position unknown");
  });
});
