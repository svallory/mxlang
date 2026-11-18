/**
 * A `.preact.mx` region reaches core only through `parseFragment`, from the
 * shared JSX region entry (`compileJsxRegion`, which `.react.mx` uses too).
 * It must hand core the target lookup it compiles under, so routing refuses a dialect that claims `.preact.mx`
 * instead of accepting the claim and dropping the file (review 492 r1, B1).
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
import { TranslateError } from "@mxlang/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compilePreactMx, compilePreactRegion } from "./index.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-preact-host-claim-")));
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

function caught(run: () => unknown) {
  let error: unknown;
  try {
    run();
  } catch (thrown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(TranslateError);
  const { file, line, column, message } = error as TranslateError;
  return { file, line, column, message };
}

describe("`compilePreactRegion` hands routing its target's host file kinds", () => {
  // The dialect package's `package.json`: `.preact.mx` is the second entry of
  // `mx.dialect.extensions`, on line 7.
  it("a dialect claiming `.preact.mx` is an error at its manifest", () => {
    const packageFile = claimingProject([".tst", ".preact.mx"]);
    expect(
      caught(() =>
        compilePreactRegion("<div/>", {
          filename: join(dir, "page.preact.mx"),
        }),
      ),
    ).toEqual({
      file: packageFile,
      line: 7,
      column: 6,
      message:
        "`mx.dialect.extensions` cannot claim `.preact.mx`: `.preact.mx` is a host's file kind, which MX owns; a dialect claims its own extensions (`.mydsl.mx`)",
    });
  });
});

/** A dialect module stating the `none` tag rules. */
const NONE_DIALECT = 'export default { table: {}, tagRules: "none" };';

/** The compiled code, or the refusal's message and code. */
function outcome(source: string, filename: string) {
  try {
    return { code: compilePreactMx(source, filename).code };
  } catch (thrown) {
    const { message, diagnosticCode } = thrown as TranslateError;
    return { message, diagnosticCode };
  }
}

/**
 * Under the `none` tag rules every name but the reserved ones is an ordinary
 * tag, so core ignores the host's rows for the others (`statefulErrors`,
 * which React and Hono share): such a tag compiles as the ordinary `<zzz>`
 * does. A row for a reserved name still applies.
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

  it("the reserved `<else>` keeps its row", () => {
    claimingProject([".tst"], NONE_DIALECT);
    expect(outcome("<else/>", join(dir, "page.tst"))).toEqual({
      message: "`<else>` must follow an `<if>`",
      diagnosticCode: "MX_UNSUPPORTED_CONSTRUCT",
    });
  });
});

/**
 * The region entry (`compileJsxRegion`, which React and Hono share) lowers a
 * dialect file without setting the tag rules; lowering adopts the dialect's,
 * so the host's `lifecycle` row does not apply there either.
 */
describe("`compilePreactRegion` under the `none` tag rules", () => {
  /** The region's code, or the refusal's message and code. */
  function regionOutcome(source: string, filename: string) {
    try {
      return { code: compilePreactRegion(source, { filename }).code };
    } catch (thrown) {
      const { message, diagnosticCode } = thrown as TranslateError;
      return { message, diagnosticCode };
    }
  }

  it("`<lifecycle a=1>x</lifecycle>` compiles as the ordinary `<zzz>` control", () => {
    claimingProject([".tst"], NONE_DIALECT);
    const page = join(dir, "page.tst");
    const control = JSON.parse(
      JSON.stringify(regionOutcome("<zzz a=1>x</zzz>", page)).replaceAll(
        "zzz",
        "lifecycle",
      ),
    );
    expect(regionOutcome("<lifecycle a=1>x</lifecycle>", page)).toEqual(
      control,
    );
  });
});
