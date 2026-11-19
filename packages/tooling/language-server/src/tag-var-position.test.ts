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

// An element reference (`<div/el>`, or `<${"my-el"}/el>` on a literal dynamic
// tag) is read only in a `<script>` or an `on…`
// handler. The language server reports MX diagnostics only (hover and
// completion on `el()` come from the TypeScript plugin), so a valid use is
// clean and a read in the template is refused on the read's `el`, at its
// file position inside a region.
describe("an element reference, in the editor", () => {
  const hosts = [
    ["preact-jsx", "preact"],
    ["react-jsx", "react"],
    ["solid-jsx", "solid"],
  ] as const;

  const use = "<div/el/><button onClick() { el().focus() }>go</button>\n";
  const region =
    "export const view = <section><div/el/><button onClick() { el().focus() }>go</button></section>;\n";
  const dynamicUse =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    '<${"my-el"}/el/><button onClick() { el().focus() }>go</button>\n';
  const dynamicRegion =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    'export const view = <section><${"my-el"}/el/><button onClick() { el().focus() }>go</button></section>;\n';

  it.each(
    hosts.flatMap(([target, host]) => [
      [target, "page.mx", use],
      [target, `view.${host}.mx`, region],
      [target, "dyn.mx", dynamicUse],
      [target, `dyn.${host}.mx`, dynamicRegion],
    ]),
  )("accepts a handler's read on %s in %s", (target, name, source) => {
    const uri = pathToFileURL(`/project/${name}`).href;
    expect(diagnoseDocument(source, uri, { target })).toEqual([]);
  });

  it.each(
    hosts.flatMap(([target, host]) => [
      [
        target,
        "<div/el>",
        host,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
        "export const view = <section><div/el/><p>${el()}</p></section>;\n",
        [0, 43, 0, 45],
      ],
      [
        target,
        '<${"my-el"}/el>',
        host,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
        'export const view = <section><${"my-el"}/el/><p>${el()}</p></section>;\n',
        [0, 50, 0, 52],
      ],
    ]),
  )(
    "refuses a template read in a %s region of %s at the read",
    (target, _form, host, source, [sl, sc, el, ec]) => {
      const [diagnostic, ...rest] = diagnoseDocument(
        source,
        pathToFileURL(`/project/view.${host}.mx`).href,
        { target },
      );
      expect(rest).toEqual([]);
      expect(diagnostic?.code).toBe("MX_INVALID_TAG_VAR");
      expect(diagnostic?.message).toBe(
        "`el` is an element reference. Element references can only be read in scripts and event handlers.",
      );
      expect(diagnostic?.range).toEqual({
        start: { line: sl, character: sc },
        end: { line: el, character: ec },
      });
    },
  );
});
