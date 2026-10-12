import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CustomTag, getCustomTags } from "@mxlang/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  AstroTemplateError,
  astroTargets,
  lowerAstroMx,
} from "./astro-template.ts";

/** The fix: always the name without the colon, and the `mx.tags` prefix when some prefix can produce the name. */
const FIX = (prefix: string | null) =>
  prefix === null
    ? " A colon belongs to the tag name: write the name without the colon."
    : ` A colon belongs to the tag name: write the name without the colon, or declare it from an \`mx.tags\` directory with \`prefix: "${prefix}"\`.`;
const UNRESOLVED = (name: string) =>
  `Unable to find entry point for custom tag \`<${name}>\`.`;

const root = mkdtempSync(join(tmpdir(), "mx-astro-colon-tag-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Failure {
  message: string;
  line: number;
  column: number;
  end: { line: number; column: number } | undefined;
  file: string | undefined;
}

function failureOf(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AstroTemplateError);
    const e = error as AstroTemplateError;
    return {
      message: e.message,
      line: e.line,
      column: e.column,
      end: e.end,
      file: e.file,
    };
  }
  throw new Error("expected a compile error, but the template compiled");
}

const lower = (
  source: string,
  file = "Test.astro.mx",
  customTags?: Record<string, CustomTag>,
) =>
  lowerAstroMx(source, file, {
    targets: astroTargets,
    customTags: customTags ?? {},
  });

const errorOf = (source: string): Failure => failureOf(() => lower(source));

/** A colon name is one custom-tag name, as in Marko: undeclared, it is an error, never an Astro namespace element. */
describe("Astro host: an undeclared colon tag name", () => {
  // The fence is two lines, so a template line `n` is file line `n + 2`.
  const F = "---\n---\n";

  // [label, template, name, mx.tags prefix that produces it (null: none), line of the tag, column, end column]
  it.each([
    ["with a lowercase namespace", "<ns:tag/>", "ns:tag", "ns:", 3, 0, 7],
    [
      "with a capitalized namespace and tag",
      "<Ns:Tag/>",
      "Ns:Tag",
      "Ns:",
      3,
      0,
      7,
    ],
    [
      "when the namespace is a svg one",
      "<svg:rect/>",
      "svg:rect",
      "svg:",
      3,
      0,
      9,
    ],
    ["with an id-like tag", "<uuid:id/>", "uuid:id", "uuid:", 3, 0, 8],
    ["with an attribute", "<uuid:id a=1/>", "uuid:id", "uuid:", 3, 0, 8],
    [
      "with a body",
      "<kind:name>hi</kind:name>",
      "kind:name",
      "kind:",
      3,
      0,
      10,
    ],
    [
      "inside an element",
      "<div>\n  <ns:tag/>\n</div>",
      "ns:tag",
      "ns:",
      4,
      2,
      9,
    ],
    ["with a leading colon", "<:email/>", ":email", ":", 3, 0, 7],
    ["with two colons", "<a:b:c/>", "a:b:c", "a:b:", 3, 0, 6],
    // A prefix is any string, so a prefix ending after the colon produces it.
    ["with a hyphen after the colon", "<a:-x/>", "a:-x", "a:-", 3, 0, 5],
    ["with a dollar before the stem", "<a:$x/>", "a:$x", "a:$", 3, 0, 5],
    // No file stem ends these names.
    ["with nothing after the colon", "<uuid:/>", "uuid:", null, 3, 0, 6],
    ["with only a hyphen after the colon", "<x:-/>", "x:-", null, 3, 0, 4],
    ["ending in a dollar", "<a:b$/>", "a:b$", null, 3, 0, 5],
    ["ending in a non-ASCII letter", "<a:é/>", "a:é", null, 3, 0, 4],
  ])(
    "is rejected %s, at the tag",
    (_label, template, name, prefix, line, column, endColumn) => {
      expect(errorOf(F + template)).toEqual({
        message: UNRESOLVED(name) + FIX(prefix),
        line,
        column,
        end: { line, column: endColumn },
        file: undefined,
      });
    },
  );

  it("never offers the fence import or tags/ file, which a colon name cannot be", () => {
    const { message } = errorOf(`${F}<ns:tag/>`);
    expect(message).not.toContain("Import it");
    expect(message).not.toContain("tags/");
  });

  it("keeps Marko's suggestion for a near HTML element", () => {
    expect(errorOf(`${F}<div:x/>`).message).toBe(
      `${UNRESOLVED("div:x")} Did you mean \`<div>\`?${FIX("div:")}`,
    );
  });

  it("rejects a colon tag in a closing form of the same name once, at the opening tag", () => {
    expect(errorOf(`${F}<ns:tag>hi</ns:tag>`)).toMatchObject({
      message: UNRESOLVED("ns:tag") + FIX("ns:"),
      line: 3,
      column: 0,
    });
  });

  it("does not change an uncolon capitalized tag's own hint", () => {
    expect(errorOf(`${F}<Card/>`).message).toBe(
      'Unable to find entry point for custom tag `<Card>`. Import it in the `---` fence (`import Card from "./Card.astro"`) or add `tags/Card.mx`.',
    );
  });

  it("reports a tag template's colon tag in the template file", () => {
    const dir = join(root, "template");
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"t"}');
    writeFileSync(join(dir, "tags", "wrap.mx"), "<div>\n  <ns:tag/>\n</div>\n");
    const page = join(dir, "page.astro.mx");
    const error = failureOf(() =>
      lower(
        "---\n---\n<wrap/>",
        page,
        getCustomTags(page, { targets: astroTargets }),
      ),
    );
    expect(error).toEqual({
      message: UNRESOLVED("ns:tag") + FIX("ns:"),
      line: 2,
      column: 2,
      end: { line: 2, column: 9 },
      file: join(dir, "tags", "wrap.mx"),
    });
  });
});

