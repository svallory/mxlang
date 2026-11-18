/**
 * A `.ng.mx` region reaches core only through `parseFragment`, from
 * `compileNgMx`. It must hand core the target lookup it compiles under, so
 * routing refuses a dialect that claims `.ng.mx` instead of accepting the
 * claim and dropping the file (review 492 r1, B1).
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile, compileNgMx, type TranslateError } from "./index.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-angular-host-claim-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A project depending on a dialect package whose manifest names `extensions`
 * and whose module is `module`, and the package's `package.json`.
 */
function claimingProject(
  extensions: readonly string[],
  module = "export default { table: {} };",
): string {
  const packageDir = join(dir, "node_modules", "test-dialect");
  mkdirSync(packageDir, { recursive: true });
  const packageFile = join(packageDir, "package.json");
  writeFileSync(
    packageFile,
    `${JSON.stringify(
      {
        name: "test-dialect",
        mx: {
          dialect: {
            id: "test",
            name: "Test",
            extensions,
            module: "./index.mjs",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(packageDir, "index.mjs"), `${module}\n`);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      { name: "app", devDependencies: { "test-dialect": "0.0.0" } },
      null,
      2,
    )}\n`,
  );
  return packageFile;
}

const MODULE = `import { Component } from "@angular/core";

@Component({ selector: "app-page", template: <div/> })
export class Page {}
`;

describe("`compileNgMx` hands routing its target's host file kinds", () => {
  // The parser bridge re-raises a region's error as a positioned
  // `SyntaxError` in the `.ng.mx` module (`tsx-bridge` `mx/bridge.ts`), which
  // keeps the message but not `TranslateError.file`: the text is the pin.
  it("a dialect claiming `.ng.mx` is an error naming the claim", () => {
    claimingProject([".tst", ".ng.mx"]);
    let message: string | undefined;
    try {
      compileNgMx(MODULE, join(dir, "page.ng.mx"));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      "`mx.dialect.extensions` cannot claim `.ng.mx`: `.ng.mx` is a host's file kind, which MX owns; a dialect claims its own extensions (`.mydsl.mx`)",
    );
  });
});

/** A dialect module stating the `none` tag rules. */
const NONE_DIALECT = 'export default { table: {}, tagRules: "none" };';

/** The compiled code, or the refusal's message and code. */
function outcome(source: string, filename: string) {
  try {
    return { code: compile(source, filename).code };
  } catch (thrown) {
    const { message, diagnosticCode } = thrown as TranslateError;
    return { message, diagnosticCode };
  }
}

/**
 * Under the `none` tag rules every name but the reserved ones is an ordinary
 * tag, so core ignores the host's rows for the others (`STATEFUL_ERRORS`):
 * such a tag compiles as the ordinary `<zzz>` does. A row for a reserved name
 * still applies.
 */
describe("the `none` tag rules: host rows for non-reserved names do not apply", () => {
  it.each(["<lifecycle a=1>x</lifecycle>", "<id a=1/>", "<await>x</await>"])(
    "`%s` compiles as the ordinary `<zzz>` control",
    (source) => {
      claimingProject([".tst"], NONE_DIALECT);
      const page = join(dir, "page.tst");
      const name = /^<([a-z]+)/.exec(source)?.[1] ?? "";
      const control = JSON.parse(
        JSON.stringify(
          outcome(source.replaceAll(name, "zzz"), page),
        ).replaceAll("zzz", name),
      );
      expect(outcome(source, page)).toEqual(control);
    },
  );

  it("the reserved `<try>` keeps its row", () => {
    claimingProject([".tst"], NONE_DIALECT);
    expect(outcome("<try>x</try>", join(dir, "page.tst"))).toEqual({
      message:
        "`<try>` is not supported in embedded Test on Angular. Handle the error in the component and render the fallback with `<if>`; Angular has no template-level error boundary, and `@defer`'s `@error` block only covers a failed lazy chunk load, not a render error.",
      diagnosticCode: "MX_UNSUPPORTED_CONSTRUCT",
    });
  });
});

/**
 * `compileNgMx` lowers each region of a dialect file without setting the tag
 * rules; lowering adopts the dialect's, so the host's `lifecycle` row does not
 * apply there either.
 */
describe("`compileNgMx` under the `none` tag rules", () => {
  /** A module whose one region is `template`. */
  const moduleWith = (template: string) =>
    `import { Component } from "@angular/core";

@Component({ selector: "app-page", template: ${template} })
export class Page {}
`;

  /** The module's code, or the refusal's message and code. */
  function moduleOutcome(template: string, filename: string) {
    try {
      return { code: compileNgMx(moduleWith(template), filename).code };
    } catch (thrown) {
      const { message, diagnosticCode } = thrown as TranslateError;
      return { message, diagnosticCode };
    }
  }

  it("`<lifecycle a=1>x</lifecycle>` compiles as the ordinary `<zzz>` control", () => {
    claimingProject([".tst"], NONE_DIALECT);
    const page = join(dir, "page.tst");
    const control = JSON.parse(
      JSON.stringify(moduleOutcome("<zzz a=1>x</zzz>", page)).replaceAll(
        "zzz",
        "lifecycle",
      ),
    );
    expect(moduleOutcome("<lifecycle a=1>x</lifecycle>", page)).toEqual(
      control,
    );
  });

  // The region walker finds the region's end with no void tags, as core
  // lowers it, so `<input>` takes children and a closing tag here.
  it.each(["<input><child/></input>", "<input></input>"])(
    "`%s` compiles as the ordinary `<zzz>` control",
    (template) => {
      claimingProject([".tst"], NONE_DIALECT);
      const page = join(dir, "page.tst");
      const control = moduleOutcome(template.replaceAll("input", "zzz"), page);
      expect(control).toHaveProperty("code");
      expect(moduleOutcome(template, page)).toEqual(
        JSON.parse(JSON.stringify(control).replaceAll("zzz", "input")),
      );
    },
  );
});
