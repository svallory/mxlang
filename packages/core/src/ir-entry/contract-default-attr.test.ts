/**
 * A contract `default` on a contract-only tag, through `lowerSource`. The
 * defaulted attribute was never written, so it has no source of its own; the
 * IR still promises every attribute a span (`SpannedIr`), and the span
 * invariant used to reject it ("IR invariant broken — attribute carries no
 * span"). It now carries a zero-width span at the end of the tag's name.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomTag, TagCall } from "../custom-tags.ts";
import type { DelegatedTag } from "../ir.ts";
import { clearScanCache, scanCached } from "../scan-cache.ts";
import { clearTagFileCache } from "../tag-file.ts";
import { dialectProject } from "../test-dialect-project.ts";
import { testTargetLookup } from "../test-targets.ts";
import { type LowerSourceOptions, lowerSource, type Spanned } from "./index.ts";

const targets = testTargetLookup();

const BOX: CustomTag = {
  attributes: {
    size: { type: "string", default: "s" },
    n: { type: "number", default: 3 },
    on: { type: "boolean", default: true },
  },
};

function tagOf(
  result: ReturnType<typeof lowerSource>,
  index = 0,
): Spanned<DelegatedTag> {
  const node = result.ir?.body[index];
  expect(node?.kind).toBe("DelegatedTag");
  return (node as unknown as { tag: Spanned<DelegatedTag> }).tag;
}

/** Every attribute as the fields a consumer reads, spans included. */
function attrsOf(tag: Spanned<DelegatedTag>) {
  return tag.attrs.map((attr) => {
    if (attr.kind === "spread") return { kind: "spread", span: attr.span };
    return {
      kind: attr.kind,
      name: attr.name,
      nameSpan: attr.nameSpan,
      span: attr.span,
      ...(attr.kind === "static"
        ? { value: attr.value, valueSpan: attr.valueSpan }
        : attr.kind === "boolean"
          ? {}
          : { code: attr.value.code, valueSpan: attr.value.span }),
    };
  });
}

const at = (offset: number) => ({ sourceStart: offset, sourceEnd: offset });

/** `<box/>`: the name ends at offset 4. */
const DEFAULTED_AT_4 = [
  {
    kind: "static",
    name: "size",
    nameSpan: at(4),
    span: at(4),
    value: "s",
    valueSpan: at(4),
  },
  {
    kind: "dynamic",
    name: "n",
    nameSpan: at(4),
    span: at(4),
    code: "3",
    valueSpan: at(4),
  },
  {
    kind: "dynamic",
    name: "on",
    nameSpan: at(4),
    span: at(4),
    code: "true",
    valueSpan: at(4),
  },
];

