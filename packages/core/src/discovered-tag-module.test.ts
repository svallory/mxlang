import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { Policy } from "./declarations.ts";
import type { Ir, IrNode } from "./ir.ts";
import { lookup } from "./test-targets.ts";

const CALLER = "/tmp/mx-discovered/pages/page.mx";

function policy(resolve?: Policy["resolveDiscoveredTagModule"]): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name) => name === "badge" || name === "fancy-btn",
    ...(resolve ? { resolveDiscoveredTagModule: resolve } : {}),
  };
}

function lower(source: string, declarations: Policy): Ir {
  let ir: Ir | null = null;
  compileSource(source, CALLER, declarations, {
    targets: lookup,
    tagDiscoveryDirs: [],
    emitIr(lowered) {
      ir = lowered;
      return "";
    },
  });
  if (!ir) throw new Error("lowerer produced no IR");
  return ir;
}

function targets(ir: Ir) {
  return ir.body
    .filter(
      (n): n is Extract<IrNode, { kind: "Component" }> =>
        n.kind === "Component",
    )
    .map((n) => n.target);
}

describe("resolveDiscoveredTagModule", () => {
  it("imports the module and sets the binding on the target", () => {
    const ir = lower(
      '<badge label="a"/><fancy-btn/><badge/>',
      policy((name) => `/tmp/mx-discovered/tags/${name}.marko`),
    );
    expect(ir.imports.map((i) => i.code)).toEqual([
      'import _badge from "../tags/badge.marko"',
      'import _fancyBtn from "../tags/fancy-btn.marko"',
    ]);
    expect(targets(ir)).toEqual([
      { kind: "name", name: "badge", binding: "_badge" },
      { kind: "name", name: "fancy-btn", binding: "_fancyBtn" },
      { kind: "name", name: "badge", binding: "_badge" },
    ]);
  });

  it("leaves the target a bare name when the hook is absent or answers undefined", () => {
    for (const declarations of [policy(), policy(() => undefined)]) {
      const ir = lower("<badge/>", declarations);
      expect(ir.imports).toEqual([]);
      expect(targets(ir)).toEqual([{ kind: "name", name: "badge" }]);
    }
  });

  it("numbers the binding past an identifier the source already uses", () => {
    const ir = lower(
      '<badge/>${"_badge"}',
      policy(() => "/tmp/mx-discovered/tags/badge.marko"),
    );
    expect(ir.imports.map((i) => i.code)).toEqual([
      'import _badge2 from "../tags/badge.marko"',
    ]);
  });
});

/**
 * A tag a translator's own taglib registers (a third-party target's; no
 * built-in target registers a lowercase tag since a `marko.json` stopped being
 * read, decision 197) is the host's tag, not a binding of the same name
 * (decision 164 addendum 1), and needs the hook to have something to call.
 */
describe("a tag a translator taglib registers", () => {
  function lowerWithTaglib(source: string, declarations: Policy): Ir {
    let ir: Ir | null = null;
    compileSource(source, CALLER, declarations, {
      targets: lookup,
      taglibs: [["acme-tags", { "<badge>": {} }]],
      tagDiscoveryDirs: [],
      emitIr(lowered) {
        ir = lowered;
        return "";
      },
    });
    if (!ir) throw new Error("lowerer produced no IR");
    return ir;
  }

  it("is called through the hook's module", () => {
    const ir = lowerWithTaglib(
      "<badge/>",
      policy(() => "/tmp/mx-discovered/tags/badge.mx"),
    );
    expect(ir.imports.map((i) => i.code)).toEqual([
      'import _badge from "../tags/badge.mx"',
    ]);
    expect(targets(ir)).toEqual([
      { kind: "name", name: "badge", binding: "_badge" },
    ]);
  });

  it("is an error when nothing resolves it to a module", () => {
    expect(() => lowerWithTaglib("<badge/>", policy())).toThrow(
      "`<badge>` is declared by a Marko taglib with no template (a `renderer`), which",
    );
  });

  it("stays the host's tag when an import binds the same name", () => {
    const ir = lowerWithTaglib(
      'import badge from "./badge.mx"\n<badge label="a"/>',
      policy(),
    );
    expect(targets(ir)).toEqual([{ kind: "name", name: "badge" }]);
  });

  it("stays the host's tag when a define binds the same name", () => {
    const ir = lowerWithTaglib(
      "<define/badge|x|>d</define>\n<badge/>",
      policy(),
    );
    expect(targets(ir)).toEqual([{ kind: "name", name: "badge" }]);
  });
});
