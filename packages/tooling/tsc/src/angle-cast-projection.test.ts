// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX template fixtures
// biome-ignore-all lint/style/useTemplate: keep MX placeholder syntax literal
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANGLE_INPUT,
  ATTRIBUTE_CAST_RANGES,
  angleProbesFor,
  checkedLiteralProbesFor,
  HTML_COMMENT_HELPER_ERROR,
  OPERATOR_PROBES,
  VALID_ANGLE_PROBES,
  withMissingType,
} from "../../typescript-plugin/src/fixtures/angle-cast-probes.ts";
import { runInProcess } from "./in-process.ts";

const repo = resolve(import.meta.dirname, "../../../..");

describe("angle assertions through mx-tsc", () => {
  it.each(["html", "preact", "react", "hono"])(
    "reports each %s container on the authored property",
    (host) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-angle-tsc-")));
      try {
        symlinkSync(
          join(repo, "node_modules"),
          join(dir, "node_modules"),
          "dir",
        );
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "angle-test", mx: { host, strict: false } }),
        );
        writeFileSync(
          join(dir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              module: "ESNext",
              moduleResolution: "Bundler",
              target: "ES2022",
              jsx: "preserve",
              jsxImportSource:
                host === "html"
                  ? undefined
                  : host === "hono"
                    ? "hono/jsx"
                    : host,
              allowArbitraryExtensions: true,
              allowImportingTsExtensions: true,
              paths: {
                "@mxlang/target-html": [
                  join(repo, "packages/targets/html/dist/index.d.ts"),
                ],
                "@mxlang/core": [join(repo, "packages/core/dist/index.d.ts")],
                "@mxlang/host-preact": [
                  join(repo, "packages/hosts/preact/src/index.ts"),
                ],
                "@mxlang/host-react": [
                  join(repo, "packages/hosts/react/src/index.ts"),
                ],
                "@mxlang/host-hono": [
                  join(repo, "packages/hosts/hono/src/index.ts"),
                ],
              },
            },
            files: ["consumer.ts"],
          }),
        );
        const imports: string[] = [];
        const probes = angleProbesFor(host);
        probes.forEach(([, probe], i) => {
          const file = `probe-${i}.mx`;
          writeFileSync(join(dir, file), ANGLE_INPUT + probe);
          imports.push(`import "./${file}";`);
          const typeFile = `type-${i}.mx`;
          writeFileSync(
            join(dir, typeFile),
            ANGLE_INPUT + withMissingType(probe),
          );
          imports.push(`import "./${typeFile}";`);
        });
        mkdirSync(join(dir, "valid"));
        VALID_ANGLE_PROBES.forEach((probe, i) => {
          const file = `valid/probe-${i}.mx`;
          writeFileSync(join(dir, file), ANGLE_INPUT + probe);
          imports.push(`import "./${file}";`);
        });
        writeFileSync(
          join(dir, "wrong.mx"),
          ANGLE_INPUT + "<p>${<string>input.num}</p>",
        );
        imports.push('import "./wrong.mx";');
        writeFileSync(
          join(dir, "unknown.mx"),
          ANGLE_INPUT + "<p>${<Missing>input.text}</p>",
        );
        imports.push('import "./unknown.mx";');
        if (host === "html") {
          writeFileSync(
            join(dir, "inert-id.mx"),
            ANGLE_INPUT + "<id=(<string>input.zz)/>",
          );
          imports.push('import "./inert-id.mx";');
        }
        OPERATOR_PROBES.forEach(([probe], i) => {
          const file = `operator-${i}.mx`;
          writeFileSync(join(dir, file), ANGLE_INPUT + probe);
          imports.push(`import "./${file}";`);
        });
        for (const [i, expression] of ["input.zz", "<any>input.zz"].entries()) {
          const file = `dynamic-${i}.mx`;
          writeFileSync(
            join(dir, file),
            ANGLE_INPUT + "<section><${" + expression + "}/></section>",
          );
          imports.push(`import "./${file}";`);
        }
        checkedLiteralProbesFor(host).forEach(([probe], i) => {
          const file = `literal-${i}.mx`;
          writeFileSync(join(dir, file), ANGLE_INPUT + probe);
          imports.push(`import "./${file}";`);
        });
        const wrappedKeys =
          host === "html"
            ? []
            : [
                '("id" as any)',
                '(<any>"id")',
                '("id" as string)',
                '(<Missing>"id")',
              ];
        wrappedKeys.forEach((key, i) => {
          const file = `wrapped-key-${i}.mx`;
          writeFileSync(
            join(dir, file),
            "export interface Input { list: { id: string }[] }\n" +
              `<for|row| of=input.list by=${key}><p/></for>`,
          );
          imports.push(`import "./${file}";`);
        });
        const attributeRange =
          "<define/L|{item}: {item?: any}|/><L><for|i| from=(<number>input.zz) to=3 step=(<number>input.zz)><@item n=i/></for></L>";
        if (host !== "html") {
          writeFileSync(
            join(dir, "attribute-range.mx"),
            ANGLE_INPUT + attributeRange,
          );
          imports.push('import "./attribute-range.mx";');
        }
        ATTRIBUTE_CAST_RANGES.forEach((probe, i) => {
          const file = `attribute-casts-${i}.mx`;
          writeFileSync(join(dir, file), ANGLE_INPUT + probe);
          imports.push(`import "./${file}";`);
        });
        writeFileSync(join(dir, "consumer.ts"), imports.join("\n"));
        const run = runInProcess(
          ["--noEmit", "--pretty", "false", "-p", join(dir, "tsconfig.json")],
          dir,
        );
        const output = `${run.stdout}\n${run.stderr}`
          .split("\n")
          .filter(
            (line) =>
              !(
                line.includes("error TS7006:") &&
                HTML_COMMENT_HELPER_ERROR.test(line)
              ),
          )
          .join("\n");
        expect(run.status, output).not.toBe(0);
        expect(output).not.toMatch(
          /TS17002|TS1005|TS1002|approximate|MX-generated/,
        );
        const position = (probe: string, token: string) => {
          const before = (ANGLE_INPUT + probe)
            .slice(0, (ANGLE_INPUT + probe).indexOf(token))
            .split("\n");
          return `${before.length},${(before.at(-1)?.length ?? 0) + 1}`;
        };
        probes.forEach(([name, probe], i) => {
          const lines = output
            .split("\n")
            .filter(
              (line) =>
                line.includes(`probe-${i}.mx(`) &&
                line.includes("error TS2339:"),
            );
          expect(lines, name).toEqual([
            expect.stringContaining(
              `probe-${i}.mx(${position(probe, "zz")}): error TS2339: Property 'zz'`,
            ),
          ]);
          const types = output
            .split("\n")
            .filter(
              (line) =>
                line.includes(`type-${i}.mx(`) &&
                line.includes("error TS2304:"),
            );
          expect(types, `${name}: moved type`).toEqual([
            expect.stringContaining(
              `type-${i}.mx(${position(withMissingType(probe), "Missing")}): error TS2304:`,
            ),
          ]);
        });
        OPERATOR_PROBES.forEach(([probe, code, cast], i) => {
          expect(
            output
              .split("\n")
              .filter((line) => line.includes(`operator-${i}.mx(`)),
          ).toEqual([
            expect.stringContaining(
              `operator-${i}.mx(${position(probe, cast)}): error TS${code}:`,
            ),
          ]);
        });
        for (const [i, expression] of ["input.zz", "<any>input.zz"].entries()) {
          const probe = "<section><${" + expression + "}/></section>";
          expect(
            output
              .split("\n")
              .filter((line) => line.includes(`dynamic-${i}.mx(`)),
          ).toEqual([
            expect.stringContaining(
              `dynamic-${i}.mx(${position(probe, "zz")}): error TS2339:`,
            ),
          ]);
        }
        checkedLiteralProbesFor(host).forEach(([probe, , cast], i) => {
          const lines = output
            .split("\n")
            .filter(
              (line) =>
                line.includes(`literal-${i}.mx(`) && line.includes("TS2352"),
            );
          expect(lines, probe).toEqual(
            cast
              ? [
                  expect.stringContaining(
                    `literal-${i}.mx(${position(probe, cast)}): error TS2352:`,
                  ),
                ]
              : [],
          );
        });
        expect(
          output
            .split("\n")
            .filter(
              (line) =>
                /literal-\d+\.mx\(/.test(line) && line.includes("TS2322"),
            ),
        ).toHaveLength(host === "html" ? 0 : 2);
        wrappedKeys.forEach((key, i) => {
          const probe = `<for|row| of=input.list by=${key}><p/></for>`;
          expect(
            output
              .split("\n")
              .filter((line) => line.includes(`wrapped-key-${i}.mx(`)),
            key,
          ).toEqual(
            key.includes("Missing")
              ? [
                  expect.stringContaining(
                    `wrapped-key-${i}.mx(${position(probe, "Missing")}): error TS2304:`,
                  ),
                ]
              : [],
          );
        });
        if (host !== "html") {
          expect(
            output
              .split("\n")
              .filter((line) => line.includes("attribute-range.mx(")),
          ).toEqual(
            [
              attributeRange.indexOf("zz"),
              attributeRange.lastIndexOf("zz"),
            ].map((at) =>
              expect.stringContaining(
                `attribute-range.mx(2,${at + 1}): error TS2339:`,
              ),
            ),
          );
        }
        ATTRIBUTE_CAST_RANGES.forEach((probe, i) => {
          expect(
            output
              .split("\n")
              .filter((line) => line.includes(`attribute-casts-${i}.mx(`)),
            probe,
          ).toEqual(
            [probe.indexOf("zz"), probe.lastIndexOf("zz")].map((at) =>
              expect.stringContaining(
                `attribute-casts-${i}.mx(2,${at + 1}): error TS2339:`,
              ),
            ),
          );
        });
        expect(output).toContain("wrong.mx(2,6): error TS2352:");
        expect(output).toContain("unknown.mx(2,7): error TS2304:");
        expect(output).not.toMatch(/valid\/probe-\d+\.mx\(/);
        expect(output).not.toContain("inert-id.mx(");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