describe("customTags: a contract default on a contract-only tag", () => {
  it.each(["allow", "reject"] as const)(
    "lowers without an invariant error, unknownTags %s",
    (unknownTags) => {
      const result = lowerSource("<box/>\n", "/t.mx", {
        customTags: { box: BOX },
        unknownTags,
      });
      expect(result.diagnostics).toEqual([]);
      expect(attrsOf(tagOf(result))).toEqual(DEFAULTED_AT_4);
    },
  );

  it("spans each defaulted attribute zero-width at the end of the tag's name, whatever the body", () => {
    const result = lowerSource("<box>\n  <box/>\n</box>\n", "/t.mx", {
      customTags: { box: BOX },
    });
    expect(result.diagnostics).toEqual([]);
    const outer = tagOf(result);
    expect(attrsOf(outer)).toEqual(DEFAULTED_AT_4);
    const inner = outer.children[0] as unknown as {
      tag: Spanned<DelegatedTag>;
    };
    // `<box>\n  <box/>`: the inner name ends at offset 12.
    expect(attrsOf(inner.tag).map((attr) => attr.span)).toEqual([
      at(12),
      at(12),
      at(12),
    ]);
  });

  it("lowers under the `none` tag rules too", () => {
    const none = lowerSource("<box/>\n", "/t.mx", {
      customTags: { box: BOX },
      tagRules: "none",
    });
    expect(none.diagnostics).toEqual([]);
    expect(attrsOf(tagOf(none))).toEqual(DEFAULTED_AT_4);
  });

  it("keeps an attribute the author wrote on its own span, defaulting only the rest", () => {
    // `<box size="m"/>`: `size` 5-9, the quoted value 10-13, the name ends at 4.
    const result = lowerSource('<box size="m"/>\n', "/t.mx", {
      customTags: { box: BOX },
    });
    expect(result.diagnostics).toEqual([]);
    const [size, ...defaulted] = attrsOf(tagOf(result));
    expect(size).toEqual({
      kind: "static",
      name: "size",
      nameSpan: { sourceStart: 5, sourceEnd: 9 },
      span: { sourceStart: 5, sourceEnd: 13 },
      value: "m",
      valueSpan: { sourceStart: 10, sourceEnd: 13 },
    });
    expect(defaulted.map((attr) => attr.name)).toEqual(["n", "on"]);
    expect(defaulted.map((attr) => attr.span)).toEqual([at(4), at(4)]);
  });

  it("writes nothing for a default the author overrides", () => {
    const result = lowerSource('<box size="x" n=2 on=false/>\n', "/t.mx", {
      customTags: { box: BOX },
    });
    expect(result.diagnostics).toEqual([]);
    expect(
      tagOf(result).attrs.map((attr) =>
        attr.kind === "spread" ? "..." : attr.name,
      ),
    ).toEqual(["size", "n", "on"]);
    for (const attr of tagOf(result).attrs) {
      expect(attr.span.sourceStart).toBeGreaterThan(4);
    }
  });

  it("names the tag a non-literal default is declared on, inside the document", () => {
    const result = lowerSource("\n<box/>\n", "/t.mx", {
      customTags: {
        box: { attributes: { size: { type: "string", default: ["s"] } } },
      },
    });
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        line: 2,
        column: 0,
        offset: 1,
        message: expect.stringContaining("attribute `size`"),
      }),
    ]);
  });
});

describe("a tag with a transform: its defaulted attribute is unchanged", () => {
  it("is handed to the transform without a span, and lowering succeeds", () => {
    const seen: Array<{ name: string; span: unknown }> = [];
    const result = lowerSource("<box/>\n", "/t.mx", {
      customTags: {
        box: {
          attributes: { n: { type: "number", default: 3 } },
          transform(call: TagCall) {
            for (const attr of call.attrs) {
              if (attr.kind === "dynamic") {
                seen.push({ name: attr.name, span: attr.value.span });
              }
            }
            return [];
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    expect(seen).toEqual([{ name: "n", span: undefined }]);
  });
});

describe("a dialect tag file's contract default", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-contract-default-")));
    clearScanCache();
    clearTagFileCache();
  });
  afterEach(() => {
    clearScanCache();
    clearTagFileCache();
    rmSync(dir, { recursive: true, force: true });
  });

  function lowerWithHook(source: string, unknownTags: "allow" | "reject") {
    dialectProject(dir, {
      packageName: "kit-dialect",
      manifest: {
        id: "kit",
        name: "Kit",
        extensions: [".kit.mx"],
        tagDirs: ["concepts"],
      },
      module: `
export default {
  table: {},
  tagFile() {
    return {
      contract: { attributes: { size: { type: "string", default: "s" } } },
      diagnostics: [],
    };
  },
};
`,
    });
    mkdirSync(join(dir, "concepts"), { recursive: true });
    writeFileSync(join(dir, "concepts", "box.kit.mx"), "\n");
    const file = join(dir, "page.kit.mx");
    const options: LowerSourceOptions = {
      customTags: scanCached(file, { targets }).customTags,
      unknownTags,
    };
    return lowerSource(source, file, options);
  }

  it.each(["allow", "reject"] as const)(
    "lowers with the default spanned at the tag's name end, unknownTags %s",
    (unknownTags) => {
      const result = lowerWithHook("<box/>\n", unknownTags);
      expect(result.diagnostics).toEqual([]);
      expect(attrsOf(tagOf(result))).toEqual([DEFAULTED_AT_4[0]]);
    },
  );
});
