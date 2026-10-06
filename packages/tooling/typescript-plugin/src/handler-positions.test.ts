import { SourceMap } from "@volar/language-core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMxLanguagePlugin, MX_LANGUAGE_ID } from "./mx-language.ts";

/**
 * Decision 140, round 3. The handler wrapper must not move any position inside
 * a handler: a diagnostic or a hover on `e` or on a body reference maps to the
 * authored offset, exactly as it does without the wrapper. The mapping is
 * resolved with Volar's own `SourceMap`, the lookup hover and diagnostics use.
 */
const here = new URL("./fixtures/", import.meta.url).pathname;
const HOSTS = ["preact", "react", "hono"] as const;

function virtual(host: (typeof HOSTS)[number], source: string) {
  const code = createMxLanguagePlugin(ts).createVirtualCode?.(
    `${here}${host}-policy/handlers.mx`,
    MX_LANGUAGE_ID,
    ts.ScriptSnapshot.fromString(source),
    { getAssociatedScript: () => undefined },
  );
  if (!code) throw new Error("Expected MX virtual code");
  const generated = code.snapshot.getText(0, code.snapshot.getLength());
  const map = new SourceMap(code.mappings as never);
  const toSource = (generatedOffset: number) => {
    const found = [...map.toSourceLocation(generatedOffset)][0];
    return found?.[0];
  };
  return { generated, toSource };
}

describe.each(HOSTS)("handler positions on %s (decision 140)", (host) => {
  const arrow = "<button onClick=((e) => e.nope())>x</button>";
  const shorthand = "<button onClick(e) { e.nope(); }>x</button>";

  it("maps every offset inside an arrow handler to the authored offset", () => {
    const { generated, toSource } = virtual(host, arrow);
    const at = generated.indexOf("(e) => e.nope()");
    expect(at).toBeGreaterThan(0);
    // The parameter, the arrow, and each character of the body reference.
    for (const [needle, within] of [
      ["(e) =>", 1],
      ["(e) =>", 0],
      ["e.nope()", 0],
      ["e.nope()", 2],
      ["e.nope()", 7],
    ] as const) {
      const generatedOffset = generated.indexOf(needle) + within;
      expect(toSource(generatedOffset)).toBe(arrow.indexOf(needle) + within);
    }
  });

  it("keeps the `satisfies` mismatch on the handler's start", () => {
    const { generated, toSource } = virtual(
      host,
      "<button onClick=((a: string) => a.length)>x</button>",
    );
    expect(toSource(generated.indexOf("satisfies"))).toBe(17);
  });

  it("maps a shorthand handler's keyword to the attribute name and its body to the authored body", () => {
    const { generated, toSource } = virtual(host, shorthand);
    const keyword = toSource(generated.indexOf("satisfies"));
    expect(keyword).toBeGreaterThanOrEqual(shorthand.indexOf("onClick"));
    expect(keyword).toBeLessThanOrEqual(
      shorthand.indexOf("onClick") + "onClick".length,
    );
    // Decision 167: the body maps token by token, not onto the attribute name.
    for (const within of [0, 2, 7]) {
      expect(toSource(generated.indexOf("e.nope()") + within)).toBe(
        shorthand.indexOf("e.nope()") + within,
      );
    }
  });
});
