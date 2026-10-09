import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
      policy((name) => `/tmp/mx-discovered/tags/${name}.mx`),
    );
    expect(ir.imports.map((i) => i.code)).toEqual([
      'import _badge from "../tags/badge.mx"',
      'import _fancyBtn from "../tags/fancy-btn.mx"',
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
      policy(() => "/tmp/mx-discovered/tags/badge.mx"),
    );
    expect(ir.imports.map((i) => i.code)).toEqual([
      'import _badge2 from "../tags/badge.mx"',
    ]);
  });

  it("refuses a `.marko` module, positioned at the tag (decision 172)", () => {
    let error: unknown;
    try {
      lower(
        "<p/>\n<badge/>",
        policy(() => "/tmp/mx-discovered/tags/badge.marko"),
      );
    } catch (caught) {
      error = caught;
    }
    expect(String((error as Error)?.message)).toContain(
      "`<badge>` resolves to `../tags/badge.marko`, a `.marko` file, and MX does not compile `.marko` files. Convert it to `.mx` (`../tags/badge.mx`).",
    );
    expect(error).toMatchObject({ line: 2, column: 0 });
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

  describe("with an import or `<define>` of the same name in scope (addendum 1)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-taglib-tag-")));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "package.json"), "{}");
    // The import: an `Input` with a plain `item` and a `<return>`.
    writeFileSync(
      join(dir, "badge.mx"),
      "export interface Input { label: string; item?: { x: number } }\n<i>${input.label}</i>\n<return value=42/>\n",
    );
    // The module the hook names: no `Input`, no `<return>`.
    mkdirSync(join(dir, "tags"));
    const tagModule = join(dir, "tags", "badge.mx");
    writeFileSync(tagModule, "<span>${input.label}</span>\n");
    const page = join(dir, "page.mx");
    // `attrTags: 2` so an attribute tag reaches the `Input` check.
    const hooked: Policy = { ...policy(() => tagModule), attrTags: 2 };
    const run = (source: string, declarations = hooked): Ir => {
      let ir: Ir | null = null;
      compileSource(source, page, declarations, {
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
    };
    const failure = (source: string, declarations = hooked): string => {
      try {
        run(source, declarations);
      } catch (error) {
        return String((error as Error).message).replace(
          // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes.
          /\x1b\[[0-9;]*m/g,
          "",
        );
      }
      throw new Error("expected the compile to fail");
    };
    const IMPORT = 'import badge from "./badge.mx"\n';
    const DEFINE = "<define/badge|x|>d</define>\n";
    const called = {
      kind: "name",
      name: "badge",
      resolvedPath: tagModule,
      binding: "_badge",
    };

    it("calls the hook's module, not the import", () => {
      const ir = run(`${IMPORT}<badge label="a"/>`);
      expect(ir.imports.map((i) => i.code)).toEqual([
        'import badge from "./badge.mx"',
        'import _badge from "./tags/badge.mx"',
      ]);
      expect(targets(ir)).toEqual([called]);
    });

    it("calls the hook's module, not the define", () => {
      const ir = run(`${DEFINE}<badge/>`);
      expect(ir.imports.map((i) => i.code)).toEqual([
        'import _badge from "./tags/badge.mx"',
      ]);
      expect(targets(ir)).toEqual([called]);
    });

    it("reads `/var` against the module, not the import's `<return>`", () => {
      expect(failure(`${IMPORT}<badge/r label="a"/>\n\${r}`)).toContain(
        "`<badge>` does not return a value",
      );
    });

    it("does not check an attribute tag against the import's `Input`", () => {
      expect(() =>
        run(`${IMPORT}<badge label="a"><@item x="s"/></badge>`),
      ).not.toThrow();
    });

    it("is an error when nothing resolves it to a module", () => {
      for (const prefix of [IMPORT, DEFINE]) {
        expect(failure(`${prefix}<badge label="a"/>`, policy())).toContain(
          "`<badge>` is declared by a Marko taglib with no template (a `renderer`), which",
        );
      }
    });
  });
});
