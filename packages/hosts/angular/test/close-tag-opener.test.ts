import { describe, expect, it } from "vitest";
import { compileNgMx } from "../src/ng-mx.ts";

/** The a10 corpus shape: `<section>` and `<p>` unclosed, `</div>` mismatched. */
const SOURCE = `import { Component } from "@angular/core";

@Component({
  selector: "app-x",
  template: <div>
    <section>
      <p>x</p>
  </div>,
})
export class XComponent {}
`;

describe(".ng.mx: a missing close tag names the opener's position", () => {
  it("keeps the error at the closer and adds the unclosed opener", () => {
    let message = "";
    try {
      compileNgMx(SOURCE, "/fixtures/x.component.ng.mx");
    } catch (error) {
      message = (error as Error).message;
    }
    // `</div>` is on line 8; `<section>` is the innermost unclosed opener, at
    // line 6 column 5 (1-based).
    expect(message).toContain(
      'The closing "div" tag does not match the corresponding opening "section" tag at 6:5',
    );
  });

  it("positions a fragment region's `<>` opener at its real column", () => {
    const source = `import { Component } from "@angular/core";

@Component({
  selector: "app-x",
  template: <>
    hello
  </div>,
})
export class XComponent {}
`;
    let message = "";
    try {
      compileNgMx(source, "/fixtures/x.component.ng.mx");
    } catch (error) {
      message = (error as Error).message;
    }
    // `  template: <>`: the `<>` is at line 5, column 13 (1-based).
    expect(message).toContain('opening "<>" tag at 5:13');
  });
});
