// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX source
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileNgMx } from "../../../hosts/angular/src/ng-mx.ts";
import {
  mxAngular,
  mxTsc,
  repoRoot,
  run,
  SPAWN_TIMEOUT_MS,
} from "./test-support.ts";

const SWITCH_MESSAGE =
  "Unable to find entry point for custom tag `<switch>`. MX has no switch; use `<if=…>` / `<else if=…>`.";
const KEYED_MESSAGE =
  "The `by=` arrow parameter `y` must match the `<for>` row `x`; rename it to keep the key expression: `by=(x => x.id)`. If the row has no `id` field, `by=identity` is a different strategy that tracks the row itself.";
const IDENTITY_MESSAGE =
  "The `by=` arrow parameter `y` must match the `<for>` row `x`; rename the parameter `y` to `x` to keep the key expression. Use `by=identity` to track the row itself.";
const PLAIN_MESSAGE =
  "The `by=` arrow parameter `y` must match the `<for>` row `x`; rename the parameter `y` to `x` to keep the key expression.";
interface HintCase {
  name: string;
  template: string;
  body?: string;
  needle: string;
  code: string;
  message: string;
  fixed: string | null;
  build?: boolean;
  track?: string;
}
const cases: HintCase[] = [
  {
    name: "a16 switch/case",
    template: '<div><switch=title><case="a"><p>a</p></case></switch></div>',
    needle: "switch",
    code: "80001",
    message: SWITCH_MESSAGE,
    fixed:
      '<div><if=(title === "a")><p>a</p></if><else if=(title === "b")><p>b</p></else></div>',
    build: true,
  },
  {
    name: "a16 switch with no value",
    template:
      '<div><switch><case="a"><p>a</p></case><case="b">b</case></switch></div>',
    needle: "switch",
    code: "80001",
    message: SWITCH_MESSAGE,
    fixed:
      '<div><if=(title === "a")><p>a</p></if><else if=(title === "b")>b</else></div>',
    build: true,
  },
  {
    name: "a16 switch with a named value attribute",
    template: '<div><switch value=title><case="a">a</case></switch></div>',
    needle: "switch",
    code: "80001",
    message: SWITCH_MESSAGE,
    fixed: '<div><if=(title === "a")>a</if></div>',
    build: true,
  },
  {
    name: "a12 numeric handler",
    template: "<div><button on-click=two>x</button></div>",
    needle: "two>x",
    code: "2345",
    message:
      "Handler `two` expects `(number, number)`; MX passes `(event, element)`. Use `on-click=(() => two(1, 2))`.",
    fixed: "<div><button on-click=(() => two(1, 2))>x</button></div>",
  },
  {
    name: "a14 arrow parameter (numeric corpus row)",
    template: "<ul><for|x| of=items by=(y=>y.id)><li>${x}</li></for></ul>",
    needle: "y=>",
    code: "80001",
    message: KEYED_MESSAGE,
    // The corpus row is numeric, so the renamed key would not type-check;
    // the message's fallback — identity, a different strategy — compiles
    // clean and tracks the row.
    fixed: "<ul><for|x| of=items by=identity><li>${x}</li></for></ul>",
    build: true,
    track: "x",
  },
  {
    name: "a14 keyed object row",
    template: "<ul><for|x| of=items by=(y=>y.id)><li>${x}</li></for></ul>",
    body: "items = [{ id: 1 }, { id: 2 }];",
    needle: "y=>",
    code: "80001",
    message: KEYED_MESSAGE,
    // The faithful fix: rename the parameter, keeping the key expression.
    fixed: "<ul><for|x| of=items by=(x=>x.id)><li>${x}</li></for></ul>",
    build: true,
    track: "x.id",
  },
  {
    name: "a14 arrow tracking the parameter itself",
    template: "<ul><for|x| of=items by=(y=>y)><li>${x}</li></for></ul>",
    body: "items = [{ id: 1 }, { id: 2 }];",
    needle: "y=>",
    code: "80001",
    message: IDENTITY_MESSAGE,
    fixed: "<ul><for|x| of=items by=identity><li>${x}</li></for></ul>",
    build: true,
    track: "x",
  },
  {
    name: "a26 bound input",
    template: "<div><app-child lable=title></app-child></div>",
    needle: "lable=",
    code: "-998002",
    message:
      "Can't bind to 'lable' since it isn't a known property of 'app-child'. Did you mean 'label'?",
    fixed: "<div><app-child label=title></app-child></div>",
  },
  ...[
    ["for", '<for|x| of=items by="id"><case="a"><text>x</text></case></for>'],
    ["if", '<if=title><case="a"><text>x</text></case></if>'],
  ].map(
    ([label, children]): HintCase => ({
      name: `a16 SVG switch with cases nested under ${label}`,
      template: `<svg><switch>${children}</switch></svg>`,
      body: "items = [{ id: 1 }];",
      needle: "switch",
      code: "80001",
      message: SWITCH_MESSAGE,
      fixed: "<svg><if=title><text>x</text></if></svg>",
      build: true,
    }),
  ),
  ...[
    ["y.id", "x.id"],
    ["y.a.b", "x.a.b"],
    ["y?.id", "x?.id"],
    ["y.a?.b", "x.a?.b"],
    ['y["k"]', 'x["k"]'],
    ["y.y", "x.y"],
  ].map(
    ([body, renamed]): HintCase => ({
      name: `a14 conservative member-chain fix ${body}`,
      template: `<for|x| of=items by=(y => ${body})><p>row</p></for>`,
      body: "items = [{ id: 1, a: { b: 2 }, k: 3, y: 4 }];",
      needle: "y =>",
      code: "80001",
      message: `keep the key expression: \`by=(x => ${renamed})\``,
      fixed: `<for|x| of=items by=(x => ${renamed})><p>row</p></for>`,
      build: true,
      track: renamed,
    }),
  ),
  ...[
    "({y})",
    "f(y => y)",
    "y?.y",
    "y[y.id]",
    "y.id + 1",
    "{ return y.id; }",
  ].map(
    (body): HintCase => ({
      name: `a14 instruction only for ${body}`,
      template: `<for|x| of=items by=(y => ${body})><p>row</p></for>`,
      needle: "y =>",
      code: "80001",
      message: PLAIN_MESSAGE,
      fixed: null,
      build: true,
    }),
  ),
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: diagnostics may carry ANSI colour
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
function moduleFor(template: string, body?: string): string {
  const child = template.includes("app-child");
  return [
    'import { Component, Input } from "@angular/core";',
    child
      ? '@Component({ selector: "app-child", template: "<i></i>" }) export class ChildComponent { @Input() label = ""; }'
      : "",
    "@Component({",
    `  selector: "app-x", imports: [${child ? "ChildComponent" : ""}],`,
    `  template: ${template},`,
    "})",
    `export class XComponent { title = "hi"; ${body ?? "items = [1, 2]; two(a: number, b: number) {}"} }`,
  ].join("\n");
}

describe("mx-tsc Angular fix hints", () => {
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
  it.each(cases)(
    "$name is one positioned error and any concrete fix is clean",
    ({ template, body, needle, code, message, fixed, build, track }) => {
      const dir = mkdtempSync(join(tmpdir(), "mx-tsc-angular-hints-"));
      try {
        mkdirSync(join(dir, "src"));
        symlinkSync(
          join(repoRoot, "packages/tooling/angular-checker/node_modules"),
          join(dir, "node_modules"),
          "dir",
        );
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            name: "angular-hints",
            // `include` is what `mx-angular build` compiles; mx-tsc ignores
            // it and type-checks from the tsconfig below.
            mx: { host: "angular", angular: { include: ["src/**/*.ng.mx"] } },
          }),
        );
        writeFileSync(
          join(dir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: "esnext",
              module: "esnext",
              moduleResolution: "bundler",
              experimentalDecorators: true,
              skipLibCheck: true,
              types: [],
            },
            include: ["src"],
          }),
        );
        const source = moduleFor(template, body);
        const file = join(dir, "src/x.ng.mx");
        writeFileSync(file, source);
        const before = source.slice(0, source.indexOf(needle)).split("\n");
        const position = `${before.length},${(before.at(-1) ?? "").length + 1}`;
        const result = run(mxTsc, ["--noEmit", "-p", dir]);
        expect(result.status).not.toBe(0);
        const text = strip(result.output).trim();
        expect(text).toContain(`x.ng.mx(${position}): error TS${code}: `);
        expect(text).toContain(message);
        if (fixed === null) expect(text).not.toContain("`by=(");
        expect(text.match(/error TS/g)).toHaveLength(1);
        expect(text).not.toContain("approximate location");
        if (build) {
          // The same authored error on `mx-angular build`, as one error, no
          // NG cascade. Its position prints as `:line:column`.
          const built = run(mxAngular, ["build", "--project", dir]);
          expect(built.status).not.toBe(0);
          const buildText = strip(built.output).trim();
          const [line, column] = position.split(",");
          expect(buildText).toContain(`src/x.ng.mx:${line}:${column} error: `);
          expect(buildText).toContain(message);
          if (fixed === null) expect(buildText).not.toContain("`by=(");
          expect(buildText.match(/ error: /g)).toHaveLength(1);
        }
        if (fixed === null) return;
        const fixedSource = moduleFor(fixed, body);
        if (track)
          expect(compileNgMx(fixedSource, file).code).toContain(
            `track ${track})`,
          );
        writeFileSync(file, fixedSource);
        expect(run(mxTsc, ["--noEmit", "-p", dir])).toEqual({
          status: 0,
          output: "",
        });
        if (build) {
          expect(run(mxAngular, ["build", "--project", dir])).toEqual({
            status: 0,
            output: "",
          });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
