/**
 * Task 1.7, call-site half: a page that calls a discovered `tags/*.mx` tag.
 *
 * Since tag-unit phase 1 such a call lowers to an injected module-level
 * `Import` plus a `Component` call, which this host used to reject with the
 * module-level message — calling a discovered tag was a positioned error.
 * These tests pin that it now resolves to a component reference.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { assertAngularParses } from "./helpers.ts";

/** Compiles `page` in a project whose `tags/` holds `tags`. */
function compilePage(
  page: string,
  tags: Record<string, string> = { "icon.mx": "<i>*</i>\n" },
) {
  const dir = mkdtempSync(join(tmpdir(), "mx-angular-call-"));
  mkdirSync(join(dir, "tags"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
  for (const [name, content] of Object.entries(tags)) {
    writeFileSync(join(dir, "tags", name), content);
  }
  const path = join(dir, "page.mx");
  writeFileSync(path, page);
  return compile(page, path, { customTags: getCustomTags(path) as never });
}

describe("calling a discovered tag from a page", () => {
  it("emits the tag's selector, derived from its filename and not from the injected binding", () => {
    // The core mints a gensym'd local (`$mx_Icon1`) for a discovered tag, so
    // a selector derived from `Component.target.name` would be the invalid
    // `<mx-$mx-icon1>`. It is resolved back through the synthesized import's
    // `resolvedPath` instead.
    const result = compilePage('<div><icon name="star"/></div>\n');

    expect(result.code).toBe('<div><mx-icon name="star"></mx-icon></div>');
    expect(result.code).not.toContain("$mx_");
    assertAngularParses(result.code);
  });

  it("reports the class and module path the caller's TypeScript must add", () => {
    const result = compilePage("<div><icon/></div>\n");

    // `name` is the tag as written, recovered from the file the gensym'd
    // binding resolved to — the watcher resolves it against the tag scan,
    // where `$mx_Icon1` would find nothing.
    expect(result.usedTags).toEqual([
      { name: "icon", className: "Icon", specifier: "./tags/icon" },
    ]);
  });

  it("warns once per file, naming the import line and `imports:` entry", () => {
    const result = compilePage("<div><icon/><icon/></div>\n");

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain(
      '`import Icon from "./tags/icon";` and `imports: [Icon]`',
    );
  });

  it("keeps an author-written module-level statement an error", () => {
    // Only the *synthesized* import is placed: an author who wrote an
    // `import` has a real TypeScript module to put it in, and a page template
    // has no module scope of its own.
    expect(() =>
      compilePage('import { x } from "./y";\n<div>${x}</div>\n'),
    ).toThrow(/an Angular template has no module scope/);
  });
});
