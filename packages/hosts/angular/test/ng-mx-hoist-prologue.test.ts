import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  lineColumnAt,
  lookupMapping,
  offsetAt,
  sourceOffsetFor,
} from "../src/mapping.ts";
import { compileNgMx } from "../src/ng-mx.ts";
import { angularOwnTargets } from "../src/own-targets.ts";

describe("hoisted imports without an authored import", () => {
  it.each([
    '"use client";\n"use strict";\n',
    "/* detached header */\n\n",
    "// header line one\n// header line two\n\n",
    "/* header one */\n/* header two */\n\n",
    '/* detached header */\r\n\r\n"use client";\r\n',
    '// detached header\n\n"use client"\n',
    '"use strict";\n/* detached header after prologue */\n\n',
    '"use strict";\n// detached header after prologue\n\n',
    '"use strict"; // trailing directive comment\n',
    '"use strict"; /* trailing directive comment */\r\n',
    '"use client";\n"use strict"; // trailing comment\n/* detached header */\n\n',
  ])(
    "keeps the header and directive prologue before the import: %j",
    (prefix) => {
      const dir = mkdtempSync(join(tmpdir(), "mx-ngmx-prologue-"));
      try {
        writeFileSync(join(dir, "package.json"), '{"name":"prologue"}');
        mkdirSync(join(dir, "tags"));
        writeFileSync(join(dir, "tags/badge.mx"), "<span>badge</span>");
        const filePath = join(dir, "x.component.ng.mx");
        const source = `${prefix}// attached declaration comment\ndeclare function Component(options: object): ClassDecorator;\nfunction local() { "use strict"; }\n@Component({ template: <div><badge/>\${missing}</div> })\nexport class XComponent { bad: number = "str"; }\n`;
        const result = compileNgMx(source, filePath, {
          customTags: getCustomTags(filePath, {
            host: "angular",
            targets: angularOwnTargets,
          }),
        });
        expect(result.code.startsWith(prefix.trimEnd()), result.code).toBe(
          true,
        );
        const parsed = ts.createSourceFile(
          "x.ts",
          result.code,
          ts.ScriptTarget.Latest,
          true,
        );
        const directiveCount = (prefix.match(/"use (?:client|strict)"/g) ?? [])
          .length;
        for (const statement of parsed.statements.slice(0, directiveCount)) {
          expect(
            ts.isExpressionStatement(statement) &&
              ts.isStringLiteral(statement.expression),
          ).toBe(true);
        }
        expect(result.code.indexOf("import { Badge }")).toBeGreaterThanOrEqual(
          prefix.trimEnd().length,
        );
        expect(result.code).toContain(
          "// attached declaration comment\ndeclare function Component",
        );
        expect(result.code.indexOf("import { Badge }")).toBeLessThan(
          result.code.indexOf("function local"),
        );
        const expression = result.code.indexOf("missing");
        expect(sourceOffsetFor(result.mappings, expression)).toBe(
          source.indexOf("missing"),
        );
        const generated = lineColumnAt(
          result.code,
          result.code.indexOf("bad:"),
        );
        const original = lookupMapping(result.map.mappings, generated);
        expect(original).not.toBeNull();
        if (!original)
          throw new Error("class diagnostic has no module mapping");
        expect(offsetAt(source, original)).toBe(source.indexOf("bad:"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
