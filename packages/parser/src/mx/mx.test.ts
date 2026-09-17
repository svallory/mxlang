import { describe, expect, it } from "vitest";
import { collectMxRegions } from "../index.ts";
import { parseSolid } from "./test-helpers.ts";

/** Walks the AST collecting every node of a given type. */
function collect(node: unknown, type: string, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, type, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (record.type === type) out.push(record);
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "extra") continue;
    collect(record[key], type, out);
  }
  return out;
}

const parseMx = (source: string) => parseSolid(source);

describe("MX element parsing", () => {
  it("lowers an attr method to a block-body arrow", () => {
    const file = parseMx(
      `const el = <button onClick() { setCount(count() + 1) }>\${count()}</button>;`,
    );
    const arrows = collect(file, "ArrowFunctionExpression") as {
      body: { type: string; body: unknown[] };
      params: unknown[];
      async: boolean;
    }[];
    expect(arrows).toHaveLength(1);
    // The block body is never unwrapped to an expression body, even though it
    // holds a single expression statement.
    expect(arrows[0]?.body.type).toBe("BlockStatement");
    expect(arrows[0]?.body.body).toHaveLength(1);
    expect(arrows[0]?.params).toHaveLength(0);
    expect(arrows[0]?.async).toBe(false);
  });

  it("lowers static, dynamic and boolean attributes", () => {
    const file = parseMx(`const el = <a href="/x" title=t() disabled>go</a>;`);
    const attrs = collect(file, "JSXAttribute") as {
      name: { name: string };
      value: { type: string; expression?: { type: string; value?: unknown } };
    }[];
    expect(attrs.map((a) => a.name.name)).toEqual([
      "href",
      "title",
      "disabled",
    ]);
    expect(attrs[0]?.value.type).toBe("StringLiteral");
    expect(attrs[1]?.value.type).toBe("JSXExpressionContainer");
    expect(attrs[1]?.value.expression?.type).toBe("CallExpression");
    expect(attrs[2]?.value.expression?.type).toBe("BooleanLiteral");
    expect(attrs[2]?.value.expression?.value).toBe(true);
  });

  it("lowers a placeholder to an expression container", () => {
    const file = parseMx(`const el = <p>\${count()}</p>;`);
    const containers = collect(file, "JSXExpressionContainer");
    expect(containers).toHaveLength(1);
  });

  it("produces only standard Babel node types", () => {
    const file = parseMx(
      `const el = <button onClick() { go() }>hi \${x()}</button>;`,
    );
    const seen = new Set<string>();
    const visit = (node: unknown) => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      const record = node as Record<string, unknown>;
      if (typeof record.type === "string") seen.add(record.type);
      for (const key of Object.keys(record)) {
        if (key === "loc") continue;
        visit(record[key]);
      }
    };
    visit(file.program);
    for (const type of seen) {
      expect(type.startsWith("Mx")).toBe(false);
    }
    expect(seen.has("JSXElement")).toBe(true);
  });

  // --- criterion 8 safety cases ---

  it("(a) parses a TS generic arrow followed by an MX element", () => {
    const file = parseMx(`const id = <T,>(x: T) => x;\nconst el = <p>hi</p>;`);
    const arrows = collect(file, "ArrowFunctionExpression") as {
      typeParameters?: unknown;
    }[];
    // The `<T,>` must stay a generic arrow, not become an element.
    expect(arrows).toHaveLength(1);
    expect(arrows[0]?.typeParameters).toBeTruthy();
    expect(collect(file, "JSXElement")).toHaveLength(1);
  });

  it("(b) reports an unterminated MX tag as a positioned SyntaxError", () => {
    let error: unknown;
    try {
      parseMx(`const el = <button>oops;\n`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SyntaxError);
    const err = error as SyntaxError & {
      loc?: { line: number; index: number };
    };
    // A Babel error with a position inside the file, not an htmljs-parser
    // stack trace.
    expect(err.loc).toBeTruthy();
    expect(err.loc?.line).toBe(1);
    expect(err.stack).not.toContain("htmljs-parser");
  });

  it("(c) parses MX nested inside an attr method body", () => {
    const file = parseMx(
      `const el = <div onClick() { render(<span>x</span>) }>y</div>;`,
    );
    const elements = collect(file, "JSXElement") as {
      openingElement: { name: { name: string } };
    }[];
    expect(elements.map((e) => e.openingElement.name.name).sort()).toEqual([
      "div",
      "span",
    ]);
  });

  it("(d) parses two consecutive MX expressions with correct locations", () => {
    const source = `const a = <p>1</p>; const b = <p>2</p>;`;
    const file = parseMx(source);
    const elements = collect(file, "JSXElement") as {
      start: number;
      end: number;
      loc: { start: { column: number } };
    }[];
    expect(elements).toHaveLength(2);
    expect(source.slice(elements[0]?.start, elements[0]?.end)).toBe("<p>1</p>");
    // The second element's position must be right, which is what proves the
    // tokenizer was repositioned correctly after the first one closed.
    expect(source.slice(elements[1]?.start, elements[1]?.end)).toBe("<p>2</p>");
    expect(elements[1]?.loc.start.column).toBe(source.indexOf("<p>2"));
  });

  it("keeps locations correct across newlines", () => {
    const source = `const el = (\n  <div>\n    <span>x</span>\n  </div>\n);\nconst after = 1;\n`;
    const file = parseMx(source);
    const after = collect(file, "VariableDeclaration") as {
      loc: { start: { line: number } };
    }[];
    // `const after = 1;` is on line 6; getting there requires curLine and
    // lineStart to have been recomputed over the consumed MX region.
    expect(after[1]?.loc.start.line).toBe(6);
  });
});

