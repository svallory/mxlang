import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "../../../tooling/angular-checker/src/index.ts";
import { assertAngularParses, emit } from "./helpers.ts";

const checkerProject = resolve(
  import.meta.dirname,
  "../../../tooling/angular-checker",
);

describe("conditional attribute-tag projection", () => {
  it("passes Angular's parser and ngtsc checker", () => {
    const template = emit(
      "<Card><if=primary><@header>A</@header></if><else if=secondary><@header>B</@header></else><else><@header>C</@header></else></Card>",
    );
    assertAngularParses(template);

    const source = `import { Component } from "@angular/core";
@Component({
  selector: "mx-card",
  standalone: true,
  template: '<ng-content select="[header]"></ng-content>',
})
class Card {}

@Component({
  selector: "mx-probe",
  standalone: true,
  imports: [Card],
  template: \`${template}\`,
})
export class Probe {
  primary = false;
  secondary = true;
}
`;
    const checker = createAngularChecker({ projectDir: checkerProject });
    const diagnostics = checker.check(
      join(checkerProject, "conditional-projection.component.ts"),
      source,
    );
    checker.dispose();
    expect(diagnostics).toEqual([]);
  });
});
