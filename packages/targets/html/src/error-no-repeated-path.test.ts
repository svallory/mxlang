import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
      "Invalid attribute name `[value]` — write `value=` with the expression as the value",
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

  it("drops the prefix when the caller passes a relative filename", () => {
    // Babel writes the resolved absolute spelling of `filename` into the
    // prefix, so comparing the raw strings misses and the absolute machine
    // path stayed in the message. The comparison is resolve/realpath of
    // both sides (a missing file resolves only).
    const error = failure(
      '<input [value]="input.name"/>\n',
      "src/pages/page.mx",
    );
    expect(error.name).toBe("TranslateError");
    expect(error.message.replace(ANSI, "")).toBe(
      "Invalid attribute name `[value]` — write `value=` with the expression as the value",
    );
  });

  it("drops the prefix for a filename under a symlinked directory spelling", () => {
    // Same file, two spellings: `dir` is the realpath'd temp dir, `link`
    // its symlinked alias. Babel's prefix may carry either spelling, so the
    // comparison realpaths both sides (guarding a missing file).
    const dir = mkdtempSync(join(tmpdir(), "mx-core-link-"));
    try {
      const real = join(dir, "src", "page.mx");
      mkdirSync(dirname(real), { recursive: true });
      writeFileSync(real, "");
      const linkRoot = join(dir, "link");
      symlinkSync(join(dir, "src"), linkRoot);
      const error = failure(
        '<input [value]="input.name"/>\n',
        join(linkRoot, "page.mx"),
      );
      expect(error.name).toBe("TranslateError");
      expect(error.message.replace(ANSI, "")).toBe(
        "Invalid attribute name `[value]` — write `value=` with the expression as the value",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
