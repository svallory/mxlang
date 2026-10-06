import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fixtures,
  mxTsc,
  plainTsc,
  repoRoot,
  run,
  SPAWN_TIMEOUT_MS,
} from "./test-support.ts";

const HOSTS = [
  { host: "preact", jsxImportSource: "preact" },
  { host: "react", jsxImportSource: "react" },
  { host: "hono", jsxImportSource: "hono/jsx" },
] as const;

// Keep twins under different basenames: TypeScript shadows a .tsx sibling
// with the same basename as a .mx file. Name positions are identical here.
const BAD = [
  ['<input maxLength="x"/>', '<input maxLength="x"/>', 8],
  ["<button foo=1/>", "<button foo={1}/>", 9],
  ['<div tabIndex="a"/>', '<div tabIndex="a"/>', 6],
  ["<div class=5/>", "<div CLASS={5}/>", 6],
  ["<button disabled=1/>", "<button disabled={1}/>", 9],
  ["<input value=true/>", "<input value={true}/>", 8],
  ["<div key={bad: true}/>", "<div key={{bad: true}}/>", 6],
  ["<input ref=1/>", "<input ref={1}/>", 8],
  ['<input maxlength="x"/>', '<input maxlength="x"/>', 8],
  ['<div tabindex="a"/>', '<div tabindex="a"/>', 6],
  ["<label for=5/>", "<label FOR={5}/>", 8],
] as const;

interface Diagnostic {
  line: number;
  column: number;
  code: string;
}

function diagnostics(output: string, file: string): Diagnostic[] {
  return [
    ...output.matchAll(
      new RegExp(`${file}\\((\\d+),(\\d+)\\): error (TS\\d+):`, "g"),
    ),
  ].map((match) => ({
    line: Number(match[1]),
    column: Number(match[2]),
    code: match[3] ?? "",
  }));
}

const roots: string[] = [];
const results = new Map<string, { mx: string; plain: string }>();

beforeAll(
  () => {
    for (const { host, jsxImportSource } of HOSTS) {
      const root = mkdtempSync(join(fixtures, `.intrinsic-props-${host}-`));
      roots.push(root);
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ mx: { host } }),
      );
      const options = {
        noEmit: true,
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        target: "esnext",
        lib: ["esnext", "dom"],
        jsx: "preserve",
        jsxImportSource,
        types: [],
        allowImportingTsExtensions: true,
        baseUrl: ".",
        paths: {
          ...Object.fromEntries(
            ["preact", "react", "hono"].map((name) => [
              `@mxlang/${name}`,
              [join(repoRoot, "packages", "hosts", name, "src", "index.ts")],
            ]),
          ),
          ...Object.fromEntries(
            ["preact", "react", "hono"].map((name) => [
              `@mxlang/${name}/runtime`,
              [join(repoRoot, "packages", "hosts", name, "src", "runtime.ts")],
            ]),
          ),
          "@mxlang/html": [
            join(repoRoot, "packages", "targets", "html", "src", "index.ts"),
          ],
        },
        ignoreDeprecations: "6.0",
      };
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: options,
          include: ["*.mx", "*.d.ts"],
        }),
      );
      writeFileSync(
        join(root, "plain.json"),
        JSON.stringify({
          compilerOptions: options,
          include: ["*.tsx", "*.d.ts"],
        }),
      );
      const className = host === "react" ? "className" : "class";
      const forName = host === "react" ? "htmlFor" : "for";
      for (const [index, [mx, plain]] of BAD.entries()) {
        writeFileSync(join(root, `Bad${index}.mx`), `${mx}\n`);
        writeFileSync(
          join(root, `Twin${index}.tsx`),
          `${plain.replace("CLASS", className).replace("FOR", forName)};\nexport {};\n`,
        );
      }
      // React and Preact have no catch-all for custom tags: declare it in
      // both projects as a consumer would; arbitrary custom props stay legal.
      if (host !== "hono") {
        writeFileSync(
          join(root, "custom.d.ts"),
          `import "${host}"; declare module "${host}" { namespace JSX { interface IntrinsicElements { "my-el": Record<string, unknown>; } } }\n`,
        );
      }
      const validMx = [
        '<div class="a" aria-label="label" data-id=1/>',
        ...(host === "react" ? ['<div className="a"/>'] : []),
        '<div style={color: "red", top: 0}/>',
        `<label for="field"/>`,
        ...(host === "react" ? ['<label htmlFor="field"/>'] : []),
        '<input disabled value="a"/>',
        '<input="a"/>',
        '<div ...{title: "ok", tabIndex: 0}/>',
        "<my-el foo=1 arbitrary={a: 1}/>",
        '<svg viewBox="0 0 10 10"><path stroke-width=2 d="M0 0"/><clipPath id="clip"/></svg>',
        "<div.card class={active: true}/>",
        '<div style={...{color: "red"}, top: 0}/>',
        '<input key="field" ref=((el: HTMLInputElement | null) => { void el; })/>',
      ].join("\n");
      const validPlain = [
        `<div ${className}="a" aria-label="label" data-id={1}/>;`,
        ...(host === "react" ? ['<div className="a"/>;'] : []),
        '<div style={{color: "red", top: 0}}/>;',
        `<label ${forName}="field"/>;`,
        ...(host === "react" ? ['<label htmlFor="field"/>;'] : []),
        '<input disabled value="a"/>;',
        '<input value="a"/>;',
        '<div {...{title: "ok", tabIndex: 0}}/>;',
        "<my-el foo={1} arbitrary={{a: 1}}/>;",
        '<svg viewBox="0 0 10 10"><path stroke-width={2} d="M0 0"/><clipPath id="clip"/></svg>;',
        `<div ${className}="card active"/>;`,
        '<div style={{...{color: "red"}, top: 0}}/>;',
        '<input key="field" ref={(el: HTMLInputElement | null) => { void el; }}/>;',
      ].join("\n");
      writeFileSync(join(root, "Valid.mx"), validMx);
      writeFileSync(join(root, "ValidTwin.tsx"), `${validPlain}\nexport {};\n`);
      writeFileSync(join(root, "Style.mx"), '<div style="color:red"/>\n');
      writeFileSync(
        join(root, "StyleTwin.tsx"),
        '<div style="color:red"/>;\nexport {};\n',
      );
      const mx = run(mxTsc, ["--pretty", "false", "-p", root]);
      const plain = run(plainTsc, [
        "--pretty",
        "false",
        "-p",
        join(root, "plain.json"),
      ]);
      expect(plain.status).not.toBe(0);
      results.set(host, { mx: mx.output, plain: plain.output });
    }
  },
  SPAWN_TIMEOUT_MS * HOSTS.length * 2,
);

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function resultFor(host: string) {
  const result = results.get(host);
  if (!result) throw new Error(`missing compiler result for ${host}`);
  return result;
}

