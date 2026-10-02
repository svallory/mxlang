import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { CustomTag, TemplateBackedTag } from "@mxlang/core";
import { clearScanCache } from "@mxlang/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticSeverity } from "vscode-languageserver/node";
import {
  diagnoseDocument,
  type RelatedDiagnostics,
  splitCodeFrame,
} from "./diagnose.ts";

describe("diagnoseDocument", () => {
  it("reports one Error diagnostic for <let> under a strict policy", () => {
    const source = "<let/count=1/>\n";
    const diagnostics = diagnoseDocument(source, "file:///project/App.mx", {
      host: "html",
      strict: true,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe(1); // DiagnosticSeverity.Error
    expect(diagnostics[0]?.source).toBe("mxlang");
    expect(diagnostics[0]?.message).toMatch(/let/i);
    // 1-based Marko line -> 0-based LSP line.
    expect(diagnostics[0]?.range.start.line).toBe(0);
  });

  it("reports one Error diagnostic for <log> under a strict policy", () => {
    const source = "<log=1/>\n";
    const diagnostics = diagnoseDocument(source, "file:///project/App.mx", {
      host: "html",
      strict: true,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe(1); // DiagnosticSeverity.Error
    expect(diagnostics[0]?.source).toBe("mxlang");
    expect(diagnostics[0]?.message).toMatch(/log/i);
    expect(diagnostics[0]?.range.start.line).toBe(0);
  });

  it("reports a whole-file Solid .mx compile error at its own line and column (decision 115)", () => {
    // Whole-file `.mx` resolved to Solid must go through `compileSolidUnit`,
    // not the region compiler `compileSolidMx` — before decision 115's
    // wiring this host was unreachable for a whole-file `.mx` at all here.
    const source = "export interface Input { }\n\n<div>\n";
    const diagnostics = diagnoseDocument(source, "file:///project/App.mx", {
      host: "solid",
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe(1); // DiagnosticSeverity.Error
    expect(diagnostics[0]?.message).toMatch(/Missing ending "div" tag/);
    // 1-based Marko line 3 -> 0-based LSP line 2.
    expect(diagnostics[0]?.range.start.line).toBe(2);
    expect(diagnostics[0]?.range.start.character).toBe(0);
  });

  it("reports no compile diagnostic for a whole-file Solid .mx that declares a typed Input", () => {
    // Prop type errors come from the virtual-code type-check (the TypeScript
    // plugin), not from this compile-time path; this only pins that the
    // typed `Input` the unit now emits does not itself raise one.
    const source =
      "export interface Input { title: string; count?: number }\n<div>${input.title}${input.count ?? 0}</div>\n";
    expect(
      diagnoseDocument(source, "file:///project/Card.mx", { host: "solid" }),
    ).toEqual([]);
  });

  it("reports nothing for a valid file", () => {
    const source = "<p>hello</p>\n";
    const diagnostics = diagnoseDocument(source, "file:///project/App.mx", {
      host: "html",
    });

    expect(diagnostics).toEqual([]);
  });

  it("reports `/var` on a tag whose template has no <return>", () => {
    // Acceptance C5, through the editor path. `tags/icon.mx` declares no
    // `<return>`, so there is nothing for `/var` to bind and the binding
    // would otherwise read `undefined` at run time with no diagnostic.
    const page = join(
      import.meta.dirname,
      "fixtures",
      "discovered-tag",
      "page.mx",
    );
    const diagnostics = diagnoseDocument(
      '<icon/x name="star"/>\n',
      pathToFileURL(page).href,
      { host: "html" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe(1);
    expect(diagnostics[0]?.message).toMatch(/does not return a value/);
    expect(diagnostics[0]?.range.start.line).toBe(0);
  });

  it("reports a `/var` read outside its declaring block", () => {
    const page = join(
      import.meta.dirname,
      "fixtures",
      "discovered-tag",
      "page.mx",
    );
    const diagnostics = diagnoseDocument(
      "<if=true><counter/n start=1/></if>\n<p>${n}</p>\n",
      pathToFileURL(page).href,
      { host: "html" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/not in scope here/);
  });

  it("reports a `/var` read before the call that binds it", () => {
    // C5's third case through the editor path; the other two are above.
    const page = join(
      import.meta.dirname,
      "fixtures",
      "discovered-tag",
      "page.mx",
    );
    const diagnostics = diagnoseDocument(
      "<p>${n}</p>\n<counter/n start=1/>\n",
      pathToFileURL(page).href,
      { host: "html" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/read before the `\/var`/);
  });

  it("reports nothing for a legal `/var` on a returning tag", () => {
    const page = join(
      import.meta.dirname,
      "fixtures",
      "discovered-tag",
      "page.mx",
    );
    const diagnostics = diagnoseDocument(
      "<counter/n start=1/>\n<p>${n}</p>\n",
      pathToFileURL(page).href,
      { host: "html" },
    );

    expect(diagnostics).toEqual([]);
  });

  it("reports nothing for a page calling a discovered template tag", () => {
    // The unit-model path through this server: `tags/icon.mx` is a template,
    // so the caller emits an import of its compiled module rather than
    // expanding it. Undiscovered, `<icon>` would be a compile error naming
    // the tag, so an empty result is the assertion — the same shape the
    // stdio test uses for the sidecar tag beside it.
    const page = join(
      import.meta.dirname,
      "fixtures",
      "discovered-tag",
      "page.mx",
    );
    const diagnostics = diagnoseDocument(
      '<div><icon name="star"/></div>\n',
      `file://${page}`,
      { host: "html" },
    );

    expect(diagnostics).toEqual([]);
  });

  it("renders <let>'s initial value (no error) under the non-strict policy", () => {
    // `${count}` here is MX's own placeholder syntax inside the source
    // string being compiled, not a JS template literal — biome's
    // noTemplateCurlyInString can't tell the two apart.
    const source = "<let/count=1/>\n<p>${count}</p>\n";
    const diagnostics = diagnoseDocument(source, "file:///project/App.mx", {
      host: "html",
    });

    expect(diagnostics).toEqual([]);
  });

  it("never throws on an unexpected exception, and reports nothing", () => {
    const onUnexpectedError = vi.fn();

    // Deliberately violate the public input type to make the underlying
    // compiler throw a locationless TypeError. Real syntax errors now carry
    // `loc` and must become diagnostics, regardless of their concrete class.
    const diagnostics = diagnoseDocument(
      null as unknown as string,
      "file:///project/App.solid.mx",
      { host: "html" },
      onUnexpectedError,
    );

    expect(diagnostics).toEqual([]);
    expect(onUnexpectedError).toHaveBeenCalledTimes(1);
  });

  it("reports a Solid host error at its file-absolute position inside a .solid.mx region", () => {
    const source = `import { createSignal } from "solid-js";

export const view = () => (
  <div>
    <let/count=1/>
  </div>
);
`;
    const diagnostics = diagnoseDocument(
      source,
      "file:///project/App.solid.mx",
      { host: "solid" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: 1,
      source: "mxlang",
      range: {
        start: { line: 4, character: 4 },
        end: { line: 4, character: 5 },
      },
    });
    expect(diagnostics[0]?.message).toMatch(/let/i);
  });

  it("reports an expression parse error inside a .solid.mx region", () => {
    const source = "export const view = () => (\n  <p>${a b}</p>\n);\n";
    const diagnostics = diagnoseDocument(
      source,
      "file:///project/App.solid.mx",
      { host: "solid" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.range).toEqual({
      start: { line: 1, character: 9 },
      end: { line: 1, character: 10 },
    });
  });

  it("reports a TypeScript syntax error outside every .solid.mx region", () => {
    const source =
      "const answer: = 42;\nexport const view = () => <p>ok</p>;\n";
    const diagnostics = diagnoseDocument(
      source,
      "file:///project/App.solid.mx",
      { host: "solid" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.range).toEqual({
      start: { line: 0, character: 14 },
      end: { line: 0, character: 15 },
    });
  });

  it("reports nothing for a clean .solid.mx document", () => {
    const diagnostics = diagnoseDocument(
      "export const view = () => <p>hello</p>;\n",
      "file:///project/App.solid.mx",
      { host: "solid" },
    );

    expect(diagnostics).toEqual([]);
  });

  it("uses the Solid host profile for a whole-file .mx document", () => {
    const diagnostics = diagnoseDocument(
      "<let/count=1/>\n",
      "file:///project/App.mx",
      { host: "solid" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/let/i);
    expect(diagnostics[0]?.range.start).toEqual({ line: 0, character: 0 });
  });
});

describe("the Preact host", () => {
  // `<let>` is valid Marko and renders its initial value under the html
  // host, so a diagnostic here can only come from the Preact host's own
  // declarations — which is what proves the switch routed the document.
  it("diagnoses a stateful tag through @mxlang/preact", () => {
    const diagnostics = diagnoseDocument(
      "<let/count=0/>\n<p>${count}</p>\n",
      "file:///app/greeting.mx",
      { host: "preact" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("useState");
  });

  it("reports nothing for a valid Preact-host document", () => {
    const diagnostics = diagnoseDocument(
      "export interface Input { name: string }\n<h1>${input.name}</h1>\n",
      "file:///app/greeting.mx",
      { host: "preact" },
    );

    expect(diagnostics).toEqual([]);
  });

  it("ignores `strict`, which this host has no looser mode for", () => {
    // Both spellings resolve to the same declarations: unlike the html host,
    // there is no second policy to select.
    for (const strict of [true, false]) {
      const diagnostics = diagnoseDocument(
        "<let/count=0/>\n<p>${count}</p>\n",
        "file:///app/greeting.mx",
        { host: "preact", strict },
      );
      expect(diagnostics).toHaveLength(1);
    }
  });
});

describe("the React host", () => {
  it("diagnoses a stateful tag through @mxlang/react", () => {
    const diagnostics = diagnoseDocument(
      "<let/count=0/>\n<p>${count}</p>\n",
      "file:///app/greeting.mx",
      { host: "react" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("React's `useState`");
  });

  it("reports nothing for a valid React-host document", () => {
    const diagnostics = diagnoseDocument(
      "export interface Input { name: string }\n<h1>${input.name}</h1>\n",
      "file:///app/greeting.mx",
      { host: "react" },
    );

    expect(diagnostics).toEqual([]);
  });
});

describe("the Hono host", () => {
  it("diagnoses a stateful tag through @mxlang/hono", () => {
    const diagnostics = diagnoseDocument(
      "<let/count=0/>\n<p>${count}</p>\n",
      "file:///app/greeting.mx",
      { host: "hono" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("Hono's `useState`");
  });

  it("reports nothing for a valid Hono-host document", () => {
    const diagnostics = diagnoseDocument(
      "export interface Input { name: string }\n<h1>${input.name}</h1>\n",
      "file:///app/greeting.mx",
      { host: "hono" },
    );

    expect(diagnostics).toEqual([]);
  });

  describe("custom tag discovery", () => {
    const scratches: string[] = [];

    afterEach(() => {
      clearScanCache();
      for (const dir of scratches.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    function project(sidecar: string) {
      const dir = mkdtempSync(join(tmpdir(), "mx-ls-tags-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"l","mx":{"host":"html"}}',
      );
      mkdirSync(join(dir, "tags"), { recursive: true });
      const tagFile = join(dir, "tags", "thing.tag.ts");
      writeFileSync(tagFile, sidecar);
      return { dir, tagFile, caller: join(dir, "caller.mx") };
    }

    it("accepts a call to a tag discovered with no import", () => {
      const { caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('ok')] };\n",
      );

      // Without discovery this would be a compile error naming `<thing>`, so
      // an empty result is the assertion: the editor resolves the same tag a
      // build does.
      expect(diagnoseDocument("<thing/>\n", caller, { host: "html" })).toEqual(
        [],
      );
    });

    it("reports a sidecar with unreadable parseOptions as a diagnostic", () => {
      const { caller } = project(
        [
          "const shared = { text: true };",
          "export default { parseOptions: shared };",
        ].join("\n"),
      );

      const diagnostics = diagnoseDocument("<thing/>\n", caller, {
        host: "html",
      });

      // One diagnostic, naming the file the author has to fix — not a crash,
      // and not silence that would leave the editor disagreeing with a build.
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.message).toContain("thing.tag.ts");
      expect(diagnostics[0]?.source).toBe("mxlang");
    });

    it("reports a sidecar that throws on load as a diagnostic", () => {
      const { tagFile, caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('ok')] };\n",
      );
      expect(diagnoseDocument("<thing/>\n", caller, { host: "html" })).toEqual(
        [],
      );

      // The author breaks the sidecar; the document they have open is
      // untouched. The server must surface it rather than throw out of
      // `diagnoseDocument`, which is what would take the connection down.
      writeFileSync(tagFile, 'throw new Error("broken on purpose");\n');
      const when = new Date(Date.now() + 10_000);
      utimesSync(tagFile, when, when);

      const diagnostics = diagnoseDocument("<thing/>\n", caller, {
        host: "html",
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.message).toContain("thing.tag.ts");
    });

    it("sees a tag added to a tags/ directory after the first diagnose", () => {
      const { dir, caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('ok')] };\n",
      );
      expect(diagnoseDocument("<thing/>\n", caller, { host: "html" })).toEqual(
        [],
      );

      writeFileSync(join(dir, "tags", "added.mx"), "<em>new</em>\n");

      // Discovered and expanded, so the call is clean: an added file
      // invalidates the cached scan. Before P3 this asserted the
      // template-expansion gate instead, which is what a hookless discovered
      // tag used to report; now a template tag is complete on its own.
      expect(diagnoseDocument("<added/>\n", caller, { host: "html" })).toEqual(
        [],
      );

      // The negative half the old assertion carried: an *undiscovered* name is
      // still an error, so the clean result above is the scan working rather
      // than every unknown tag being accepted.
      const unknown = diagnoseDocument("<missing/>\n", caller, {
        host: "html",
      });
      expect(unknown).toHaveLength(1);
      expect(unknown[0]?.message).toContain("missing");
    });
  });
});

describe("the Angular host", () => {
  // The LS does not diagnose Angular-host documents: `mx-tsc` and the TS
  // plugin own them. Silence is honest; an Error here is a false positive on
  // every file, clean ones included.
  it("reports nothing for a clean whole-file .mx page", () => {
    expect(
      diagnoseDocument("<div>hi</div>\n", "file:///app/greeting.mx", {
        host: "angular",
      }),
    ).toEqual([]);
  });

  it("reports nothing for a clean .ng.mx file", () => {
    expect(
      diagnoseDocument(
        "<div>hi</div>\n",
        "file:///app/greeting.component.ng.mx",
        { host: "angular" },
      ),
    ).toEqual([]);
  });

  it("raises no Error for a broken Angular-host file (mx-tsc reports it)", () => {
    const diagnostics = diagnoseDocument(
      "<div>unclosed\n",
      "file:///app/broken.component.ng.mx",
      { host: "angular" },
    );
    expect(
      diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error),
    ).toEqual([]);
  });

  it.each(["react", "solid", "preact", "hono", "html", "astro"] as const)(
    "never compiles a .ng.mx under the %s host (file kind wins)",
    (host) => {
      expect(
        diagnoseDocument("<@tags/>\n", "file:///app/x.ng.mx", { host }),
      ).toEqual([]);
    },
  );

  it("matches .NG.mx case-insensitively, like the TS plugin", () => {
    expect(
      diagnoseDocument("<@tags/>\n", "file:///app/X.NG.mx", { host: "html" }),
    ).toEqual([]);
  });

  it("raises no Error for an unknown-host .ng.mx with a react dependency's policy", () => {
    expect(
      diagnoseDocument("<@tags/>\n", "file:///app/x.ng.mx", { host: "react" }),
    ).toEqual([]);
  });

  it("still returns host-policy warnings", () => {
    const diagnostics = diagnoseDocument(
      "<div>hi</div>\n",
      "file:///app/greeting.mx",
      { host: "angular" },
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      [
        {
          file: "/app/package.json",
          message: "some warning",
          line: 1,
          column: 0,
        },
      ],
    );
    expect(diagnostics.map((d) => d.severity)).toEqual([
      DiagnosticSeverity.Warning,
    ]);
  });
});

describe("an unknown mx.host", () => {
  const unknownHost = {
    file: "/app/package.json",
    message:
      'unknown mx.host "angualr"; valid hosts: html, astro, solid, preact, react, hono, angular. Ignoring it; the host is taken from the @mxlang dependencies instead.',
    line: 5,
    column: 13,
  };

  it("a24's shape: an .ng.mx under a derived html host gets the warning only", () => {
    // `@tags` outside an element is an html-compile error (the false error
    // the audit saw for a24); a `.ng.mx` is routed by file kind and never
    // reaches the html compile, whatever host the resolver derived.
    const diagnostics = diagnoseDocument(
      "<@tags/>\n",
      "file:///app/x.component.ng.mx",
      { host: "html" },
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      [unknownHost],
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe(DiagnosticSeverity.Warning);
    expect(diagnostics[0]?.message).toContain('unknown mx.host "angualr"');
  });

  it("h23's shape: an .mx page compiles under the derived host, plus the warning", () => {
    const diagnostics = diagnoseDocument(
      "<div>\n",
      "file:///app/page.mx",
      { host: "html" },
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      [unknownHost],
    );
    expect(diagnostics.map((d) => d.severity)).toEqual([
      DiagnosticSeverity.Warning,
      DiagnosticSeverity.Error,
    ]);
  });
});

describe("custom tag template positions", () => {
  const template = (source: string): Record<string, CustomTag> => {
    const box: TemplateBackedTag = {
      template: { filename: "/tags/box.mx", source },
    };
    return { box };
  };

  it("reports a diagnostic inside a tag template against that template", () => {
    const diagnostics = diagnoseDocument(
      "<div>\n  <box/>\n</div>\n",
      "file:///app/page.mx",
      { host: "html" },
      undefined,
      "",
      // `<else>` with no preceding `<if>`: raised on the template's line 3.
      template("<div>\n</div>\n<else>oops</else>\n"),
    );

    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics as [(typeof diagnostics)[number]];
    // The message names the template, so the author knows which file to open.
    expect(diagnostic.message).toContain("`<else>` without a preceding `<if>`");
    expect(diagnostic.message).toContain("/tags/box.mx");
    // And it is *not* placed on the template's line 3 within this document,
    // which is a different file's line and would underline unrelated markup.
    expect(diagnostic.range.start.line).toBe(0);
  });

  it("publishes the template's diagnostic against the template's own URI", () => {
    const related: RelatedDiagnostics[] = [];
    diagnoseDocument(
      "<div>\n  <box/>\n</div>\n",
      "file:///app/page.mx",
      { host: "html" },
      undefined,
      "",
      template("<div>\n</div>\n<else>oops</else>\n"),
      related,
    );

    expect(related).toHaveLength(1);
    const [entry] = related as [(typeof related)[number]];
    expect(entry.uri).toBe("file:///tags/box.mx");
    // At the template's real position -- line 3, one-based, is LSP line 2.
    expect(entry.diagnostics[0]?.range.start.line).toBe(2);
    expect(entry.diagnostics[0]?.message).toContain(
      "`<else>` without a preceding `<if>`",
    );
  });

  it("reports a dropped body as a warning on the calling document", () => {
    const related: RelatedDiagnostics[] = [];
    const diagnostics = diagnoseDocument(
      "<div>\n  <box>dropped</box>\n</div>\n",
      "file:///app/page.mx",
      { host: "html" },
      undefined,
      "",
      // No `<${input.content}/>`: the body the caller wrote goes nowhere.
      template("<div>no slot</div>"),
      related,
    );

    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics as [(typeof diagnostics)[number]];
    expect(diagnostic.severity).toBe(2); // DiagnosticSeverity.Warning
    expect(diagnostic.message).toContain("body content was dropped");
    // On the call, which is the line the author can act on.
    expect(diagnostic.range.start.line).toBe(1);
  });

  it("keeps a call-site diagnostic on the caller's own position", () => {
    const box: TemplateBackedTag = {
      template: { filename: "/tags/box.mx", source: "<div>ok</div>" },
      attributes: { good: { type: "string" } },
    };
    const declared: Record<string, CustomTag> = { box };
    const diagnostics = diagnoseDocument(
      "<div>\n  <box bad=1/>\n</div>\n",
      "file:///app/page.mx",
      { host: "html" },
      undefined,
      "",
      declared,
    );

    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics as [(typeof diagnostics)[number]];
    expect(diagnostic.message).toContain("unknown attribute `bad`");
    // Source line 2 (1-based) is LSP line 1 (0-based): the call itself.
    expect(diagnostic.range.start.line).toBe(1);
  });

  it("reports nothing for a template that compiles", () => {
    expect(
      diagnoseDocument(
        "<div><box/></div>\n",
        "file:///app/page.mx",
        { host: "html" },
        undefined,
        "",
        template("<span>fine</span>"),
      ),
    ).toEqual([]);
  });

  it("pins a host-policy diagnostic to 1:1 of the document, naming package.json:line:col, with relatedInformation at the real spot", () => {
    const related: RelatedDiagnostics[] = [];
    const diagnostics = diagnoseDocument(
      "<div>ok</div>\n",
      "file:///app/page.mx",
      { host: "html" },
      undefined,
      "",
      undefined,
      related,
      undefined,
      [
        {
          file: "/app/package.json",
          message: 'unknown mx.host "htmll"',
          line: 4,
          column: 12,
        },
      ],
    );

    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics as [(typeof diagnostics)[number]];
    expect(diagnostic.severity).toBe(2); // DiagnosticSeverity.Warning
    expect(diagnostic.source).toBe("mxlang");
    // Line:col is 1-based in the message, like mx-tsc's `file(line,col)`.
    expect(diagnostic.message).toBe(
      '/app/package.json:4:13: unknown mx.host "htmll"',
    );
    // The document has no coordinate for this: 1:1, never package.json's.
    expect(diagnostic.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    });
    expect(diagnostic.relatedInformation).toEqual([
      {
        location: {
          uri: "file:///app/package.json",
          range: {
            start: { line: 3, character: 12 },
            end: { line: 3, character: 13 },
          },
        },
        message: 'unknown mx.host "htmll"',
      },
    ]);
    // ...and the same problem is published on package.json at its real range.
    expect(related).toHaveLength(1);
    expect(related[0]?.uri).toBe("file:///app/package.json");
    expect(related[0]?.diagnostics).toEqual([
      {
        severity: 2,
        source: "mxlang",
        message: 'unknown mx.host "htmll"',
        range: {
          start: { line: 3, character: 12 },
          end: { line: 3, character: 13 },
        },
      },
    ]);
  });

  it("keeps host-policy warnings when the compile itself fails", () => {
    const diagnostics = diagnoseDocument(
      "<let/count=1/>\n",
      "file:///app/page.mx",
      { host: "html", strict: true },
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      [{ file: "/app/package.json", message: "m", line: 1, column: 0 }],
    );

    expect(diagnostics.map((d) => d.severity)).toEqual([2, 1]);
  });

  it("returns exactly the same diagnostics whether hostPolicyDiagnostics is omitted or empty", () => {
    const call = (extra: unknown[]) =>
      (diagnoseDocument as unknown as (...args: unknown[]) => unknown)(
        "<let/count=1/>\n",
        "file:///app/page.mx",
        { host: "html", strict: true },
        undefined,
        "",
        undefined,
        undefined,
        undefined,
        ...extra,
      );

    expect(call([[]])).toEqual(call([]));
    expect(call([undefined])).toEqual(call([]));
  });
});

describe("diagnoseDocument given a file:// URI", () => {
  // Marko prints the compiled file's name in its message; a URI there became
  // `<cwd>/file:/...` when resolved as a path.
  it.each(["react", "preact", "hono", "solid", "html"] as const)(
    "the %s compile reports the file path, not a file: URI",
    (host) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-uri-")));
      try {
        const path = join(dir, "page.mx");
        const diagnostics = diagnoseDocument(
          "<div>\n",
          pathToFileURL(path).href,
          { host },
        );
        const error = diagnostics.find((d) => d.severity === 1);
        expect(error, JSON.stringify(diagnostics)).toBeDefined();
        // The path no longer rides in the message (the range carries the
        // position); a URI mistaken for a path would still leak a `file:` or a
        // cwd-relative `../` hop into the message or the frame.
        const frame = (error?.data as { codeFrame?: string } | undefined)
          ?.codeFrame;
        const text = stripVTControlCharacters(
          `${error?.message}\n${frame ?? ""}`,
        );
        expect(frame, "frame carried in data").toBeDefined();
        expect(text).not.toContain("file:");
        expect(text).not.toContain("../");
        expect(text).not.toContain(path);
      } finally {
        rmSync(dir, { recursive: true });
      }
    },
  );
});

describe("host-policy message wording", () => {
  it("names the package.json once when core's message already opens with it", () => {
    const diagnostics = diagnoseDocument(
      "<div>ok</div>\n",
      "file:///app/page.mx",
      { host: "html" },
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      [
        {
          file: "/app/package.json",
          message: "/app/package.json could not be parsed as JSON; using html",
          line: 1,
          column: 0,
        },
      ],
    );
    expect(diagnostics[0]?.message).toBe(
      "/app/package.json:1:1: could not be parsed as JSON; using html",
    );
  });
});

describe("compiler code frame placement", () => {
  const frameLine = /^\s*(>\s*)?\d+ \||^\s*\|\s*\^/m;

  it("keeps a compact message and moves the frame to data.codeFrame", () => {
    const [d] = diagnoseDocument(
      "<div>\n  <p>hi</p>\n",
      "file:///project/page.mx",
      { host: "html" },
    );
    expect(d?.message).toBe('Missing ending "div" tag');
    expect(d?.message).not.toMatch(frameLine);
    expect(d?.message).not.toContain("page.mx");
    const frame = (d?.data as { codeFrame?: string } | undefined)?.codeFrame;
    expect(frame).toBeDefined();
    expect(frame).toBe(stripVTControlCharacters(frame ?? ""));
    expect(frame).toMatch(/^> 1 \| <div>/);
    expect(frame).toContain('^^^^^ Missing ending "div" tag');
    expect(frame).not.toContain("page.mx");
  });

  it("strips colour from the frame and the message (CI colourises)", () => {
    const { message, codeFrame } = splitCodeFrame(
      "\n    at /project/page.mx:1:1\n    \u001b[31m>\u001b[0m 1 | <div>\n        \u001b[31m|\u001b[0m ^^^^^ boom\n      2 |",
    );
    expect(message).toBe("boom");
    expect(codeFrame).toBe("> 1 | <div>\n    | ^^^^^ boom\n  2 |");
  });

  it("splits only a message that carries a frame", () => {
    expect(splitCodeFrame("plain text")).toEqual({ message: "plain text" });
    expect(splitCodeFrame("a > 1 | b")).toEqual({ message: "a > 1 | b" });
    // a frame whose caret line has no text keeps the whole message
    const bare = "at x:1:1\n> 1 | <div>\n    | ^^^^^";
    expect(splitCodeFrame(bare).message).toBe(bare);
  });

  it("leaves a message with no frame unchanged and adds no data", () => {
    const [d] = diagnoseDocument("<let/count=1/>\n", "file:///project/App.mx", {
      host: "html",
      strict: true,
    });
    expect(d?.message).toMatch(/let/i);
    expect(d?.message).not.toMatch(frameLine);
    expect(d?.data).toBeUndefined();
  });
});
