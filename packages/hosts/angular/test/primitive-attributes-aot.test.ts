import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "../../../tooling/angular-checker/src/index.ts";
import { emit } from "./helpers.ts";

describe("strict AOT (ngtsc, strictTemplates) on the emitted bindings", () => {
  const checkerProject = resolve(
    import.meta.dirname,
    "../../../tooling/angular-checker",
  );
  let serial = 0;
  function check(template: string, body: string): string[] {
    const checker = createAngularChecker({ projectDir: checkerProject });
    const diagnostics = checker.check(
      join(checkerProject, `primitive-${serial++}.component.ts`),
      `import { Component } from "@angular/core";
@Component({ selector: "mx-probe", standalone: true, template: \`${template}\` })
export class Probe {${body}}
`,
    );
    checker.dispose();
    return diagnostics.map((d) => `${d.code} ${d.message.split("\n")[0]}`);
  }

  it("accepts the generic attribute on a div (no NG8002 as with [disabled])", () => {
    const code = emit("<div disabled=flag title=name/>");
    expect(check(code, "flag = true as boolean | null; name = 'n';")).toEqual(
      [],
    );
  });

  it("reports a type error in the authored expression once", () => {
    const code = emit("<div title=missing.nope/>");
    const diagnostics = check(code, "missing = { yes: 1 };");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("nope");
  });
});
