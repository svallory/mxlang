import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CustomTag, TemplateBackedTag } from "@mxlang/core";
import { clearScanCache } from "@mxlang/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseDocument, type RelatedDiagnostics } from "./diagnose.ts";

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
  it("reports the host as not wired in yet, rather than diagnosing under html's declarations", () => {
    const diagnostics = diagnoseDocument(
      "<div>hi</div>\n",
      "file:///app/greeting.mx",
      { host: "angular" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain(
      "the angular host is not wired into @mxlang/language-server yet",
    );
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
});
