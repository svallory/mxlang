import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";

const SPECIFIER = "@mxlang/host-astro/typecheck";

/** One template per optional import the html emitter makes. */
const TEMPLATES: Record<string, string> = {
  plain: "<p>${input.name}</p>",
  attrTag: "export interface Input { head: AttrTag }\n<section/>",
  buffered:
    '<const/_error="outer"/>\n<try><${input.fail}/><@catch><p>${_error}</p></@catch></try>',
};

function compiled(source: string): string {
  const load = descriptor.load;
  if (!load) throw new Error("astro descriptor has no load()");
  const { compileModule } = load({} as never);
  return compileModule(source, "/virtual/page.mx", {
    typeCheck: true,
    strict: true,
  }).code;
}

/** Names the emitter imports from the type-check module, with the type-only ones included. */
function importedNames(code: string): string[] {
  const names: string[] = [];
  for (const match of code.matchAll(
    /import (?:type )?\{([^}]*)\} from "([^"]+)";/g,
  )) {
    if (match[2] !== SPECIFIER) continue;
    for (const part of (match[1] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type /, "")
        .split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

function exportedNames(): Set<string> {
  const file = fileURLToPath(new URL("./typecheck.ts", import.meta.url));
  const program = ts.createProgram([file], {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const symbol = source && checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error("typecheck.ts has no module symbol");
  return new Set(checker.getExportsOfModule(symbol).map((s) => s.name));
}

describe("@mxlang/host-astro/typecheck", () => {
  const exported = exportedNames();

  for (const [name, source] of Object.entries(TEMPLATES)) {
    it(`exports every name the emitter imports for a ${name} template`, () => {
      const code = compiled(source);
      const names = importedNames(code);
      expect(names).toContain("createOut");
      expect(code).not.toContain('from "@mxlang/target-html"');
      for (const imported of names) expect(exported).toContain(imported);
    });
  }

  it("covers the optional imports (the templates exercise what they claim)", () => {
    expect(importedNames(compiled(TEMPLATES.attrTag as string))).toContain(
      "AttrTag",
    );
    expect(importedNames(compiled(TEMPLATES.buffered as string))).toContain(
      "createBufferedOut",
    );
  });
});