describe("Astro host: a declared colon tag name", () => {
  it("still compiles through the transform contract", () => {
    const tags: Record<string, CustomTag> = {
      "uuid:id": { transform: (call) => call.content?.children ?? [] },
    };
    const code = lower(
      "---\n---\n<uuid:id a=1>hi</uuid:id>",
      "Test.astro.mx",
      tags,
    ).code;
    expect(code).toContain("hi");
    expect(code).not.toContain("uuid:id");
  });
});

/**
 * The route the error's fix names: an `mx.tags` directory whose `prefix` is the
 * one the error prints. Each row reads the prefix out of the error, declares
 * the tag with it, and checks the error is gone.
 */
describe("Astro host: the mx.tags prefix an error names declares the tag", () => {
  let n = 0;
  it.each([
    ["uuid:id", "uuid:", "id"],
    ["a:-x", "a:-", "x"],
    ["a:$x", "a:$", "x"],
    ["a:1x", "a:", "1x"],
    [":email", ":", "email"],
    ["a:b:c", "a:b:", "c"],
  ])("<%s>", (name, prefix, stem) => {
    const message = errorOf(`---\n---\n<${name}/>`).message;
    expect(message).toContain(`prefix: ${JSON.stringify(prefix)}`);

    const dir = join(root, `prefix${++n}`);
    mkdirSync(join(dir, "ui"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "t", mx: { tags: [{ dir: "ui", prefix }] } }),
    );
    writeFileSync(join(dir, "ui", `${stem}.mx`), "<b/>\n");
    const page = join(dir, "page.astro.mx");
    const tags = getCustomTags(page, { targets: astroTargets });
    expect(Object.keys(tags)).toEqual([name]);
    const code = lower(`---\n---\n<${name}/>`, page, tags).code;
    expect(code).toMatch(/<Mx_[\w$]+ \/>/);
    expect(code).not.toContain(`<${name}`);
  });
});

/**
 * What the lowering diagnostic carries survives the rethrow: the MX code and
 * the exclusive end of its range, so a tool shows both.
 */
describe("Astro host: AstroTemplateError carries the lowering diagnostic", () => {
  it("carries the code and the end of a lowering error", () => {
    let error: unknown;
    try {
      lower("---\n---\n<for|x|/>");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AstroTemplateError);
    expect(error).toMatchObject({
      diagnosticCode: "MX_INVALID_FOR",
      line: 3,
      column: 0,
      end: { line: 3, column: 4 },
      loc: { line: 3, column: 0, end: { line: 3, column: 4 } },
    });
  });

  it("stays plain when the diagnostic has neither", () => {
    const error = new AstroTemplateError("m", 2, 3);
    expect(error.diagnosticCode).toBeUndefined();
    expect(error.end).toBeUndefined();
    expect(error.loc).toEqual({ line: 2, column: 3 });
  });
});
