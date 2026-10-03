import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
const ANSI = /\u001b\[[0-9;]*m/g;

function failure(source: string, file: string): Error {
  try {
    compile(source, file);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a compile error");
}

/**
 * The surface already prints the file (and the error carries `line`/`column`),
 * so a message that opens with the compiled file's absolute path only repeats
 * it, and leaks the machine path into whatever reads the message.
 */
describe("a TranslateError message does not repeat the compiled file's path", () => {
  const file = "/fixtures/project/src/pages/page.mx";

  it("drops the `<path>: ` prefix Babel puts on a lowering error", () => {
    const error = failure('<input [value]="input.name"/>\n', file);
    expect(error.name).toBe("TranslateError");
    expect(error.message.replace(ANSI, "")).toBe(
      "Invalid attribute name `[value]`; Marko rejects it too — write `value=` with the expression as the value",
    );
  });

  it("keeps the position on the error", () => {
    const error = failure('<input [value]="input.name"/>\n', file) as Error & {
      line: number;
      column: number;
    };
    expect([error.line, error.column]).toEqual([1, 7]);
  });

  it("leaves no occurrence of the file path in the message", () => {
    const error = failure('<input [value]="input.name"/>\n', file);
    expect(error.message).not.toContain("/fixtures/project");
  });
});