describe("unsupported constructs raise a clear error", () => {
  const cases: [string, string, string][] = [
    [
      "attribute tag outside a tag body",
      `const el = <@header>x</@header>;`,
      "@tags must be nested within another element",
    ],
    [
      "raw placeholder mixed with other children",
      `const el = <p>x$!{raw}</p>;`,
      "raw placeholder must be the only child",
    ],
  ];

  for (const [name, source, expected] of cases) {
    it(`rejects ${name}`, () => {
      let error: unknown;
      try {
        parseMx(source);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(SyntaxError);
      expect((error as Error).message).toContain(expected);
    });
  }
});

/**
 * Round 2: defects found in the independent review of PR #5. Each test here
 * failed before its fix.
 */
describe("tokenizer repositioning (review #1)", () => {
  /** Finds the first node of `type`. */
  function find(node: unknown, type: string): Record<string, unknown> | null {
    if (node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = find(item, type);
        if (hit) return hit;
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    if (record.type === type) return record;
    for (const key of Object.keys(record)) {
      if (key === "loc") continue;
      const hit = find(record[key], type);
      if (hit) return hit;
    }
    return null;
  }

  const enclosing: [string, string, string][] = [
    ["arrow", `const f = () => <div>x</div>;`, "ArrowFunctionExpression"],
    ["return", `function g() { return <div>x</div>; }`, "ReturnStatement"],
    ["property", `const o = { a: <div>x</div> };`, "ObjectProperty"],
    [
      "conditional",
      `const c = t ? <div>x</div> : null;`,
      "ConditionalExpression",
    ],
  ];

  for (const [name, source, type] of enclosing) {
    it(`ends the enclosing ${name} at the closing tag`, () => {
      const file = parseMx(source);
      const node = find(file.program, type) as {
        start: number;
        end: number;
      } | null;
      expect(node).toBeTruthy();
      // Before the fix these ended at `<div`, because `next()` copied a stale
      // `endLoc` (still on the tag-name token) into `lastTokEndLoc`.
      const text = source.slice(node?.start, node?.end);
      expect(text).toContain("</div>");
    });
  }

  it("does not fake a preceding line break after multi-line MX", () => {
    // `hasPrecedingLineBreak` reads `lastTokEndLoc`; a stale value made every
    // multi-line element look like it ended with a newline, which silently
    // swallowed the missing semicolon here.
    let error: unknown;
    try {
      parseMx(`const x = <div>\n</div> foo`);
    } catch (err) {
      error = err;
    }
    expect((error as Error | undefined)?.message).toContain(
      "Missing semicolon",
    );
  });

  it("allows a real line break to continue the expression", () => {
    expect(() => parseMx(`const y = <div>\n</div>!.foo`)).not.toThrow();
  });
});

describe("error reporting (review #2, #3)", () => {
  it("throws rather than returning null under errorRecovery", () => {
    // `raise` returns instead of throwing when errorRecovery is on, and the
    // bridge has no node to hand back — returning null made Babel crash on
    // `expr.type`. Upstream Babel also throws on an unterminated JSX element
    // with errorRecovery on, so throwing matches it.
    for (const source of [
      `const a = <button>oops;`,
      // A raw placeholder mixed with other children is still unsupported, so
      // this keeps exercising the LowerError-to-SyntaxError conversion path
      // distinct from the htmljs-parser walk-error path the first case
      // covers. A dynamic tag name no longer serves: `<${Which}>x</>` lowers
      // now, to Solid's `<Dynamic>` (see the "bare placeholder" task).
      `const b = <p>x$!{raw}</p>;`,
    ]) {
      let error: unknown;
      try {
        parseSolid(source, "test.solid.mx", { errorRecovery: true });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(SyntaxError);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as SyntaxError & { loc?: unknown }).loc).toBeTruthy();
    }
  });

  it("reports the real error from inside a placeholder", () => {
    let error: unknown;
    try {
      parseMx(`const a = <p>\${a b}</p>;`);
    } catch (err) {
      error = err;
    }
    const err = error as SyntaxError & { loc?: { index: number } };
    // Not "placeholder is not supported yet" — the sub-parse's own message,
    // at the offending character inside the expression.
    expect(err.message).not.toContain("not supported yet");
    expect(err.loc?.index).toBe(17);
  });

  it("reports the real error from inside an attribute value", () => {
    let error: unknown;
    try {
      parseMx(`const b = <p x=(1 +)>y</p>;`);
    } catch (err) {
      error = err;
    }
    const err = error as SyntaxError & { loc?: { index: number } };
    expect(err.message).not.toContain("not supported yet");
    expect(err.loc?.index).toBe(19);
  });
});

describe("closing element range (review #4)", () => {
  it("spans the real closing tag", () => {
    const source = `const a = <div>x</div>;`;
    const file = parseMx(source);
    const element = collect(file, "JSXElement")[0] as {
      closingElement: {
        start: number;
        end: number;
        name: { start: number; end: number };
      };
    };
    const closing = element.closingElement;
    expect(source.slice(closing.start, closing.end)).toBe("</div>");
    expect(source.slice(closing.name.start, closing.name.end)).toBe("div");
  });
});

describe("whitespace follows Marko, not JSX (review #5)", () => {
  const childKinds = (source: string) => {
    const file = parseMx(source);
    const element = collect(file, "JSXElement")[0] as {
      children: { type: string; value?: string }[];
    };
    return element.children.map((child) =>
      child.type === "JSXText" ? `text:${child.value}` : child.type,
    );
  };

  it("drops a whitespace-only run containing a newline", () => {
    // Indented markup renders nothing between the two containers.
    expect(childKinds(`const a = <p>\n  \${x()}\n  \${y()}\n</p>;`)).toEqual([
      "JSXExpressionContainer",
      "JSXExpressionContainer",
    ]);
  });

  it("collapses a whitespace-only run without a newline to one space", () => {
    expect(childKinds(`const b = <p>\${x()} \${y()}</p>;`)).toEqual([
      "JSXExpressionContainer",
      "text: ",
      "JSXExpressionContainer",
    ]);
  });

  it("collapses internal runs and preserves boundary spaces", () => {
    expect(childKinds(`const c = <p>  hello   world  </p>;`)).toEqual([
      "text: hello world ",
    ]);
  });

  it("does not count comments as content when preserving spaces", () => {
    expect(childKinds(`const d = <p><!-- c --> hello <!-- e --></p>;`)).toEqual(
      ["text: hello "],
    );
  });

  describe("line-based rule (decision 33)", () => {
    // Lines are trimmed, empties dropped, the rest joined with one space.
    it("joins multi-line prose with a single space", () => {
      expect(childKinds(`const e = <p>a\n  b</p>;`)).toEqual(["text:a b"]);
    });

    it("joins three lines, collapsing each line's own indentation", () => {
      expect(childKinds(`const f = <p>\n  a\n  b\n  c\n</p>;`)).toEqual([
        "text:a b c",
      ]);
    });

    it("keeps the collapsed separator before a sibling element", () => {
      expect(
        childKinds(`const g = <div>\n  static\n  <span>s</span></div>;`),
      ).toEqual(["text:static ", "JSXElement"]);
    });

    it("keeps the collapsed separator after a sibling element", () => {
      expect(
        childKinds(`const h = <div><span>s</span>\n  static\n</div>;`),
      ).toEqual(["JSXElement", "text: static"]);
    });

    it("still drops a whitespace-only run containing a newline", () => {
      expect(
        childKinds(`const i = <div><span>a</span>\n  <span>b</span></div>;`),
      ).toEqual(["JSXElement", "JSXElement"]);
    });

    it("keeps the spaces around an inline element in indented markup", () => {
      // Only edges that abut a line break are trimmed. The spaces around
      // `<b>` are mid-line, so they survive; the run's outer edges go to the
      // boundary trim. Trimming both ends of every line deleted them and
      // rendered `Hello<b>x</b>world.`
      expect(
        childKinds(`const m = <p>\n  Hello <b>x</b> world.\n</p>;`),
      ).toEqual(["text:Hello ", "JSXElement", "text: world."]);
    });

    it("keeps a single mid-line space around an inline element", () => {
      expect(childKinds(`const n = <p>\n  a <b>x</b> c\n</p>;`)).toEqual([
        "text:a ",
        "JSXElement",
        "text: c",
      ]);
    });

    it("collapses indentation before a sibling to one separator", () => {
      expect(
        childKinds(`const o = <div>\n  static\n  <span>s</span></div>;`),
      ).toEqual(["text:static ", "JSXElement"]);
    });

    it("keeps interior spaces in a single-line run between placeholders", () => {
      // `${i}: ${text}` renders ": ", not ":". Line trimming applies only
      // where a trim point abuts a line break, and a single-line run has
      // none, so its typed spaces survive. `fixtures/todos` and
      // `fixtures/lists` both depend on this.
      expect(childKinds(`const l = <li>\${i}: \${t()}</li>;`)).toEqual([
        "JSXExpressionContainer",
        "text:: ",
        "JSXExpressionContainer",
      ]);
    });

    it("keeps a deliberate same-line space between elements", () => {
      expect(
        childKinds(`const j = <div><span>a</span> <span>b</span></div>;`),
      ).toEqual(["JSXElement", "text: ", "JSXElement"]);
    });

    it("keeps the explicit-space placeholder working across a line break", () => {
      expect(
        childKinds(`const k = <p>a\${" "}\n  b</p>;`).filter(
          (c) => c !== "JSXExpressionContainer",
        ),
      ).toEqual(["text:a", "text: b"]);
    });
  });
});

describe("void elements (review #6)", () => {
  it("parses a void tag written without a slash", () => {
    const file = parseMx(`const a = <input value=x>;`);
    const element = collect(file, "JSXElement")[0] as {
      openingElement: { selfClosing: boolean };
      closingElement: unknown;
      children: unknown[];
    };
    expect(element.openingElement.selfClosing).toBe(true);
    expect(element.closingElement).toBeNull();
    expect(element.children).toHaveLength(0);
  });

  it("does not let a void tag swallow its siblings' closing tags", () => {
    const file = parseMx(`const b = <div><input value=x><br>after</div>;`);
    const names = (
      collect(file, "JSXElement") as {
        openingElement: { name: { name: string } };
      }[]
    ).map((element) => element.openingElement.name.name);
    expect(names.sort()).toEqual(["br", "div", "input"]);
  });

  it("rejects a void tag with a closing tag", () => {
    let error: unknown;
    try {
      parseMx(`const c = <input>oops</input>;`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toContain("void element");
  });
});

describe("collectMxRegions", () => {
  it("collects the boundaries of MX regions and fragments", () => {
    const source = `const a = <div>x</div>; const b = <><p>1</p><p>2</p></>;`;
    const regions = collectMxRegions(source, "test.solid.mx");
    expect(regions).toEqual([
      { start: 10, end: 22 },
      { start: 36, end: 44 },
      { start: 44, end: 52 },
    ]);
  });

  it("collects a region reached through a nested expression position (a call argument)", () => {
    const source = `const c = f(<p>x</p>);`;
    const regions = collectMxRegions(source, "test.solid.mx");
    expect(regions).toEqual([{ start: 12, end: 20 }]);
  });
});
