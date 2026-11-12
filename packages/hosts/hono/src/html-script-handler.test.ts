// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

// The shared JSX emitter is pinned in `@mxlang/host-preact`; this row proves
// the hono entry reaches it.
describe("hono: <html-script> refuses an event handler", () => {
  it("at the attribute", () => {
    let error: unknown;
    try {
      compileHonoMx(
        "<html-script onclick() { go() }>x</html-script>",
        "/fixtures/script.mx",
      );
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toMatchObject({
      message: expect.stringMatching(
        /`onclick\(\.\.\.\)` on `<html-script>` is an event handler/,
      ),
      line: 1,
      column: 13,
    });
  });
});
