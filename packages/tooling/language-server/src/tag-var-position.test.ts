/**
 * A `/var` that cannot bind is reported on the variable, not at the start of
 * the tag: the editor underlines `x` in `<box/x/>`, so the squiggle sits on
 * the thing to remove. Two causes are covered here: a tag with no template (an
 * L2 sidecar) and an imported `.mx` unit that cannot be read. The positions
 * match the "declares no `<return>`" error beside them.
 */
import { pathToFileURL } from "node:url";
import type { CustomTag } from "@mxlang/core";
import { defaultTarget, hostOf } from "@mxlang/targets";
import { describe, expect, it } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

const target = defaultTarget();
const policy = { target, host: hostOf(target) };
const sidecar: CustomTag = {
  transform: (call) => call.content?.children ?? [],
};

function one(
  source: string,
  uri: string,
  tags: Record<string, CustomTag> = {},
) {
  const diagnostics = diagnoseDocument(
    source,
    uri,
    policy,
    undefined,
    "",
    tags,
  );
  expect(diagnostics).toHaveLength(1);
  return diagnostics[0];
}

const PAGE = pathToFileURL("/project/page.mx").href;

describe("a /var on a tag with no template, in the editor", () => {
  it.each([
    ["plain", "<box/x/>\n", [0, 5, 0, 6]],
    ["shorthand", "<box.cls#id/x/>\n", [0, 12, 0, 13]],
    ["type arguments", "<box<string>/x/>\n", [0, 13, 0, 14]],
    ["a multi-line destructuring", "<box/{\n  a,\n  b,\n}/>\n", [0, 5, 3, 1]],
  ])("underlines the variable: %s", (_label, source, [sl, sc, el, ec]) => {
    const diagnostic = one(source, PAGE, { box: sidecar });
    expect(diagnostic?.code).toBe("MX_INVALID_TAG_VAR");
    expect(diagnostic?.message).toMatch(/it has no template/);
    expect(diagnostic?.range).toEqual({
      start: { line: sl, character: sc },
      end: { line: el, character: ec },
    });
  });
});

describe("a /var on an imported unit that cannot be read, in the editor", () => {
  it.each([
    ["plain", "<M/n/>", [1, 3, 1, 4]],
    ["shorthand", "<M.cls#id/n/>", [1, 10, 1, 11]],
    ["a multi-line destructuring", "<M/{\n  a,\n  b,\n}/>", [1, 3, 4, 1]],
  ])("underlines the variable: %s", (_label, call, [sl, sc, el, ec]) => {
    const diagnostic = one(`import M from "./missing.mx"\n${call}\n`, PAGE);
    expect(diagnostic?.code).toBe("MX_INVALID_TAG_VAR");
    expect(diagnostic?.message).toMatch(/on `<M>` can't bind: /);
    expect(diagnostic?.range).toEqual({
      start: { line: sl, character: sc },
      end: { line: el, character: ec },
    });
  });
});

describe("the same /var inside a .preact.mx region, at its file position", () => {
  const URI = pathToFileURL("/project/Panel.preact.mx").href;
  const head = "export function Panel() {\n  return (\n    ";
  const tail = "\n  );\n}\n";

  it("underlines a sidecar call's variable", () => {
    const diagnostic = one(`${head}<box/x/>${tail}`, URI, { box: sidecar });
    expect(diagnostic?.code).toBe("MX_INVALID_TAG_VAR");
    expect(diagnostic?.range).toEqual({
      start: { line: 2, character: 9 },
      end: { line: 2, character: 10 },
    });
  });

  it("underlines an unreadable import's variable", () => {
    const diagnostic = one(
      `import M from "./missing.mx";\n${head}<M/n/>${tail}`,
      URI,
    );
    expect(diagnostic?.code).toBe("MX_INVALID_TAG_VAR");
    expect(diagnostic?.range).toEqual({
      start: { line: 3, character: 7 },
      end: { line: 3, character: 8 },
    });
  });
});