describe.each(HOSTS)(
  "native prop diagnostics on $host (decision 140 (b))",
  ({ host }) => {
    it.each(
      BAD.map((entry, index) => ({
        source: entry[0],
        column: entry[2],
        index,
      })),
    )(
      "reports $source at the authored name with plain TSX's code",
      ({ index, column }) => {
        const { mx, plain } = resultFor(host);
        const twin = diagnostics(plain, `Twin${index}\\.tsx`);
        // Lead ruling: decision 140 follows each host's own JSX types.
        // Hono's index signature accepts camelCase maxLength/tabIndex, foo,
        // key and ref. Preact also declares key:any. Do not invent errors.
        const accepted =
          (host === "hono" && [0, 1, 2, 6, 7].includes(index)) ||
          (host === "preact" && index === 6);
        expect(twin).toEqual(
          accepted ? [] : [{ line: 1, column, code: "TS2322" }],
        );
        expect(diagnostics(mx, `Bad${index}\\.mx`)).toEqual(twin);
      },
    );

    it("keeps the valid prop matrix clean, as plain TSX does", () => {
      const { mx, plain } = resultFor(host);
      expect(diagnostics(plain, "ValidTwin\\.tsx")).toEqual([]);
      expect(diagnostics(mx, "Valid\\.mx")).toEqual([]);
      // Do not hide unrelated compiler errors behind the per-file assertions.
      expect(
        mx
          .split("\n")
          .filter(
            (line) =>
              line.includes(": error") && !/Bad\d+\.mx|Style\.mx/.test(line),
          ),
      ).toEqual([]);
    });

    it("checks a static style string by the host's own rules", () => {
      const { mx, plain } = resultFor(host);
      const expected =
        host === "react" ? [{ line: 1, column: 6, code: "TS2559" }] : [];
      expect(diagnostics(plain, "StyleTwin\\.tsx")).toEqual(expected);
      expect(diagnostics(mx, "Style\\.mx")).toEqual(expected);
    });
  },
);
