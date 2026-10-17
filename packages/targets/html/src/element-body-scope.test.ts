// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A native element's body is its own scope for a tag variable. Marko 6.4.4
 * (probed on the stock parser) compiles `<let/count=1/><div><const/count=2/>
 * ${count}</div>${count}` with the read inside the `<div>` bound to the inner
 * `count` and the read after it bound to the outer one, the way a `<for>`,
 * `<if>`, `<try>` or `<define>` body scopes. The emitter used to write the
 * element's children flat into the render function, so the inner declaration
 * was a second `const count` in the same block (a SyntaxError on load).
 */
import { describe, expect, it } from "vitest";
import { compile, mx } from "./index.ts";

const render = (source: string, input: Record<string, unknown> = {}) =>
  String(mx(source)(input));
const emit = (source: string) => compile(source, "/fixtures/page.mx").code;

describe("html: an element body scopes the tag variables it declares", () => {
  const ROWS: Array<[string, string, string]> = [
    [
      "the bead form: an inner <const> beside an outer <let>",
      "<let/count=1/><div><const/count=2/></div>",
      "<div></div>",
    ],
    [
      "the inner read is the inner binding, the read after is the outer one",
      "<const/count=1/><div><const/count=2/>${count}</div>${count}",
      "<div>2</div>1",
    ],
    [
      "an inner <let> over an outer <const>",
      "<const/count=1/><div><let/count=2/>${count}</div>${count}",
      "<div>2</div>1",
    ],
    [
      "an inner <let> over an outer <let>",
      "<let/count=1/><div><let/count=2/>${count}</div>${count}",
      "<div>2</div>1",
    ],
    [
      "two elements deep, the read between them",
      "<const/count=1/><div><section><const/count=2/>${count}</section>${count}</div>${count}",
      "<div><section>2</section>1</div>1",
    ],
    [
      "each nesting level declares its own",
      "<const/count=1/><div><const/count=2/><section><const/count=3/>${count}</section>${count}</div>${count}",
      "<div><section>3</section>2</div>1",
    ],
    [
      "sibling elements declare the same name",
      "<div><const/a=1/>${a}</div><div><const/a=2/>${a}</div>",
      "<div>1</div><div>2</div>",
    ],
    [
      "concise syntax",
      "const/count=1\ndiv\n  const/count=2\n  -- ${count}\n-- ${count}",
      "<div>2</div>1",
    ],
    [
      "an element that declares nothing is unchanged",
      "<const/count=1/><div>${count}</div>${count}",
      "<div>1</div>1",
    ],
    [
      "the controls: <if> and <for> bodies scope the same way",
      "<const/count=1/><if=true><const/count=2/>${count}</if><for|i| of=[0]><const/count=3/>${count}</for>${count}",
      "231",
    ],
  ];

  for (const [name, source, expected] of ROWS) {
    it(name, () => {
      expect(render(source)).toBe(expected);
    });
  }

  it("a <define> written in an element body is scoped to it, and so is its name", () => {
    const source =
      "<div><define/Row><b>1</b></define><Row/></div><div><define/Row><b>2</b></define><Row/></div>";
    expect(render(source)).toBe("<div><b>1</b></div><div><b>2</b></div>");
    expect(emit(source).match(/const Row =/g)).toHaveLength(2);
  });

  it("only an element that declares something gets a block", () => {
    expect(emit("<div>${input.a}</div>")).not.toMatch(/\n\s*\{\n/);
    expect(emit("<div><const/a=1/>${a}</div>")).toMatch(/\{\n\s*const a = 1;/);
  });
});
