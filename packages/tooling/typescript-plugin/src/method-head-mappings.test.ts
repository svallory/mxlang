import { basename, join } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { createMutablePluginService } from "./fixtures/plugin-service.ts";

const TEMPLATE = [
  "<div>",
  "  <button onClick(e: MissingParameter) {} />",
  '  <button onClick(e: number = "bad") {} />',
  "  <button onClick<T extends MissingConstraint>(e: T) {} />",
  "  <button onClick=function (): MissingReturn { return 1 } />",
  "</div>",
].join("\n");

function diagnostics(host: string, region: boolean) {
  const directory = join(import.meta.dirname, "fixtures", `${host}-policy`);
  const file = join(
    directory,
    region ? `MethodHead.${host}.mx` : "method-head.mx",
  );
  const consumer = join(directory, "method-head-consumer.ts");
  const source = region ? `export const Page = (\n${TEMPLATE}\n);` : TEMPLATE;
  const { service, project } = createMutablePluginService(
    {
      [file]: source,
      [consumer]: `import ${JSON.stringify(`./${basename(file)}`)};`,
    },
    [consumer],
  );
  try {
    service.getSemanticDiagnostics(consumer);
    const text = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
    return service
      .getSemanticDiagnostics(file)
      .filter(
        (d) =>
          (d.code === 2304 &&
            ts
              .flattenDiagnosticMessageText(d.messageText, "\n")
              .includes("Missing")) ||
          (d.code === 2322 && d.start === source.indexOf('e: number = "bad"')),
      )
      .map((d) => {
        const position = text.getLineAndCharacterOfPosition(d.start ?? 0);
        return {
          code: d.code,
          line: position.line + 1,
          column: position.character + 1,
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        };
      });
  } finally {
    service.dispose();
    project.close();
  }
}

type Diagnostic = ReturnType<typeof diagnostics>[number];

// Real tsserver plugin wiring: exact head diagnostics survive Volar without
// approximate fallbacks, in a region too.
describe.each(["solid", "preact", "react", "hono"])(
  "%s method heads in the editor",
  (host) => {
    let whole: Diagnostic[];
    let region: Diagnostic[];
    beforeAll(() => {
      whole = diagnostics(host, false);
      region = diagnostics(host, true);
    }, 60_000);

    it("maps whole-file parameter types, defaults, constraints and return types exactly", () => {
      for (const d of whole) {
        expect(d.message).not.toMatch(
          /position approximate|MX-generated code|position unknown/,
        );
      }
      expect(
        whole.map(({ code, line, column }) => [code, line, column]),
      ).toEqual([
        [2304, 2, 22],
        [2322, 3, 19],
        [2304, 4, 29],
        [2304, 5, 32],
      ]);
    });

    it("keeps exact region parameter, default, generic constraint and return positions", () => {
      for (const d of region) {
        expect(d.message).not.toMatch(
          /position approximate|MX-generated code|position unknown/,
        );
      }
      expect(
        region.map(({ code, line, column }) => [code, line, column]),
      ).toEqual([
        [2304, 3, 22],
        [2322, 4, 19],
        [2304, 5, 29],
        [2304, 6, 32],
      ]);
    });
  },
);
