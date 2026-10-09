/**
 * Decision 182, PR B, in the front end: `MxBlockTag` and `MxFilter` nodes,
 * and the precomputed `tagTypes` (addenda 2 and 3): the explicit option, the
 * interim pre-scan, and that the parser's types always agree with the body
 * modes the tree records.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROBES } from "../template/grammar-spec.cases.ts";
import {
  createParser,
  DEFAULT_SYNTAX,
  type SyntaxTable,
  TagType,
} from "../template/index.ts";
import { parse } from "./parse.ts";
import { buildTagTypes, candidateNames } from "./tag-types.ts";
import { characters, tokens } from "./test-support/fuzz.ts";
import { checkInvariants } from "./test-support/invariants.ts";
import { OPTIONS } from "./test-support/options.ts";
import { projectDocument } from "./test-support/project.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

const JINJA: SyntaxTable = {
  ...DEFAULT_SYNTAX,
  blockTag: { open: "{%", close: "%}" },
  filter: { open: "::", close: "::" },
};

describe("MxBlockTag and MxFilter", () => {
  it("block tags are raw body children", () => {
    const document = parse("<ul>{% for x in xs %}<li/>{% endfor %}</ul>", {
      ...OPTIONS,
      syntax: JINJA,
    });
    expect(document.errors).toEqual([]);
    expect(checkInvariants(document, OPTIONS.tagShape)).toEqual([]);
    expect(projectDocument(document)).toEqual(
      [
        'tag "ul" [1,3) [0,43) open=[0,4) close=[38,43) "ul" mode=html',
        "  block-tag [4,21) value=[6,19)",
        'tag "li" [22,24) [21,26) open=[21,26) mode=html self-closed',
        "  block-tag [26,38) value=[28,36)",
      ].map((line, i) => (i === 2 ? `  ${line}` : line)),
    );
    const [first] = (document.body[0] as unknown as { body: unknown[] }).body;
    expect(first).toEqual({
      type: "MxBlockTag",
      start: 4,
      end: 21,
      value: " for x in xs ",
      valueSpan: { start: 6, end: 19 },
    });
  });

  it("a filter is its name and raw body", () => {
    const document = parse("<div>::markdown::\n# hi\n::</div>", {
      ...OPTIONS,
      syntax: JINJA,
    });
    expect(document.errors).toEqual([]);
    expect(checkInvariants(document, OPTIONS.tagShape)).toEqual([]);
    expect((document.body[0] as unknown as { body: unknown[] }).body).toEqual([
      {
        type: "MxFilter",
        start: 5,
        end: 25,
        name: "markdown",
        nameSpan: { start: 7, end: 15 },
        value: "\n# hi\n",
        valueSpan: { start: 17, end: 23 },
      },
    ]);
  });

  it("an unclosed block tag is a template error with the partial tree", () => {
    const document = parse("<p>{% x", { ...OPTIONS, syntax: JINJA });
    expect(document.complete).toBe(false);
    expect(document.errors.map((e) => e.code)).toEqual(["MALFORMED_BLOCK_TAG"]);
  });
});

describe("tagTypes (decision 182 addenda 2 and 3)", () => {
  it("an explicit table equal to the pre-scan's gives the same tree for every probe", () => {
    const differ = PROBES.filter((probe) => {
      const tagTypes = buildTagTypes(
        probe.input,
        OPTIONS.statementKeywords,
        OPTIONS.tagShape,
      );
      const scanned = parse(probe.input, OPTIONS);
      const given = parse(probe.input, { ...OPTIONS, tagTypes });
      return JSON.stringify(scanned) !== JSON.stringify(given);
    }).map((probe) => probe.id);
    expect(differ).toEqual([]);
  });

  it("a caller's table that disagrees with tagShape is a positioned caller error", () => {
    const document = parse("<textarea><b></textarea>", {
      ...OPTIONS,
      tagTypes: {},
    });
    // The template parser's own consequence of the html type follows it.
    expect(document.errors.map((e) => e.code)).not.toContain(
      "MX_FRONT_END_INTERNAL",
    );
    expect(document.errors).toContainEqual(
      expect.objectContaining({
        code: "MX_TAG_TYPES_MISMATCH",
        origin: "front-end",
        start: 1,
        end: 9,
        message:
          "`tagTypes` gives <textarea> html, but `tagShape` answers text: the caller's table and `tagShape` disagree, so the tag was parsed as html",
      }),
    );
  });

  it("an unclosed filter has its own code", () => {
    const document = parse("<p>::md::x", { ...OPTIONS, syntax: JINJA });
    expect(document.errors.map((e) => e.code)).toEqual(["MALFORMED_FILTER"]);
  });

  it("an invalid tag type is a TypeError at the call", () => {
    expect(() =>
      parse("x", { ...OPTIONS, tagTypes: { x: 9 as never } }),
    ).toThrow(TypeError);
  });

  it("the table is keyed by the full written name and statement words stay mode-aware", () => {
    expect(
      buildTagTypes(
        "static x = 1\n<textarea>a</textarea>\n<input:email/>\n<@br/>",
        OPTIONS.statementKeywords,
        OPTIONS.tagShape,
      ),
    ).toEqual({ static: TagType.statement, textarea: TagType.text });
    // `<static/>` in HTML mode is a tag (decision 163 addendum 7), as before.
    expect(parse("<static x=1/>", OPTIONS).body[0]?.type).toBe("MxTag");
    expect(parse("import:x y", OPTIONS).body[0]?.type).toBe("MxTag");
  });
});

describe("the interim pre-scan finds every static tag name", () => {
  /** The static, non-attribute tag names the template parser meets, typed by the scanned table. */
  const met = (source: string): string[] => {
    const names: string[] = [];
    const tagTypes = buildTagTypes(
      source,
      OPTIONS.statementKeywords,
      OPTIONS.tagShape,
    );
    try {
      createParser(
        {
          onOpenTagName: (t) => {
            if (t.expressions.length > 0) return;
            const name = source.slice(t.start, t.end);
            if (!name.startsWith("@")) names.push(name);
          },
        },
        { syntax: { ...DEFAULT_SYNTAX, tagTypes } },
      ).parse(source);
    } catch {
      // a template-parser throw is tested elsewhere
    }
    return names;
  };
  const missing = (inputs: { id: string; source: string }[]) =>
    inputs.flatMap(({ id, source }) => {
      const candidates = candidateNames(source);
      return met(source)
        .filter((name) => !candidates.has(name))
        .map((name) => `${id}: ${JSON.stringify(name)}`);
    });

  it("over the grammar corpus", () => {
    expect(missing(PROBES.map((p) => ({ id: p.id, source: p.input })))).toEqual(
      [],
    );
  });

  it("over every tracked .mx source", () => {
    const paths = execFileSync("git", ["ls-files", "*.mx"], {
      cwd: REPO,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(paths.length).toBeGreaterThan(400);
    expect(
      missing(
        paths.map((path) => ({
          id: path,
          source: readFileSync(`${REPO}${path}`, "utf8"),
        })),
      ),
    ).toEqual([]);
  });

  it("over a seeded fuzz sample, a name the scan misses is added by a restart, never an internal error", () => {
    let misses = 0;
    const problems: string[] = [];
    for (let seed = 1; seed <= 2000; seed++) {
      for (const source of [characters(seed, 40), tokens(seed)]) {
        misses += missing([{ id: "", source }]).length;
        const document = parse(source, OPTIONS);
        if (document.errors.some((e) => e.code === "MX_FRONT_END_INTERNAL")) {
          problems.push(`${seed} ${JSON.stringify(source)}`);
        }
        // The tree equals the one an explicit complete table gives.
        const tagTypes = {
          ...buildTagTypes(source, OPTIONS.statementKeywords, OPTIONS.tagShape),
        };
        for (const name of met(source)) {
          const shape = OPTIONS.tagShape(name);
          if (shape === "void") tagTypes[name] = TagType.void;
          else if (shape.startsWith("parsed-text"))
            tagTypes[name] = TagType.text;
        }
        const given = parse(source, { ...OPTIONS, tagTypes });
        if (JSON.stringify(given) !== JSON.stringify(document)) {
          problems.push(`differs: ${seed} ${JSON.stringify(source)}`);
        }
      }
    }
    expect(problems).toEqual([]);
    // The scan is the rule, the restart the exception.
    expect(misses).toBeLessThan(40);
  });
});
