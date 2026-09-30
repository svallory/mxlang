/**
 * Unresolved-tag parity (decision 114): an unresolved capitalized tag is
 * Marko 6.3.51's compile error on Angular too — "Unable to find entry point
 * for custom tag `<Name>`." — routed through the same core check every
 * other Marko-parity host wires into (`rejectUnknownTag`; html #149, Solid
 * #151, preact/react/hono/astro #156), never the casing-only fallback that
 * used to emit `<mx-totally-undefined>` and a step-1 import warning.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { compileNgMx } from "../src/ng-mx.ts";
import { compileTagModule } from "../src/tag-module.ts";
import { assertAngularParses, compileMx, emit } from "./helpers.ts";

const MARKO_ERROR =
  "Unable to find entry point for custom tag `<TotallyUndefined>`.";

describe("unresolved capitalized tag (decision 114)", () => {
  it("is Marko's compile error, self-closing", () => {
    expect(() => compile("<TotallyUndefined/>", "x.mx")).toThrowError(
      MARKO_ERROR,
    );
  });

  it("is Marko's compile error with a body", () => {
    expect(() =>
      compile("<TotallyUndefined>body</TotallyUndefined>", "x.mx"),
    ).toThrowError(MARKO_ERROR);
  });

  it("is Marko's compile error with an attribute", () => {
    expect(() => compile("<TotallyUndefined a=1/>", "x.mx")).toThrowError(
      MARKO_ERROR,
    );
  });

  it("is Marko's compile error inside a .ng.mx region", () => {
    const source = [
      'import { Component } from "@angular/core";',
      "",
      "@Component({",
      '  selector: "app-x",',
      "  template: <TotallyUndefined/>,",
      "})",
      "export class XComponent {}",
    ].join("\n");
    expect(() => compileNgMx(source, "/p/x.component.ng.mx")).toThrowError(
      MARKO_ERROR,
    );
  });
});

describe("resolvable tags still compile (decision 114)", () => {
  it("a <define> call resolves", () => {
    const out = emit("<define/Row|a|>${a}</define><Row(1)/>");
    expect(out).toContain("[ngTemplateOutlet]");
    assertAngularParses(out);
  });

  it("a capitalized local binding routes dynamic, never unresolved (decisions 113/116)", () => {
    // A `<for>` tag param binds `Item` in scope; its runtime value cannot be
    // inspected at compile time, so the call lowers to a dynamic component
    // outlet — not to `mx-item`, and not to Marko's unresolved error.
    const out = emit("<for|Item| of=components><Item/></for>");
    expect(out).toContain('[ngComponentOutlet]="Item"');
    assertAngularParses(out);
  });

  it("an authored dynamic tag keeps lowering to ngComponentOutlet", () => {
    const out = emit("<${Cmp}/>");
    expect(out).toContain('[ngComponentOutlet]="Cmp"');
    assertAngularParses(out);
  });

  it("a discovered custom tag resolves to its selector", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-ng-unresolved-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f" }));
    mkdirSync(join(dir, "tags"));
    writeFileSync(
      join(dir, "tags", "badge.mx"),
      '<span class="badge">x</span>\n',
    );
    const filePath = join(dir, "page.mx");
    const result = compile("<div><badge/></div>", filePath, {
      customTags: getCustomTags(filePath, { host: "angular" }),
    });
    expect(result.code).toContain("<mx-badge>");
    assertAngularParses(result.code);
  });

  it("a value import used as a tag routes dynamic (decision 116)", () => {
    // Not a `.mx` default import, so the callee is a runtime value: the call
    // emits ngComponentOutlet with the attributes as its inputs, and the tag
    // module imports NgComponentOutlet itself.
    const dir = mkdtempSync(join(tmpdir(), "mx-ng-valueimport-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f" }));
    const path = join(dir, "page.mx");
    const source = 'import { Cmp } from "./cmp.ts";\n<Cmp a=1/>\n';
    const result = compileTagModule(source, path);
    // The template is JSON-quoted inside the emitted module, so the
    // assertions match the quoted spelling.
    expect(result.code).toContain('[ngComponentOutlet]=\\"Cmp\\"');
    expect(result.code).toContain('[ngComponentOutletInputs]=\\"{ a: 1 }\\"');
    expect(result.code).toContain("NgComponentOutlet");
  });

  it("a .mx default import resolves to its emitted module's selector", () => {
    // Covered exhaustively in tag-module.test.ts; restated here because this
    // change touched the same routing: a `.mx` default import is Marko's
    // statically-resolved component case and must NOT route dynamic.
    const dir = mkdtempSync(join(tmpdir(), "mx-ng-mximport-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f" }));
    // The callee must exist: an import whose file cannot be read is an error
    // (its exported `selector` is part of the call site), not a guess.
    writeFileSync(join(dir, "badge.mx"), "<b>!</b>\n");
    const path = join(dir, "page.mx");
    const source = 'import Badge from "./badge.mx";\n<div><Badge/></div>\n';
    const result = compileTagModule(source, path);
    expect(result.code).toContain("<mx-badge>");
    expect(result.code).not.toContain("[ngComponentOutlet]");
  });

  it("the step-1 used-tag import warning survives for resolved tags", () => {
    // The warning's job was never to paper over an unbound tag: it tells the
    // author which Angular-side import their *resolved* MX tag needs.
    const { warnings } = compileMx(
      "<for|Item| of=components><Item/></for>",
      "x.mx",
    );
    expect(warnings.some((w) => /NgComponentOutlet/.test(w.message))).toBe(
      true,
    );
  });
});
