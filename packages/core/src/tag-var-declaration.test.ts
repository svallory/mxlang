// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source snippets
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lookup } from "./test-targets.ts";

const host: HostDeclarations = {
  name: "tag-var-test",
  attrTags: 2,
  tags: {},
  isElement: (name) => name !== "foo",
  isComponent: (name) => name === "foo",
  isBuiltinTag: (name) => name === "let" || name === "id",
  isDelegatedTag: (name) =>
    name === "let" || name === "id" || name === "script",
  resolveDelegatedTag: () => ({}),
  resolveAttributeMethod: () => true,
};
function compile(source: string) {
  return compileSource(source, "/page.mx", host, {
    targets: lookup,
    emitIr: () => "",
  } as never);
}
function refusal(
  source: string,
  code: string,
  needle?: string,
  offset?: number,
) {
  let failure: TranslateError | undefined;
  try {
    compile(source);
  } catch (error) {
    failure = error as TranslateError;
  }
  expect(failure, source).toBeDefined();
  expect(failure?.diagnosticCode, failure?.message).toBe(code);
  if (needle) expect(failure?.message).toContain(needle);
  if (offset !== undefined) {
    const lines = source.slice(0, offset).split("\n");
    expect({ line: failure?.line, column: failure?.column }).toEqual({
      line: lines.length,
      column: lines.at(-1)?.length ?? 0,
    });
  }
}

describe("tag variable self-read", () => {
  it.each([
    ["<const/x=x+1/>", "x+1"],
    ["<let/x=x/>", "x/>"],
    ["<const/{a}={a:a}/>", "a}/>"],
    ["<const/{a,b}={a:1, b:a}/>", "a}/>"],
    ["<const/x=input.x ?? x/>", "x/>"],
    ["<const/x=1/><div><const/x=x+1/>${x}</div>", "x+1"],
    ["<for|a| of=items><li><const/a=a/>${a}</li></for>", "a/>"],
    ["<define/D|a|><div><const/a=a/>${a}</div></define>", "a/>"],
    ["<define/D a=D/>", "D/>"],
    ["<const/x=class { method() { return x } }/>", "x }"],
    ["<const/x={ [x]: 1 }/>", "x]:"],
    ["<const/x=(() => x)()/>", "x)"],
    ["<const/x=(function () { return x })()/>", "x }"],
    ["<const/x=[1].map(() => x)/>", "x)"],
    ["<const/x=(() => x).call()/>", "x)"],
    ["<let/x=(() => x)()/>", "x)"],
    ["<const/fn=input.wrap(() => fn)/>", "fn)"],
    ["<const/x=input.wrap?.(() => x)/>", "x)"],
    ["<const/x=new (function () { return x })()/>", "x }"],
  ])("refuses %s at its read", (source, read) => {
    refusal(
      source,
      "MX_TAG_VAR_SELF_READ",
      "own attributes cannot read it",
      source.indexOf(read),
    );
  });
  it.each([
    "<const/f=() => f()/>",
    "<const/x=() => [1].map(() => x)/>",
    "<const/x=async () => x/>",
    "<const/x=() => new (function () { return x })()/>",
    "<const/f={ g: () => f }/>",
    "<const/f={ g() { return f } }/>",
    "<let/x=1 valueChange(v) { x = v }/>",
    "<let/x=1 valueChange=(v) => { x = v }/>",
    "<const/x=input.x/>",
    "<const/x={x: 1}/>",
  ])("accepts %s", (source) => expect(() => compile(source)).not.toThrow());
  it.each(["<let/count=(count = 1)/>", "<let/count=(count++)/>"])(
    "keeps render-write precedence: %s",
    (source) => {
      refusal(source, "MX_LET_WRITE_IN_RENDER");
    },
  );
});

