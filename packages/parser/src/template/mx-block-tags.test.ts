// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the cases are MX source, whose `${…}` is a placeholder, not a JS template
/**
 * The syntax table (decision 182, PR B) at the template parser: block tags
 * and filters in HTML content, and the precomputed `tagTypes` (addenda 2
 * and 3). Events render compactly, as in `mx-triggers.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { PROBES } from "./grammar-spec.cases.ts";
import {
  createParser,
  DEFAULT_SYNTAX,
  type SyntaxTable,
  TagType,
  validateSyntaxTable,
} from "./index.ts";

const table = (patch: Partial<SyntaxTable>): SyntaxTable => ({
  ...DEFAULT_SYNTAX,
  ...patch,
});

const JINJA = table({
  blockTag: { open: "{%", close: "%}" },
  filter: { open: "::", close: "::" },
});

function render(
  code: string,
  syntax: SyntaxTable | undefined,
  decide?: (name: string) => number | undefined,
): string {
  const out: string[] = [];
  const show = (r: { start: number; end: number }) =>
    JSON.stringify(code.slice(r.start, r.end));
  createParser(
    {
      onError: (e) => out.push(`ERR(${e.start}-${e.end} ${e.message})`),
      onText: (r) => out.push(`text(${show(r)})`),
      onBlockTag: (b) =>
        out.push(`block(${b.start}-${b.end} ${show(b.value)})`),
      onFilter: (f) =>
        out.push(
          `filter(${code.slice(f.name.start, f.name.end)} ${f.start}-${f.end} ${show(f.value)})`,
        ),
      onOpenTagName: (t) => {
        const name = code.slice(t.start, t.end);
        out.push(`<${name}>`);
        return decide?.(name) as never;
      },
      onScriptlet: (s) => out.push(`$${show(s.value)}`),
      onPlaceholder: (p) => out.push(`\${${show(p.value)}}`),
      onAttrName: (r) => out.push(`@${show(r)}`),
      onCloseTagEnd: () => out.push("</>"),
    },
    syntax ? { syntax } : undefined,
  ).parse(code);
  // The front end's statement node is built from the open tag's events; a
  // statement here shows as a tag whose name is the keyword, and no error.
  return out.join(" ");
}

describe("block tags", () => {
  it.each([
    [
      "<div>a {% for x in xs %}b{% endfor %}</div>",
      'text("a ") block(7-24 " for x in xs ") text("b") block(25-37 " endfor ") </>',
    ],
    // The body is raw: `<`, `${`, quotes and comments are text in it.
    [
      '<p>{% if a<b && "${x}" %}</p>',
      'block(3-25 " if a<b && \\"${x}\\" ") </>',
    ],
    // In a concise text block too.
    ["div -- a {% if %} b", 'text("a ") block(9-17 " if ") text(" b") </>'],
    // A placeholder beside it still is one.
    ["<p>${a}{%b%}</p>", '${"a"} block(7-12 "b") </>'],
    // A lone `{` or `%}` is text.
    ["<p>{ a %} b</p>", 'text("{ a %} b") </>'],
  ])("%j", (code, expected) => {
    expect(render(code, JINJA)).toContain(expected);
  });

  it.each([
    // Not in an attribute value, a string, a concise head or a text tag.
    ['<a x="{% y %}"/>', '<a> @"x"'],
    ["div {% x %}", '<div> @"{% x %}"'],
  ])("not a block tag: %j", (code, expected) => {
    const out = render(code, JINJA);
    expect(out).toContain(expected);
    expect(out).not.toContain("block(");
  });

  it("a text-only tag's body is raw text, never a block tag", () => {
    expect(
      render("<textarea>{% x %}</textarea>", JINJA, (n) =>
        n === "textarea" ? TagType.text : undefined,
      ),
    ).toBe('<textarea> text("{% x %}") </>');
  });

  it("an unclosed block tag is an error at end of input", () => {
    expect(render("<div>{% x", JINJA)).toBe(
      '<div> ERR(5-9 EOF reached while parsing a block tag: "%}" closes it)',
    );
  });

  it("the default row reads every `{%` as text", () => {
    expect(render("<p>{% x %}</p>", undefined)).toBe('<p> text("{% x %}") </>');
  });
});

describe("filters", () => {
  it.each([
    [
      "<div>::markdown::\n# hi\n::</div>",
      'filter(markdown 5-25 "\\n# hi\\n") </>',
    ],
    ["<p>a ::up::b:: c</p>", 'text("a ") filter(up 5-14 "b") text(" c") </>'],
    // No name, or no `close` right after it: text.
    ["<p>a :: b ::c</p>", 'text("a :: b ::c") </>'],
    ["<p>::two words</p>", 'text("::two words") </>'],
  ])("%j", (code, expected) => {
    expect(render(code, JINJA)).toContain(expected);
  });

  it("an unclosed filter is an error at end of input", () => {
    expect(render("<p>::md::x", JINJA)).toBe(
      '<p> ERR(3-10 EOF reached while parsing a filter: "::" closes it)',
    );
  });
});

describe("tagTypes (decision 182 addenda 2 and 3)", () => {
  const TYPES = table({
    tagTypes: {
      textarea: TagType.text,
      br: TagType.void,
      static: TagType.statement,
      "input:email": TagType.void,
    },
  });

  it("a text tag's body is parsed text", () => {
    expect(render("<textarea><b></textarea>", TYPES)).toBe(
      '<textarea> text("<b>") </>',
    );
  });

  it("a void tag has no body and no close", () => {
    expect(render("<br><p/>", TYPES)).toBe("<br> <p>");
  });

  it("statement applies only on a concise line, at the root", () => {
    expect(render("static x = 1\ndiv", TYPES)).toBe("<static> <div> </>");
    // HTML mode: html, no RESERVED_TAG_NAME (decision 163 addendum 7).
    expect(render("<static x=1/>", TYPES)).toBe('<static> @"x"');
    // Nested concise: the parser's own ROOT_TAG_ONLY, as today.
    expect(render("div\n  static x", TYPES)).toContain(
      'ERR(6-12 "static" can only be used at the root of the template.)',
    );
  });

  it("the key is the full written static name; dynamic and @ names are never looked up", () => {
    expect(render("<input:email/>", TYPES)).toBe("<input:email>");
    // `input:x` is not listed, so html: it needs its close tag.
    expect(render("<input:x>a</input:x>", TYPES)).toBe(
      '<input:x> text("a") </>',
    );
    expect(render("<@br>a</@br>", table({ tagTypes: { "@br": 2 } }))).toBe(
      '<@br> text("a") </>',
    );
    expect(render("<${br}>a</>", TYPES)).toContain('text("a") </>');
  });

  it("a type a handler returns still wins (the bundled @marko/compiler path)", () => {
    expect(
      render("<br>a</br>", TYPES, (n) =>
        n === "br" ? TagType.html : undefined,
      ),
    ).toBe('<br> text("a") </>');
  });

  it("the default row has no types: every probe's events equal no table at all", () => {
    const events = (code: string, syntax?: SyntaxTable) => {
      const out: string[] = [];
      const handlers = new Proxy(
        {},
        {
          get: (_target, name) =>
            typeof name === "string" && name.startsWith("on")
              ? (e: unknown) => {
                  out.push(`${name} ${JSON.stringify(e)}`);
                }
              : undefined,
        },
      );
      createParser(handlers, syntax ? { syntax } : undefined).parse(code);
      return out.join("\n");
    };
    const differ = PROBES.filter(
      (p) =>
        events(p.input) !== events(p.input, JINJA) && !/\{%|::/.test(p.input),
    ).map((p) => p.id);
    expect(differ).toEqual([]);
  });
});

describe("validation of PR B's fields", () => {
  it.each([
    [
      "a tag type that is not one",
      table({ tagTypes: { div: 7 as never } }),
      "tagTypes.div",
      /html \(0\), text \(1\), void \(2\) or statement \(3\)/,
    ],
    [
      "an opener starting with $",
      table({ blockTag: { open: "$%", close: "%$" } }),
      "blockTag.open",
      /may not start with "\$"/,
    ],
    [
      "openers where one starts the other",
      table({
        blockTag: { open: "{%", close: "%}" },
        filter: { open: "{%-", close: "-%}" },
      }),
      "filter.open",
      /start alike/,
    ],
  ])("%s", (_name, input, field, message) => {
    const found = validateSyntaxTable(input);
    expect(
      found.some((d) => d.field === field && message.test(d.message)),
      JSON.stringify(found),
    ).toBe(true);
  });

  it("accepts a block tag, a filter and tag types", () => {
    expect(
      validateSyntaxTable(
        table({ ...JINJA, tagTypes: { textarea: TagType.text } }),
      ),
    ).toEqual([]);
  });
});
