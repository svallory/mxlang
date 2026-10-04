import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import { loadSidecar, normalizeMxTags, scanCustomTags } from "./scan.ts";
import type { TemplateBackedTag } from "./template-tag.ts";
import { lookup as targets } from "./test-targets.ts";

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

function caught(run: () => unknown): TranslateError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TranslateError);
    return error as TranslateError;
  }
  throw new Error("expected an error");
}

describe("cross-file errors name the file their coordinates belong to", () => {
  it.each([
    ["<p>ok</p>\n\n<div>\n", 'Missing ending "div" tag', 0],
    ["<p>ok</p>\n\n<else/>\n", "without a preceding", 0],
    ["<section>\n  <div>\n  </span>\n</section>\n", 'closing "span" tag', 2],
  ] as const)(
    "locates a callee parse/translation failure",
    (source, message, column) => {
      const error = caught(() =>
        compileSource(
          "<main>\n  <box/>\n</main>\n",
          "/app/page.mx",
          declarations,
          {
            targets,
            emitIr: () => "",
            customTags: {
              box: {
                template: { filename: "/tags/box.mx", source },
              } as TemplateBackedTag,
            },
          },
        ),
      );
      expect(error.file).toBe("/tags/box.mx");
      expect([error.line, error.column]).toEqual([3, column]);
      expect(error.message).toContain(message);
      expect(error.message).not.toContain("box.mx");
      expect(error.message).not.toContain("page.mx");
    },
  );

  it("locates an aggregate at its first callee parser error and keeps both frames", () => {
    const error = caught(() =>
      compileSource("<aggregate/>\n", "/app/page.mx", declarations, {
        targets,
        emitIr: () => "",
        customTags: {
          aggregate: {
            template: {
              filename: "/tags/aggregate.mx",
              source: "<div a=(x +)/>\n<span>",
            },
          } as TemplateBackedTag,
        },
      }),
    );
    expect(error.file).toBe("/tags/aggregate.mx");
    expect([error.line, error.column]).toEqual([1, 11]);
    expect(error.message).toContain("Unexpected token");
    expect(error.message).toContain('Missing ending "span" tag');
    expect(error.message).not.toContain("aggregate.mx");
    expect(error.message).not.toContain("page.mx");
    expect(error.message).not.toContain("traverseFast");
  });

  it("keeps the deepest callee in a nested template chain", () => {
    const error = caught(() =>
      compileSource("<outer/>\n", "/app/page.mx", declarations, {
        targets,
        emitIr: () => "",
        customTags: {
          outer: {
            template: { filename: "/tags/outer.mx", source: "<inner/>\n" },
          } as TemplateBackedTag,
          inner: {
            template: { filename: "/tags/inner.mx", source: "\n\n<div>\n" },
          } as TemplateBackedTag,
        },
      }),
    );
    expect(error.file).toBe("/tags/inner.mx");
    expect([error.line, error.column]).toEqual([3, 0]);
  });

  it("locates invalid mx.tags in the manifest, not in a caller", () => {
    const error = caught(() =>
      normalizeMxTags(42, "/app", "/app/package.json"),
    );
    expect(error.file).toBe("/app/package.json");
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.message).not.toContain(error.file);
  });

  it.each([
    "export default { attributes: { value: { requried: true } } };",
    "export default { finalize: () => [] };",
  ])("locates a sidecar registration error at the sidecar: %s", (source) => {
    const dir = mkdtempSync(join(tmpdir(), "mx-sidecar-registration-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"name":"x"}');
      mkdirSync(join(dir, "tags"));
      const sidecar = join(dir, "tags/broken.tag.ts");
      writeFileSync(sidecar, source);
      const page = join(dir, "page.mx");
      const customTags = scanCustomTags(page, { targets }).customTags;
      const error = caught(() =>
        compileSource("<broken/>\n", page, declarations, {
          targets,
          emitIr: () => "",
          customTags,
        }),
      );
      expect(error.file).toBe(sidecar);
      expect([error.line, error.column]).toEqual([1, 0]);
      expect(error.message).not.toContain(sidecar);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("locates a sidecar syntax error and a load failure without repeating its path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-cross-file-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"name":"x"}');
      mkdirSync(join(dir, "tags"));
      const file = join(dir, "tags/box.tag.ts");
      writeFileSync(file, "\n\nexport default { parseOptions: ; };\n");
      const parse = caught(() =>
        scanCustomTags(join(dir, "page.mx"), { targets }),
      );
      expect(parse.file).toBe(file);
      expect([parse.line, parse.column]).toEqual([3, 31]);
      expect(parse.message).not.toContain(file);
      writeFileSync(file, 'throw new Error("broken module");\n');
      const load = caught(() => loadSidecar(file));
      expect(load.file).toBe(file);
      expect([load.line, load.column]).toEqual([1, 0]);
      expect(load.message).not.toContain(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