describe("same-body tag variable declarations", () => {
  it.each([
    "<const/x=1/><const/x=2/>",
    "<let/x=0/>\n<let/x=1/>",
    "<const/x=1/><let/x=2/>",
    "<let/x=1/><const/x=2/>",
    "<div><const/x=1/><const/x=2/></div>",
    "<if=true><const/x=1/><const/x=2/></if>",
    "<define/x>a</define>\n<define/x>b</define>",
    "<define/x>a</define>\n<const/x=1/>",
    "<const/x=1/><define/x>a</define>",
    "<const/{x}=input/>\n<const/{x}=input/>",
    "<const/{x}=input/>\n<const/x=1/>",
    "<const/x=1/>\n<const/{a,x}=input/>",
    "<const/x=1/><id/x/>",
    "<id/x/><id/x/>",
  ])("refuses %s at the second name", (source) => {
    const second = source.lastIndexOf("x");
    // A define's closing tag contains no variable name.
    refusal(
      source,
      "MX_DUPLICATE_DECLARATION",
      "Duplicate declaration of `x`",
      second,
    );
  });
  it.each([
    "<for|x| of=[1]><const/x=1/></for>",
    "<for|x| of=[1]><let/x=1/></for>",
    "<define/D|x|><const/x=1/></define>",
    "<define/D|{x}|><let/x=1/></define>",
  ])("refuses a declaration repeating its body param: %s", (source) =>
    refusal(source, "MX_DUPLICATE_DECLARATION", "enclosing"),
  );
  it.each([
    "<const/x=1/><div><let/x=2/>${x}</div>",
    "<div><const/x=1/></div><div><const/x=2/></div>",
    "<if=true><const/x=1/></if><else><const/x=2/></else>",
    "<if=true><const/x=1/></if>\n<const/x=2/>",
    "<const/x=1/>\n<script>const x = 2</script>",
    "<for|input| of=[1]>${input}</for>",
    "<for|x| of=[1]><div><const/x=1/></div></for>",
    "<define/D|x|><div><const/x=1/></div></define>",
    "<define/D|x|><if=true><const/x=1/></if></define>",
  ])("keeps separate scopes: %s", (source) =>
    expect(() => compile(source)).not.toThrow(),
  );
});

describe("define reads before declaration", () => {
  it.each([
    "<${D}/>\n<define/D>x</define>",
    "${D}\n<define/D>x</define>",
    "<const/s=D/>\n<define/D>x</define>",
    "<div attr=D/>\n<define/D>x</define>",
    "<${D.content}/>\n<define/D>x</define>",
    "<if=true><${D}/><define/D>x</define></if>",
    "<div>${D}</div><define/D>x</define>",
    "<const/D=1/><div>${D}<define/D>x</define></div>",
    "<div><define/D>x</define></div>${D}<define/D>y</define>",
    "<script>console.log(D)</script><define/D>x</define>",
  ])("refuses %s at D", (source) => {
    const placeholder = source.indexOf("${D}");
    const read = placeholder >= 0 ? placeholder + 2 : source.indexOf("D");
    refusal(
      source,
      "MX_DEFINE_READ_BEFORE_DECLARATION",
      "above this read",
      read,
    );
  });
  it.each([
    "<define/D>${D}</define>",
    "<define/D>x</define><${D}/>",
    "<define/D>x</define><div>${D}</div>",
    "<define/D>x</define><div><define/D>y</define>${D}</div>${D}",
    "<div><define/D>x</define></div><define/D>y</define>",
    "<script>const D = 1; console.log(D)</script><define/D>x</define>",
    "<define/D>x</define><script>console.log(D)</script>",
    "<for|D| of=[1]><script>console.log(D)</script></for><define/D>x</define>",
    "<div><const/D=1/><script>console.log(D)</script></div><define/D>x</define>",
  ])("accepts %s", (source) => expect(() => compile(source)).not.toThrow());
  it("keeps bare component lookup refusal", () =>
    refusal("<D/><define/D>x</define>", "MX_UNBOUND_COMPONENT"));
});

describe("named-call argument check order", () => {
  it.each([
    "<foo(a)><if=c><@x/>text</if></foo>",
    "<foo(a, b)><if=c><@x/>text</if></foo>",
    "<foo(a, b)><if=c><for|i| of=items><@x/>text</for></if></foo>",
  ])("reports body mix before arguments: %s", (source) =>
    refusal(
      source,
      "MX_INVALID_ATTRIBUTE_TAG",
      "Cannot have attribute tags and body content",
      source.indexOf("text"),
    ),
  );
  it("keeps a plain single argument", () =>
    expect(() => compile("<foo(a)/>")).not.toThrow());
  it("keeps refusing an attribute tag beside a single argument", () =>
    refusal("<foo(a)><@x/></foo>", "MX_UNSUPPORTED_TAG_ARGUMENTS"));
});

describe("const initializer self-write", () => {
  it.each([
    "<const/x=() => { x = 1 }/>",
    "<const/x={ g() { x = 1 } }/>",
    "<const/x=() => { x++ }/>",
    "<const/x=() => { [x] = [1] }/>",
  ])("refuses %s", (source) =>
    refusal(source, "MX_READONLY_BINDING_WRITE", "cannot be written"),
  );
  it.each([
    "<const/x=() => { let x; x = 1 }/>",
    "<const/{x}={x: () => { x = 1 }}/>",
    "<let/x=() => { x = 1 }/>",
  ])("accepts %s", (source) => expect(() => compile(source)).not.toThrow());
});
