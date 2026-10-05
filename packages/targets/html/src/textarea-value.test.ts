import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMx } from "./helpers.ts";
import { compile } from "./index.ts";

const dir = mkdtempSync(
  join(new URL("..", import.meta.url).pathname, ".mx-textarea-tmp-"),
);
let serial = 0;
const render = (source: string, input: Record<string, unknown> = {}) => {
  const path = join(dir, `t${serial++}.mx`);
  writeFileSync(path, source);
  return loadMx<Record<string, unknown>>(path)(input);
};

import { afterAll } from "vitest";

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SOURCE = '<textarea ...{value:"s"} value=input.v id="z"/>';

describe("<textarea value> emitted code", () => {
  it("emits no dead merge-loop branch for a value after the last spread", () => {
    const code = compile(SOURCE, "t.mx").code;
    expect(code).not.toContain('__mxKey === "value") { __mxTa');
    expect(code).toContain("__mxTa = input.v;");
  });

  it("still renders the later value over the spread's", () => {
    expect(render(SOURCE, { v: "x<y" })).toBe(
      '<textarea id="z">x&lt;y</textarea>',
    );
  });

  it("keeps the branch when the value comes from a spread", () => {
    const code = compile("<textarea ...input.a/>", "t.mx").code;
    expect(code).toContain('__mxKey === "value") { __mxTa');
  });
});
