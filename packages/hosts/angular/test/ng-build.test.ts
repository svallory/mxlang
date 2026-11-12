// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "../src/build.ts";
import { runCli } from "../src/cli.ts";
import { forwardLines, rewriterFor } from "../src/ng-build.ts";

describe("rewriterFor", () => {
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
    expect(rewriterFor(names)(text)).toBe(expected);
  });

  it("leaves a name that two files give different authored names as printed", () => {
    expect(
      rewriterFor({
        "one.html": { __mxConst_a: "a" },
        "two.html": { __mxConst_a: "b" },
      })("__mxConst_a"),
    ).toBe("__mxConst_a");
  });
});

describe("rewriterFor and terminal output", () => {
  const names = { "src/x.html": { __mxConst_a: "a" } };

  it("rewrites a name that ng build colours", () => {
    expect(rewriterFor(names)("@let \x1b[1m__mxConst_a\x1b[0m is unused")).toBe(
      "@let \x1b[1ma\x1b[0m is unused",
    );
  });

  it("does not rescan a replacement", () => {
    expect(
      rewriterFor({
        f: { __mxConst_a: "__mxConst_b", __mxConst_b: "z" },
      })("__mxConst_a"),
    ).toBe("__mxConst_b");
  });
});

/** Feeds `chunks` through forwardLines and returns what the sink received. */
async function forward(
  chunks: string[],
  names: Parameters<typeof rewriterFor>[0],
  end: "end" | "error" = "end",
): Promise<string> {
  const source = new PassThrough();
  const sink = new PassThrough();
  const received: string[] = [];
  sink.on("data", (d) => received.push(String(d)));
  const done = forwardLines(source, sink, rewriterFor(names));
  for (const chunk of chunks) source.write(chunk);
  if (end === "end") source.end();
  else source.destroy(new Error("boom"));
  await done;
  return received.join("");
}

describe("forwardLines", () => {
  const names = { "src/x.html": { __mxConst_a1: "a" } };

  it("rewrites a name that arrives split across two reads", async () => {
    expect(
      await forward(["NG8112: @let __mxCon", "st_a1 is declared\n"], names),
    ).toBe("NG8112: @let a is declared\n");
  });

  it("flushes an unterminated last line at the end", async () => {
    expect(await forward(["@let __mxConst_a1"], names)).toBe("@let a");
  });

  it("settles when the stream errors, keeping what it had", async () => {
    expect(await forward(["__mxConst_a1 x\n"], names, "error")).toBe("a x\n");
  });

  it("realigns esbuild's underline under a shortened source line", async () => {
    expect(
      await forward(
        [
          "    src/x.html:1:5:\n      1 │ @let __mxConst_a1 = 2;\n        ╵      ~~~~~~~~~~~~\n",
        ],
        names,
      ),
    ).toBe("    src/x.html:1:5:\n      1 │ @let a = 2;\n        ╵      ~\n");
  });

  it("realigns a plain underline (tsc's frame) and what is right of the name", async () => {
    expect(
      await forward(
        [
          "1 @let __mxConst_a1 = __mxConst_a1;\n       ^~~~~~~~~~~~~~~~~~~~~~~~\n",
        ],
        {
          f: { __mxConst_a1: "a" },
        },
      ),
    ).toBe("1 @let a = a;\n       ^~~~~\n");
  });

  it("leaves an underline-looking line after a message line alone", async () => {
    const rule = "~".repeat(30);
    expect(
      await forward([`Hint: __mxConst_a1 is unused\n${rule}\n`], names),
    ).toBe(`Hint: a is unused\n${rule}\n`);
  });

  it("prints a held line when the stream goes idle, without waiting for another", async () => {
    const source = new PassThrough();
    const sink = new PassThrough();
    const first = new Promise<string>((resolve) =>
      sink.once("data", (d) => resolve(String(d))),
    );
    void forwardLines(source, sink, rewriterFor(names));
    source.write("NG8112: @let __mxConst_a1 is declared\n");
    expect(await first).toBe("NG8112: @let a is declared\n");
    source.end();
  });

  it("leaves a line that is not an underline alone", async () => {
    expect(await forward(["__mxConst_a1\n  ~ not caret? x\n"], names)).toBe(
      "a\n  ~ not caret? x\n",
    );
  });
});

describe("mx-angular ng-build", () => {
  // A space in the path: nothing may re-split it.
  const root = mkdtempSync(join(tmpdir(), "mx-ng-build-"));
  const dir = join(root, "my app");
  let built: ReturnType<typeof build>;
  afterAll(() => rmSync(root, { recursive: true, force: true }));

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
      join(dir, "src/pattern2.mx"),
      "<div><const/{ r, s }=obj/>${r}${s}</div>",
    );
    writeFileSync(
      join(dir, "src/y.component.ng.mx"),
      "declare function Component(options: object): ClassDecorator;\n@Component({ template: <section><div><const/b=1/></div><div><const/b=2/></div></section> })\nexport class YComponent {}\n",
    );
    // The project's own `ng`: `@angular/cli/bin/ng.js`, run under this node.
    const cli = join(dir, "node_modules/@angular/cli");
    mkdirSync(join(cli, "bin"), { recursive: true });
    writeFileSync(
      join(cli, "package.json"),
      JSON.stringify({ name: "@angular/cli", version: "0.0.0" }),
    );
    writeFileSync(
      join(cli, "bin/ng.js"),
      "process.stdout.write('args: ' + JSON.stringify(process.argv.slice(2)) + '\\n');\n" +
        "process.stderr.write('NG8112: @let __mxConst_a1 is declared\\n');\n" +
        "process.exit(3);\n",
    );
    built = build(dir);
  });

  it("records the authored name of each renamed const per output file", () => {
    expect(built.errors).toEqual([]);
    expect(built.authoredNames[join(dir, "src/x.html")]).toEqual({
      __mxConst_a: "a",
      __mxConst_a1: "a",
    });
  });

  it("records a .ng.mx module's renamed names", () => {
    const names = built.authoredNames[join(dir, "src/y.component.ts")];
    expect(Object.values(names ?? {})).toEqual(["b", "b"]);
  });

  // The holder's name is per file and means a different pattern in each, so
  // no merged map could rewrite it: it is not listed.
  it("does not list a destructuring const's holder", () => {
    expect(built.authoredNames[join(dir, "src/pattern.html")]).toBeUndefined();
    expect(built.authoredNames[join(dir, "src/pattern2.html")]).toBeUndefined();
  });

  // Not a process smoke: `build` refuses before anything runs.
  it("refuses a positional argument", async () => {
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
        "two words & more",
      ]);
      expect(code).toBe(3);
      expect(out.mock.calls.join("")).toBe(
        'args: ["build","--configuration","two words & more"]\n',
      );
      expect(err.mock.calls.join("")).toBe("NG8112: @let a is declared\n");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
