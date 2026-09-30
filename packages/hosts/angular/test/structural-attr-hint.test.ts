/**
 * A structural attribute (`*ngIf="…"`, `*ngFor="…"`) that is not the first
 * attribute of its tag.
 *
 * Marko reads an attribute value greedily: after `class="a"`, the text
 * ` *ngIf` continues the value as a multiplication, and the `=` that follows
 * makes the whole thing an assignment to a non-assignable target. Marko
 * 5.42.5 (the compiler mx embeds, with the 6.3.51 runtime translator) throws
 * `Invalid left-hand side in assignment expression.` at the *value*, which
 * says nothing about the real cause. The parse is Marko's and stays exactly
 * that; only the message gains the diagnosis and the two fixes.
 */

import { compileSource } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { compileNgMx } from "../src/ng-mx.ts";
import { compileTagModule } from "../src/tag-module.ts";
import { compileMx } from "./helpers.ts";

interface Positioned extends Error {
  line: number;
  column: number;
}

/** Runs `fn` and returns what it threw; fails the test if it did not throw. */
function thrown(fn: () => unknown): Positioned {
  try {
    fn();
  } catch (error) {
    return error as Positioned;
  }
  throw new Error("expected the call to throw");
}

function componentFile(template: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-x",',
    `  template: ${template},`,
    "})",
    "export class XComponent {}",
  ].join("\n");
}

/** The hint, asserted piece by piece: what happened, the attribute, both fixes. */
function expectHint(message: string, structural: string, attribute: string) {
  expect(message).toContain(`\`${structural}\``);
  expect(message).toContain(`\`${attribute}=`);
  expect(message).toContain("multiplication");
  // Fix 1: move it to the first position.
  expect(message).toMatch(/first attribute/);
  // Fix 2: the control-flow tag that replaces the directive.
  if (structural !== "*ngFor") expect(message).toContain("<if=");
  if (structural !== "*ngIf") expect(message).toContain("<for|");
  // The old message said nothing about the cause.
  expect(message).not.toContain("Invalid left-hand side");
}

