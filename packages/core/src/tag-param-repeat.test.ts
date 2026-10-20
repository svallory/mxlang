// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX templates
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { DYNAMIC_TAG } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lowerSource } from "./ir-entry/index.ts";
import type { TemplateBackedTag } from "./template-tag.ts";
import { lookup } from "./test-targets.ts";

const dir = mkdtempSync(join(tmpdir(), "mx-tag-param-repeat-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "Foo.mx"), "<return=1/>");
const page = join(dir, "page.mx");
const host: HostDeclarations = {
  name: "tag-param-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: (name) => /^[A-Z]/.test(name),
  isDelegatedTag: (name) => name === "await" || name === "try",
  resolveDelegatedTag: () => ({}),
};
const customTags: Record<string, TemplateBackedTag> = {
  foo: { template: { filename: join(dir, "Foo.mx"), source: "<return=1/>" } },
};
function compile(source: string) {
  return compileSource(source, page, host, {
    targets: lookup,
    customTags,
    emitIr: () => "",
  });
}

describe("a declaration cannot repeat its enclosing tag's body params", () => {
  it.each([
    ["<try><@catch|e|><const/e=1/>${e}</@catch>x</try>", "e", 1, 23, "@catch"],
    [
      'import Foo from "./Foo.mx"\n<Foo|x|><const/x=1/></Foo>',
      "x",
      2,
      15,
      "Foo",
    ],
    ["<foo|x|><const/x=1/></foo>", "x", 1, 15, "foo"],
    ["<await|v|=p><const/v=1/></await>", "v", 1, 19, "await"],
    ["<await|{v}|=p><const/v=1/></await>", "v", 1, 21, "await"],
    ["<${input.t}|x|><const/x=1/></>", "x", 1, 22, "dynamic tag"],
  ])("refuses %s at its repeated name", (source, name, line, column, owner) => {
    expect(() => compile(source)).toThrowError(
      expect.objectContaining({
        diagnosticCode: "MX_DUPLICATE_DECLARATION",
        message: `Duplicate declaration of \`${name}\`: it is already a parameter of the enclosing \`<${owner}>\`. Rename one of them.`,
        line,
        column,
      }),
    );
  });
  it("names a delegated dynamic tag without exposing its sentinel", () => {
    expect(() =>
      compileSource(
        "<${input.t}|x|><const/x=1/></>",
        page,
        {
          ...host,
          isDelegatedTag: (name) => name === DYNAMIC_TAG,
        },
        {
          targets: lookup,
          emitIr: () => "",
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        diagnosticCode: "MX_DUPLICATE_DECLARATION",
        message:
          "Duplicate declaration of `x`: it is already a parameter of the enclosing `<dynamic tag>`. Rename one of them.",
        line: 1,
        column: 22,
      }),
    );
  });
  it.each([
    "<try><@catch|e|><div><const/e=1/></div></@catch>x</try>",
    'import Foo from "./Foo.mx"\n<Foo|x|><div><const/x=1/></div></Foo>',
    "<foo|x|><div><const/x=1/></div></foo>",
    "<await|v|=p><div><const/v=1/></div></await>",
    "<await|v|=p>x</await><const/v=1/>",
    "<for|input| of=[1]>${input}</for>",
  ])("keeps nested/sibling scopes and input params: %s", (source) => {
    expect(() => compile(source)).not.toThrow();
  });
  it.each([
    "<await|v|=p><const/v=1/></await>",
    'import Foo from "./Foo.mx"\n<Foo|x|><const/x=1/></Foo>',
    "<try><@catch|e|><const/e=1/>${e}</@catch>x</try>",
  ])(
    "does not introduce a param-duplicate diagnostic under none: %s",
    (source) => {
      expect(
        lowerSource(source, page, { tagRules: "none" }).diagnostics.map(
          ({ code }) => code,
        ),
      ).not.toContain("MX_DUPLICATE_DECLARATION");
    },
  );
});
