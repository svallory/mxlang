// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { build } from "../src/build.ts";
import { runCli } from "../src/cli.ts";
import { rewriteGeneratedNames } from "../src/ng-build.ts";

describe("rewriteGeneratedNames", () => {
  const names = {
    "src/x.html": { __mxConst_a: "a", __mxConst_a1: "a", __mxDefine_D: "D" },
  };

  it.each([
    [
      "an unused @let",
      "NG8112: @let __mxConst_a is declared but its value is never read",
      "NG8112: @let a is declared but its value is never read",
    ],
    [
      "a two-way binding on a @let",
      "Cannot use non-signal @let declaration '__mxConst_a1' in a two-way binding",
      "Cannot use non-signal @let declaration 'a' in a two-way binding",
    ],
    [
      "every occurrence, a define among them",
      "__mxConst_a and __mxConst_a, #__mxDefine_D",
      "a and a, #D",
    ],
    [
      "a longer name that merely starts with a generated one",
      "__mxConst_ab __mxConst_a_ x__mxConst_a",
      "__mxConst_ab __mxConst_a_ x__mxConst_a",
    ],
    [
      "text with none",
      "NG8002: Can't bind to 'x'",
      "NG8002: Can't bind to 'x'",
    ],
  ])("%s", (_label, text, expected) => {
    expect(rewriteGeneratedNames(text, names)).toBe(expected);
  });

  it("leaves a name that two files give different authored names as printed", () => {
    expect(
      rewriteGeneratedNames("__mxConst_a", {
        "one.html": { __mxConst_a: "a" },
        "two.html": { __mxConst_a: "b" },
      }),
    ).toBe("__mxConst_a");
  });
});

describe("mx-angular ng-build", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-ng-build-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const PAGE = "<div><const/a=1/></div><div><const/a=2/></div>";

  it("records the authored name of each renamed const per output file", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
    );
    writeFileSync(join(dir, "src/x.mx"), PAGE);
    const result = build(dir);
    expect(result.ok).toBe(true);
    expect(result.authoredNames).toEqual({
      [join(dir, "src/x.html")]: { __mxConst_a: "a", __mxConst_a1: "a" },
    });
  });

  it("runs the project's ng and prints its diagnostics with authored names", () => {
    const bin = join(dir, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    const ng = join(bin, "ng");
    writeFileSync(
      ng,
      "#!/bin/sh\necho \"args: $*\"\necho 'NG8112: @let __mxConst_a1 is declared' >&2\nexit 3\n",
    );
    chmodSync(ng, 0o755);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = runCli([
        "ng-build",
        "--project",
        dir,
        "--",
        "--configuration",
        "production",
      ]);
      expect(code).toBe(3);
      expect(out.mock.calls.join("")).toBe(
        "args: build --configuration production\n",
      );
      expect(err.mock.calls.join("")).toBe("NG8112: @let a is declared\n");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