describe("non-first structural attribute: .mx page", () => {
  const cases: {
    name: string;
    source: string;
    structural: string;
    attribute: string;
    /** 1-based line of the `*`. */
    line: number;
    /** 0-based column of the `*`. */
    column: number;
  }[] = [
    {
      name: "*ngIf after a static attribute",
      source: '<div class="a" *ngIf="x">y</div>',
      structural: "*ngIf",
      attribute: "class",
      line: 1,
      column: 15,
    },
    {
      name: "*ngFor after a static attribute",
      source: '<li class="a" *ngFor="let i of xs">y</li>',
      structural: "*ngFor",
      attribute: "class",
      line: 1,
      column: 14,
    },
    {
      name: "*ngIf with an `else` template",
      source: '<div id="a" *ngIf="x; else tpl">y</div>',
      structural: "*ngIf",
      attribute: "id",
      line: 1,
      column: 12,
    },
    {
      name: "*ngIf after an expression value with operators",
      source: '<div a=b + c *ngIf="x">y</div>',
      structural: "*ngIf",
      attribute: "a",
      line: 1,
      column: 13,
    },
    {
      name: "*ngIf after a value holding a string that looks like one",
      source: '<div a="x" b="p *q=r" *ngIf="x">y</div>',
      structural: "*ngIf",
      attribute: "b",
      line: 1,
      column: 22,
    },
    {
      name: "a second structural attribute after a first-position one",
      source: '<div *ngIf="x" class="a" *ngFor="let i of xs">y</div>',
      structural: "*ngFor",
      attribute: "class",
      line: 1,
      column: 25,
    },
    {
      name: "a structural attribute that is not an ng one",
      source: '<div a=1 *transloco="let t">y</div>',
      structural: "*transloco",
      attribute: "a",
      line: 1,
      column: 9,
    },
    {
      name: "*ngIf on line 3 of a multi-line tag",
      source: '<div\n  class="a"\n  *ngIf="x"\n>y</div>',
      structural: "*ngIf",
      attribute: "class",
      line: 3,
      column: 2,
    },
    {
      name: "*ngIf on line 2 after an attribute on the tag's first line",
      source: '<div class="a"\n     *ngIf="x">y</div>',
      structural: "*ngIf",
      attribute: "class",
      line: 2,
      column: 5,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: a positioned error with the cause and both fixes`, () => {
      const error = thrown(() => compile(c.source, "t.mx"));
      expectHint(error.message, c.structural, c.attribute);
      expect(error.name).toBe("TranslateError");
      expect({ line: error.line, column: error.column }).toEqual({
        line: c.line,
        column: c.column,
      });
    });
  }

  it("names the matching control-flow tag for each directive", () => {
    const ngIf = thrown(() => compile('<div a=1 *ngIf="x">y</div>', "t.mx"));
    const ngFor = thrown(() =>
      compile('<div a=1 *ngFor="let i of xs">y</div>', "t.mx"),
    );
    expect(ngIf.message).toContain("<if=cond>");
    expect(ngFor.message).toContain("<for|item| of=items>");
  });
});

describe("non-first structural attribute: .ng.mx region", () => {
  it("reports the `*` position in the file, not in the region", () => {
    const error = thrown(() =>
      compileNgMx(
        componentFile('<div class="a" *ngIf="x">hi</div>'),
        "/p/x.component.ng.mx",
      ),
    );
    expectHint(error.message, "*ngIf", "class");
    // Line 5 of the file; `  template: <div class="a" ` is 27 chars before `*`.
    expect(error.message).toContain("(5:27)");
  });

  it("reports a later line for a multi-line tag", () => {
    const error = thrown(() =>
      compileNgMx(
        componentFile(
          '<div\n    class="a"\n    *ngFor="let i of xs"\n  >hi</div>',
        ),
        "/p/x.component.ng.mx",
      ),
    );
    expectHint(error.message, "*ngFor", "class");
    expect(error.message).toContain("(7:4)");
  });
});

describe("what must not change", () => {
  it("compiles a first-position structural attribute through as before", () => {
    expect(compileMx('<div *ngIf="x" class="a">y</div>').code).toBe(
      '<div *ngIf="x" class="a">y</div>',
    );
    expect(compileMx('<div a *ngIf="x">y</div>').code).toBe(
      '<div a *ngIf="x">y</div>',
    );
  });

  it("compiles a first-position structural attribute in a region as before", () => {
    const { code } = compileNgMx(
      componentFile('<div *ngIf="x" class="a">hi</div>'),
      "/p/x.component.ng.mx",
    );
    expect(code).toContain('template: `<div *ngIf="x" class="a">hi</div>`');
  });

  it("keeps a multiplication in an attribute value, with no hint", () => {
    expect(compileMx("<div a=b *c>y</div>").code).toBe(
      '<div [a]="b *c">y</div>',
    );
    expect(compileMx("<div a=(b * c)>y</div>").code).toBe(
      '<div [a]="b * c">y</div>',
    );
    // No `=` after the name: still a multiplication, still Marko's meaning.
    expect(compileMx("<div a=1 *foo>y</div>").code).toBe(
      '<div [a]="1 *foo">y</div>',
    );
    expect(compileMx("<div a=b *ngIf>y</div>").code).toBe(
      '<div [a]="b *ngIf">y</div>',
    );
  });

  it("keeps a multiplication in a region, with no hint", () => {
    const { code } = compileNgMx(
      componentFile("<div a=b *c>hi</div>"),
      "/p/x.component.ng.mx",
    );
    expect(code).toContain('template: `<div [a]="b *c">hi</div>`');
  });

  it("leaves an unrelated invalid-left-hand-side error byte-for-byte", () => {
    // `+b=2` is the same Marko failure without the `*` — not ours to explain.
    const error = thrown(() => compile("<div a=1 +b=2>x</div>", "t.mx"));
    expect(error.constructor.name).toBe("CompileError");
    expect(error.message).toBe(
      "\n    at t.mx:1:8\n    > 1 | <div a=1 +b=2>x</div>\n        |        ^ Invalid left-hand side in assignment expression.",
    );
  });

  it("leaves an unrelated parse error byte-for-byte", () => {
    const error = thrown(() => compile("<div>x", "t.mx"));
    expect(error.message).toBe(
      '\n    at t.mx:1:1\n    > 1 | <div>x\n        | ^^^^^ Missing ending "div" tag',
    );
  });

  it("leaves an unrelated region error byte-for-byte", () => {
    const error = thrown(() =>
      compileNgMx(componentFile("<div a=1 +b=2>hi</div>"), "/p/x.ng.mx"),
    );
    expect(error.message).toBe(
      "Invalid left-hand side in assignment expression. (5:19)",
    );
  });
});

describe("non-first structural attribute: tag module", () => {
  it("explains it at the `*`, with the file left unset", () => {
    const error = thrown(() =>
      compileTagModule('<div class="a" *ngIf="x">y</div>', "/p/tags/badge.mx"),
    );
    expectHint(error.message, "*ngIf", "class");
    expect({ line: error.line, column: error.column }).toEqual({
      line: 1,
      column: 15,
    });
    expect((error as { file?: string }).file).toBeUndefined();
  });

  it("reports a later line for a multi-line tag", () => {
    const error = thrown(() =>
      compileTagModule(
        '<div\n  class="a"\n  *ngFor="let i of xs"\n>y</div>',
        "/p/tags/badge.mx",
      ),
    );
    expectHint(error.message, "*ngFor", "class");
    expect({ line: error.line, column: error.column }).toEqual({
      line: 3,
      column: 2,
    });
  });

  it("leaves an unrelated tag-module error byte-for-byte", () => {
    const error = thrown(() =>
      compileTagModule("<div a=1 +b=2>x</div>", "/p/tags/badge.mx"),
    );
    expect(error.constructor.name).toBe("CompileError");
    expect(error.message).toContain(
      "^ Invalid left-hand side in assignment expression.",
    );
    expect(error.message).not.toContain("cannot follow");
  });
});

describe("TranslateError.file keeps core's contract", () => {
  // core.ts: `file` is set only for an error in a file other than the one
  // being compiled, so it stays undefined for this file's own error. A
  // consumer (the language server, the vite plugin) treats a set `file` as a
  // second file and would misattribute the diagnostic.
  it("is undefined for a whole-file compile, whatever the filename looks like", () => {
    for (const filename of ["t.mx", "/p/x.mx", "file:///p/x.mx"]) {
      const error = thrown(() =>
        compile('<div class="a" *ngIf="x">y</div>', filename),
      );
      expect(error.name).toBe("TranslateError");
      expect((error as { file?: string }).file).toBeUndefined();
    }
  });

  it("is undefined for a region error", () => {
    const error = thrown(() =>
      compileNgMx(
        componentFile('<div class="a" *ngIf="x">hi</div>'),
        "/p/x.component.ng.mx",
      ),
    );
    // The bridge re-raises as a SyntaxError; the hint it carries came from an
    // error with no `file`, which is why the message is the bare hint.
    expect(error.message).toMatch(/^`\*ngIf` cannot follow/);
  });
});

describe("a file with several failures", () => {
  // Marko reports several invalid values as one `CompileErrors` aggregate.
  const source =
    '<div>\n  <a class="a" *ngIf="x">1</a>\n  <b>$' +
    '{1 = 2}</b>\n  <i id="c" *ngFor="let i of xs">2</i>\n</div>';

  function members(run: () => unknown): Error[] {
    return (thrown(run) as unknown as { errors: Error[] }).errors;
  }

  it("hints each matching member, positioned per member", () => {
    const error = thrown(() => compile(source, "/p/x.mx"));
    expect(error.name).toBe("CompileErrors");
    const [first, unrelated, second] = (
      error as unknown as { errors: Positioned[] }
    ).errors;
    expectHint(first?.message ?? "", "*ngIf", "class");
    expect({ line: first?.line, column: first?.column }).toEqual({
      line: 2,
      column: 15,
    });
    expectHint(second?.message ?? "", "*ngFor", "id");
    expect({ line: second?.line, column: second?.column }).toEqual({
      line: 4,
      column: 12,
    });
    // The aggregate's own message carries both hints.
    expect(error.message).toContain("`*ngIf` cannot follow");
    expect(error.message).toContain("`*ngFor` cannot follow");
    expect(unrelated?.message).toContain(
      "^ Invalid left-hand side in assignment expression.",
    );
  });

  it("leaves the unrelated member byte-identical to Marko's", () => {
    const plain = members(() =>
      compileSource(source, "/p/x.mx", {} as never, {} as never),
    );
    const hinted = members(() => compile(source, "/p/x.mx"));
    expect(hinted).toHaveLength(3);
    expect((hinted[1] as Error).message).toBe((plain[1] as Error).message);
    expect((hinted[1] as Error).name).toBe("CompileError");
    const aggregate = thrown(() => compile(source, "/p/x.mx")).message;
    expect(aggregate).toContain(
      ((plain[1] as Error).stack ?? "").replace(/^CompileError: \n/, ""),
    );
  });

  it("hints two bad tags in one file with nothing else wrong", () => {
    const error = thrown(() =>
      compile(
        '<div class="a" *ngIf="x"><p class="b" *ngFor="let i of xs">y</p></div>',
        "/p/x.mx",
      ),
    );
    expect(
      error.message.match(/cannot follow another attribute/g),
    ).toHaveLength(2);
    expect(error.message).not.toContain("Invalid left-hand side");
  });
});

describe("the `*name=` must be in the failing value's own tag", () => {
  const unhinted = (source: string) =>
    thrown(() => compile(source, "t.mx")).message;

  it("does not hint a scriptlet failure before a valid first-position directive", () => {
    for (const source of [
      '$ 1 = 2\n<div *ngIf="x">y</div>',
      '$ x = 1 = 2\n<div *ngIf="x">y</div>',
      '$ 1 = 2\n<ng-container *transloco="let t">y</ng-container>',
    ]) {
      const message = unhinted(source);
      expect(message).toContain("Invalid left-hand side");
      expect(message).not.toContain("cannot follow");
    }
  });

  it("does not hint when another attribute sits between the failure and the `*`", () => {
    const message = unhinted('<div a=1 +b=2 c *ngIf="x">y</div>');
    expect(message).toContain("Invalid left-hand side");
    expect(message).not.toContain("cannot follow");
  });

  it("does not hint a `*name=` in a later tag", () => {
    const message = unhinted('<div a=1 +b=2>x</div>\n<p *ngIf="x">y</p>');
    expect(message).not.toContain("cannot follow");
  });
});
