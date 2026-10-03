import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMxLanguagePlugin } from "./mx-language.ts";
import { dropOwnLocationHeader } from "./own-location-header.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
const ANSI = /\u001b\[[0-9;]*m/g;

const frame = [
  "      2 | <div>",
  "      3 |   <p>{input.name}",
  "    > 4 | </div>",
  '        | ^^^^^^ The closing "div" tag does not match the corresponding opening "p" tag at 3:3',
  "      5 |",
].join("\n");

describe("dropOwnLocationHeader", () => {
  const file = resolve("src/pages/page.mx");

  it("drops the `at <path>:L:C` line when it names the diagnosed file (cwd-relative)", () => {
    expect(
      dropOwnLocationHeader(`\n    at src/pages/page.mx:4:1\n${frame}`, file),
    ).toBe(`\n${frame}`);
  });

  it("drops it when the path is absolute", () => {
    expect(dropOwnLocationHeader(`\n    at ${file}:4:1\n${frame}`, file)).toBe(
      `\n${frame}`,
    );
  });

  it("drops it when the message has CRLF line endings", () => {
    // A `\r` before the newline defeated the line regex, so the header was
    // kept (the repeat this helper exists to drop).
    expect(
      dropOwnLocationHeader(`\n    at src/pages/page.mx:4:1\r\n${frame}`, file),
    ).toBe(`\n${frame}`);
  });

  it("drops it when one side is a symlinked spelling of the file", () => {
    // `resolve` is lexical, so the realpath'd spelling Marko prints and a
    // symlinked `fileName` never matched; both sides are realpath'd now
    // (guarding a missing file).
    const dir = mkdtempSync(join(tmpdir(), "mx-own-loc-"));
    try {
      const real = join(dir, "page.mx");
      writeFileSync(real, "");
      const link = join(dir, "link.mx");
      symlinkSync(real, link);
      expect(
        dropOwnLocationHeader(`\n    at ${real}:4:1\n${frame}`, link),
      ).toBe(`\n${frame}`);
      expect(
        dropOwnLocationHeader(`\n    at ${link}:4:1\n${frame}`, real),
      ).toBe(`\n${frame}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops it when the header is SGR-coloured (kleur under FORCE_COLOR)", () => {
    // Kleur wraps the path, line and column each in their own SGR runs; the
    // match runs on a VT-stripped copy, so the own header still goes.
    expect(
      dropOwnLocationHeader(
        `\n    at \u001b[36msrc/pages/page.mx\u001b[39m:\u001b[33m4\u001b[39m:\u001b[33m1\u001b[39m\n${frame}`,
        file,
      ),
    ).toBe(`\n${frame}`);
  });

  it("keeps a coloured header that names a different file, original text intact", () => {
    const message = `\n    at \u001b[36msrc/tags/card.mx\u001b[39m:\u001b[33m2\u001b[39m:\u001b[33m3\u001b[39m\n${frame}`;
    expect(dropOwnLocationHeader(message, file)).toBe(message);
  });

  it("keeps a header that names a different file: it is the only location", () => {
    const message = `\n    at src/tags/card.mx:2:3\n${frame}`;
    expect(dropOwnLocationHeader(message, file)).toBe(message);
  });

  it("keeps the text of a header that precedes the `at` line", () => {
    expect(
      dropOwnLocationHeader(
        `\`<box>\`: custom tag threw:\n    at src/pages/page.mx:4:1\n${frame}`,
        file,
      ),
    ).toBe(`\`<box>\`: custom tag threw:\n${frame}`);
  });

  it("leaves a message with no `at` line unchanged", () => {
    expect(dropOwnLocationHeader("plain text", file)).toBe("plain text");
  });
});

describe("a parse error's message carries no second copy of the location", () => {
  it("the plugin's syntax error has the frame but no `at <path>:L:C` line", () => {
    const fileName = resolve("src/pages/page.mx");
    const source =
      "export interface Input { name: string }\n<div>\n  <p>x\n</div>\n";
    const plugin = createMxLanguagePlugin(ts);
    plugin.createVirtualCode?.(
      fileName,
      "mx",
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    const message = (plugin.getSyntaxError(fileName)?.message ?? "").replace(
      ANSI,
      "",
    );
    expect(message).toContain('The closing "div" tag does not match');
    expect(message).not.toMatch(/^\s*at .+:\d+:\d+\s*$/m);
    expect(message).not.toContain("page.mx");
  });
});
