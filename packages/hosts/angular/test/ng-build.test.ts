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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

describe("rewriteGeneratedNames and terminal output", () => {
  const names = { "src/x.html": { __mxConst_a: "a" } };

  it("rewrites a name that ng build colours", () => {
    expect(
      rewriteGeneratedNames("@let \x1b[1m__mxConst_a\x1b[0m is unused", names),
    ).toBe("@let \x1b[1ma\x1b[0m is unused");
  });

  it("does not rescan a replacement", () => {
    expect(
      rewriteGeneratedNames("__mxConst_a", {
        f: { __mxConst_a: "__mxConst_b", __mxConst_b: "z" },
      }),
    ).toBe("__mxConst_b");
  });
});

describe("mx-angular ng-build", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-ng-build-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeAll(() => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
    );
    // Two bodies declaring `a` rename it; a destructuring const's holder is
    // printed as the pattern the author wrote.
    writeFileSync(
      join(dir, "src/x.mx"),
      "<div><const/a=1/></div><div><const/a=2/></div>",
    );
    writeFileSync(
      join(dir, "src/pattern.mx"),
      "<div><const/{ p, q }=obj/>${p}${q}</div>",
    );
    writeFileSync(
      join(dir, "src/y.component.ng.mx"),
      "declare function Component(options: object): ClassDecorator;\n@Component({ template: <section><div><const/b=1/></div><div><const/b=2/></div></section> })\nexport class YComponent {}\n",
    );
    const bin = join(dir, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    // Writes in two chunks, the second mid-line, as a build does.
    const script =
      "process.stdout.write('args: ' + process.argv.slice(2).join(' ') + '\\n');\n" +
      "process.stderr.write('NG8112: @let __mxCon');\n" +
      "setTimeout(() => { process.stderr.write('st_a1 is declared\\n'); process.exit(3); }, 20);\n";
    writeFileSync(join(bin, "ng"), `#!/usr/bin/env node\n${script}`);
    chmodSync(join(bin, "ng"), 0o755);
    writeFileSync(join(bin, "ng.cmd"), `@node "%~dp0\\ng" %*\r\n`);
  });

  it("records the authored name of each renamed const per output file", () => {
    const result = build(dir);
    expect(result.errors).toEqual([]);
    expect(result.authoredNames[join(dir, "src/x.html")]).toEqual({
      __mxConst_a: "a",
      __mxConst_a1: "a",
    });
  });

  it("records a .ng.mx module's renamed names", () => {
    const result = build(dir);
    const names = result.authoredNames[join(dir, "src/y.component.ts")];
    expect(Object.values(names ?? {})).toEqual(["b", "b"]);
  });

  it("names a destructuring const's holder as the pattern the author wrote", () => {
    const result = build(dir);
    expect(
      Object.values(result.authoredNames[join(dir, "src/pattern.html")] ?? {}),
    ).toContain("{ p, q }");
  });

  it("refuses a positional argument before --", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runCli(["ng-build", "--project", dir, "oops"])).toBe(1);
      expect(err.mock.calls.join("")).toContain("unexpected argument: oops");
    } finally {
      err.mockRestore();
    }
  });

  it("runs the project's ng and prints its diagnostics with authored names", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = await runCli([
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
      // The name was split across two writes; it is still one name.
      expect(err.mock.calls.join("")).toBe("NG8112: @let a is declared\n");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
