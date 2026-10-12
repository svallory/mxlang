/**
 * A tag a host does not support in embedded MX is one sentence, built by core
 * from what the host supplies: its display name (`hostName`) and an optional
 * hint. No host package is involved here, and core names no host: every name
 * below is invented by the test.
 */
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lookup } from "./test-targets.ts";

function host(
  tags: HostDeclarations["tags"],
  hostName?: string,
): HostDeclarations {
  return {
    name: "@fake/host",
    ...(hostName === undefined ? {} : { hostName }),
    attrTags: 2,
    tags,
    isElement: () => true,
    isComponent: () => false,
    isDelegatedTag: () => false,
    resolveAttributeMethod: () => true,
  };
}

function thrown(
  declarations: HostDeclarations,
  source: string,
  productName?: string,
): TranslateError {
  try {
    compileSource(source, "/page.mx", declarations, {
      targets: lookup,
      emitIr: () => "",
      ...(productName === undefined ? {} : { productName }),
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  throw new Error("expected an error");
}

describe("core composes the sentence from the host's name and hint", () => {
  const withHint = host(
    {
      widget: { kind: "unsupported", hint: "Use the gadget runtime instead." },
    },
    "Zork",
  );

  it("name plus hint: two sentences, exact text, code and position", () => {
    const error = thrown(withHint, "<widget/>");
    expect(error.message).toBe(
      "`<widget>` is not supported in embedded MX on Zork. Use the gadget runtime instead.",
    );
    expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.end).toEqual({ line: 1, column: 7 });
  });

  it("is positioned at the tag name of a nested tag", () => {
    const error = thrown(withHint, "<if=x>\n  <widget>body</widget>\n</if>\n");
    expect([error.line, error.column]).toEqual([2, 2]);
    expect(error.end).toEqual({ line: 2, column: 9 });
  });

  it("no hint: the first sentence alone", () => {
    const bare = host({ widget: { kind: "unsupported" } }, "Zork");
    expect(thrown(bare, "<widget/>").message).toBe(
      "`<widget>` is not supported in embedded MX on Zork.",
    );
  });

  it("an empty hint adds nothing", () => {
    const empty = host({ widget: { kind: "unsupported", hint: "" } }, "Zork");
    expect(thrown(empty, "<widget/>").message).toBe(
      "`<widget>` is not supported in embedded MX on Zork.",
    );
  });

  it("the name is whatever the host says, not a name core knows", () => {
    for (const name of ["Quux", "Other Host 2"]) {
      const declarations = host({ widget: { kind: "unsupported" } }, name);
      expect(thrown(declarations, "<widget/>").message).toBe(
        `\`<widget>\` is not supported in embedded MX on ${name}.`,
      );
    }
  });

  it('a host with no display name gets no " on <Host>"', () => {
    const anonymous = host(
      { widget: { kind: "unsupported", hint: "Do it differently." } },
      undefined,
    );
    expect(thrown(anonymous, "<widget/>").message).toBe(
      "`<widget>` is not supported in embedded MX. Do it differently.",
    );
  });

  it("the product the caller runs under replaces `MX`", () => {
    expect(thrown(withHint, "<widget/>", "Lang").message).toBe(
      "`<widget>` is not supported in embedded Lang on Zork. Use the gadget runtime instead.",
    );
  });

  it("the tag in the sentence is the tag written, in every form", () => {
    for (const source of [
      "<widget>x</widget>",
      '<widget foo="bar"/>',
      "<widget/x/>",
      "<widget=1/>",
    ]) {
      expect(thrown(withHint, source).message).toMatch(
        /^`<widget>` is not supported in embedded MX on Zork\. /,
      );
    }
  });

  it("a row's own code replaces the default", () => {
    const coded = host(
      { widget: { kind: "unsupported", code: "MX_INERT_TAG_SHAPE" } },
      "Zork",
    );
    const error = thrown(coded, "<widget/>");
    expect(error.diagnosticCode).toBe("MX_INERT_TAG_SHAPE");
    expect(error.message).toBe(
      "`<widget>` is not supported in embedded MX on Zork.",
    );
  });
});

describe("`effect` takes the same sentence, with no hint and no fix-it", () => {
  const row = host({ effect: { kind: "unsupported" } }, "Zork");

  it.each([
    ["bodied", "<effect>go()</effect>"],
    ["self-closing", "<effect/>"],
    ["with a method", "<effect() { go() }/>"],
  ])("%s", (_name, source) => {
    const error = thrown(row, source);
    expect(error.message).toBe(
      "`<effect>` is not supported in embedded MX on Zork.",
    );
    expect(error.message).not.toContain("Use `<script>`");
    expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.end).toEqual({ line: 1, column: 7 });
  });
});

describe("a row of kind `error` still raises its own text", () => {
  it("the reason verbatim, the default code, no composed sentence", () => {
    const declarations = host(
      { widget: { kind: "error", reason: "the host's own words" } },
      "Zork",
    );
    const error = thrown(declarations, "<widget/>");
    expect(error.message).toBe("the host's own words");
    expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
  });
});
