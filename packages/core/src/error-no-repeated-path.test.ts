import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dropCompiledFilePrefix } from "./compile.ts";
import { TranslateError } from "./core.ts";

/**
 * The message's leading path and the caller's `filename` can spell the same
 * file differently (a relative name, a symlinked directory, or two
 * independent aliases of one directory). The prefix is dropped when — and
 * only when — both sides resolve/realpath to the same file.
 */
describe("dropCompiledFilePrefix", () => {
  it("strips a prefix spelling the file through a different alias", () => {
    // `alias` and `alias2` are independent symlinks to the same `real`
    // directory: neither lexical resolve sees the other, so only the
    // realpath identity comparison can tell they name one file.
    const root = mkdtempSync(join(tmpdir(), "mx-core-alias-"));
    try {
      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real", "page.mx"), "");
      symlinkSync(join(root, "real"), join(root, "alias"));
      symlinkSync(join(root, "real"), join(root, "alias2"));
      const error = new TranslateError(
        `${root}/alias2/page.mx: the reason`,
        1,
        0,
      );
      dropCompiledFilePrefix(error, `${root}/alias/page.mx`);
      expect(error.message).toBe("the reason");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips the exact spelling and Babel's resolved spelling of a relative filename", () => {
    const exact = new TranslateError("/fixtures/page.mx: the reason", 1, 0);
    dropCompiledFilePrefix(exact, "/fixtures/page.mx");
    expect(exact.message).toBe("the reason");

    // Babel writes resolve(filename); the caller passed a relative name.
    const resolvedSpelling = resolve("app/page.mx");
    const resolved = new TranslateError(
      `${resolvedSpelling}: the reason`,
      1,
      0,
    );
    dropCompiledFilePrefix(resolved, "app/page.mx");
    expect(resolved.message).toBe("the reason");
  });

  it("keeps a prefix that names a different file", () => {
    const error = new TranslateError("/other/page.mx: the reason", 1, 0);
    dropCompiledFilePrefix(error, "/fixtures/page.mx");
    expect(error.message).toBe("/other/page.mx: the reason");
  });

  it("keeps a message whose reason merely contains a colon", () => {
    const error = new TranslateError(
      "Invalid attribute name `[value]`: x",
      1,
      0,
    );
    dropCompiledFilePrefix(error, "/fixtures/page.mx");
    expect(error.message).toBe("Invalid attribute name `[value]`: x");
  });
});
