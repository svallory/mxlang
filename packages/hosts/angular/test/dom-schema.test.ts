/**
 * Angular's DOM schema as the emitter reads it (`src/dom-schema.ts`): the
 * private type map's shape on the pinned `@angular/compiler`, the
 * case-insensitive rescue, the interface-typed properties, names the schema
 * does not know, SVG, and the loud, positioned failure when the optional peer
 * is missing or out of range.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { TranslateError } from "@mxlang/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  INTERFACE_TYPED_PROPERTIES,
  nativeBinding,
  SCHEMA_SHAPE_CHECKED_AGAINST,
} from "../src/dom-schema.ts";
import { compile } from "../src/index.ts";
import { RESCUED } from "./primitive-attribute-rescued.ts";

const here = join(import.meta.dirname, "x.mx");
const require = createRequire(import.meta.url);

describe("the private type map", () => {
  it("is checked against the installed @angular/compiler", () => {
    // Bumping Angular means re-checking `_schema` (shape and boolean
    // classification) and moving SCHEMA_SHAPE_CHECKED_AGAINST.
    const { version } = require("@angular/compiler/package.json") as {
      version: string;
    };
    expect(version).toBe(SCHEMA_SHAPE_CHECKED_AGAINST);
  });

  it("has the shape and classification the emitter relies on", () => {
    const { DomElementSchemaRegistry } = require("@angular/compiler") as {
      DomElementSchemaRegistry: new () => { _schema?: unknown };
    };
    const types = new DomElementSchemaRegistry()._schema;
    expect(types).toBeInstanceOf(Map);
    const map = types as Map<string, Map<string, string>>;
    expect(map.get("input")?.get("checked")).toBe("boolean");
    expect(map.get("input")?.get("value")).toBe("string");
    expect(map.get("button")?.get("disabled")).toBe("boolean");
    expect(map.get("unknown")?.get("hidden")).toBe("boolean");
    expect(map.get("unknown")?.get("title")).toBe("string");
  });

  it("classifies boolean and non-boolean properties through it", () => {
    expect(nativeBinding("input", "checked", here)).toEqual({
      kind: "property",
      type: "boolean",
    });
    expect(nativeBinding("div", "hidden", here)).toEqual({
      kind: "property",
      type: "boolean",
    });
    expect(nativeBinding("div", "title", here)).toEqual({
      kind: "property",
      type: "other",
    });
    expect(nativeBinding("div", "tabindex", here)).toEqual({
      kind: "property",
      type: "other",
    });
  });
});

describe("binding by the schema", () => {
  it.each(RESCUED)(
    "<%s %s>: the IDL spelling differs, so it is an attribute",
    (tag, name) => {
      expect(nativeBinding(tag, name, here)).toEqual({ kind: "attribute" });
    },
  );

  it.each([
    ["div", "role"],
    ["div", "hi"],
    ["div", "header"],
    ["input", "lable"],
  ])(
    "<%s %s>: unknown to the schema in any case, so [name] untouched",
    (tag, name) => {
      expect(nativeBinding(tag, name, here)).toEqual({ kind: "unknown" });
    },
  );

  it("a property of another element only is an attribute here", () => {
    expect(nativeBinding("div", "disabled", here)).toEqual({
      kind: "attribute",
    });
  });

  it.each([...INTERFACE_TYPED_PROPERTIES])(
    "<%s %s>: an interface-typed property is an attribute",
    (tag, name) => {
      expect(nativeBinding(tag, name, here)).toEqual({ kind: "attribute" });
    },
  );

  it("every lowercase interface-typed property of the schema is listed or takes a string", () => {
    // The schema's `"object"` type also covers token lists with
    // `[PutForwards=value]` (`part`, `sandbox`, `sizes`), which accept a string.
    const { DomElementSchemaRegistry } = require("@angular/compiler") as {
      DomElementSchemaRegistry: new () => {
        _schema: Map<string, Map<string, string>>;
      };
    };
    const found = new Set<string>();
    for (const [element, properties] of new DomElementSchemaRegistry()
      ._schema) {
      if (element.startsWith(":")) continue;
      for (const [name, type] of properties) {
        if (
          type === "object" &&
          name === name.toLowerCase() &&
          name !== "style"
        )
          found.add(name === "part" ? name : `${element}.${name}`);
      }
    }
    expect([...found].sort()).toEqual([
      "iframe.sandbox",
      "input.files",
      "link.sizes",
      "part",
      "table.caption",
    ]);
  });
});

describe("SVG and MathML (absent from the HTML schema)", () => {
  it("keeps [name] for a geometry attribute, as on main", () => {
    const { code } = compile("<svg><circle cx=r/></svg>", "x.mx");
    expect(code).toBe('<svg><circle [cx]="r"></circle></svg>');
  });

  it("binds width on <svg> as [attr.width] (a known HTML attribute name)", () => {
    const { code } = compile("<svg width=w/>", "x.mx");
    expect(code).toContain("[attr.width]");
  });

  it("keeps [name] on a MathML element", () => {
    const { code } = compile("<math><mi mathvariant=v>x</mi></math>", "x.mx");
    expect(code).toBe('<math><mi [mathvariant]="v">x</mi></math>');
  });
});

describe("the optional @angular/compiler peer", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("an out-of-range copy in the project fails at the first attribute that needs it, positioned", () => {
    const project = mkdtempSync(join(tmpdir(), "mx-ng-schema-"));
    dirs.push(project);
    const pkg = join(project, "node_modules/@angular/compiler");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@angular/compiler", version: "21.2.0" }),
    );
    writeFileSync(join(project, "package.json"), "{}");
    const file = join(project, "x.mx");
    // `data-*` and `class` never consult the schema, so they still compile.
    expect(() => compile("<div data-x=a class=b/>", file)).not.toThrow();
    let error: unknown;
    try {
      compile("<div data-x=a>\n  <p title=t/>\n</div>", file);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TranslateError);
    const { line, column } = error as TranslateError;
    const message = stripVTControlCharacters((error as TranslateError).message);
    expect(message).toContain("@angular/compiler 21.2.0");
    expect(message).toContain("outside the supported range >=22.0.0 <23.0.0");
    expect(message).toContain("bun add -d @angular/compiler");
    expect([line, column]).toEqual([2, 5]);
  });
});
