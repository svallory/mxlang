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
import { mxTsc, repoRoot, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

const cases = [
  {
    name: "a16 switch/case",
    template: '<div><switch=title><case="a"><p>a</p></case></switch></div>',
    needle: "switch",
    code: "80001",
    message:
      "Unable to find entry point for custom tag `<switch>`. MX has no switch; use `<if=…>` / `<else if=…>`.",
    fixed:
      '<div><if=(title === "a")><p>a</p></if><else if=(title === "b")><p>b</p></else></div>',
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
    name: "a14 arrow parameter",
    template: "<ul><for|x| of=items by=(y=>y.id)><li>${x}</li></for></ul>",
    needle: "y=>",
    code: "80001",
    message:
      "The `by=` arrow parameter `y` must match the `<for>` row `x`; use `by=identity` to track the row itself.",
    fixed: "<ul><for|x| of=items by=identity><li>${x}</li></for></ul>",
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
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: diagnostics may carry ANSI colour
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
function moduleFor(template: string): string {
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
    'export class XComponent { title = "hi"; items = [1, 2]; two(a: number, b: number) {} }',
  ].join("\n");
}

describe("mx-tsc Angular fix hints", () => {
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
  it.each(cases)(
    "$name is one positioned error and the offered fix is clean",
    ({ template, needle, code, message, fixed }) => {
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
          JSON.stringify({ name: "angular-hints", mx: { host: "angular" } }),
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
        const source = moduleFor(template);
        const file = join(dir, "src/x.ng.mx");
        writeFileSync(file, source);
        const before = source.slice(0, source.indexOf(needle)).split("\n");
        const position = `${before.length},${(before.at(-1) ?? "").length + 1}`;
        const result = run(mxTsc, ["--noEmit", "-p", dir]);
        expect(result.status).not.toBe(0);
        const text = strip(result.output).trim();
        expect(text).toContain(
          `x.ng.mx(${position}): error TS${code}: ${message}`,
        );
        expect(text.match(/error TS/g)).toHaveLength(1);
        expect(text).not.toContain("approximate location");
        writeFileSync(file, moduleFor(fixed));
        expect(run(mxTsc, ["--noEmit", "-p", dir])).toEqual({
          status: 0,
          output: "",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
