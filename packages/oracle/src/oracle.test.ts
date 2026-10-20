import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compare } from "./compare";
import { BACKENDS, compileFile, VARIANTS } from "./compile";
import { discoverFixtures } from "./fixtures";
import { normalize } from "./normalize";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "..", "..", "fixtures");
const divergencesPath = join(fixturesRoot, "divergences.md");
const fixtures = discoverFixtures(fixturesRoot);

describe("compile: .tsx pipeline", () => {
  const counterTwin = join(fixturesRoot, "counter", "twin.tsx");
  const domVariant = VARIANTS.find((v) => v.generate === "dom");
  if (!domVariant) throw new Error("expected a dom variant in VARIANTS");

  for (const backend of BACKENDS) {
    it(`${backend}: compiling twin.tsx twice yields identical output`, () => {
      const first = compileFile(counterTwin, domVariant, backend);
      const second = compileFile(counterTwin, domVariant, backend);
      expect(first).toBe(second);
    });

    it(`${backend}: extra whitespace matches after normalize`, () => {
      const dir = mkdtempSync(join(tmpdir(), "mx-oracle-"));
      try {
        const reformatted = join(dir, "reformatted.tsx");
        const source = readFileSync(counterTwin, "utf8");
        const spaced = source.replace(/ /g, "   ").replace(/\n/g, "\n\n");
        writeFileSync(reformatted, spaced);

        const original = normalize(
          compileFile(counterTwin, domVariant, backend),
        );
        const reformattedOutput = normalize(
          compileFile(reformatted, domVariant, backend),
        );
        expect(reformattedOutput).toBe(original);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// This also pins golden content: compare reports fail for a stale twin golden.
// Existence after compare is not a separate invariant: it writes missing files.
describe("compare: fixtures never report fail without a real divergence", () => {
  for (const fixture of fixtures) {
    it(`${fixture}: every backend/variant reports skipped, pass, or divergent`, () => {
      const results = compare(join(fixturesRoot, fixture), { divergencesPath });
      expect(results.length).toBe(VARIANTS.length * BACKENDS.length);
      for (const r of results) {
        expect(r.status).not.toBe("fail");
      }
    });
  }

  it("reports at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });
});

describe("normalize", () => {
  it("preserves whitespace inside string literals", () => {
    const code = `const s = "a   b";`;
    expect(normalize(code)).toBe(`const s = "a   b";`);
  });

  it("preserves template literal contents", () => {
    const code = "const s = `a   b\n  c`;";
    expect(normalize(code)).toBe("const s = `a   b\n  c`;");
  });

  it("collapses whitespace runs outside literals", () => {
    const code = "const   x   =   1;";
    expect(normalize(code)).toBe("const x = 1;");
  });

  it("converts CRLF to LF", () => {
    const code = "const x = 1;\r\nconst y = 2;\r\n";
    expect(normalize(code)).toBe("const x = 1;\nconst y = 2;\n");
  });

  it("trims trailing spaces", () => {
    const code = "const x = 1;   \nconst y = 2;\t\n";
    expect(normalize(code)).toBe("const x = 1;\nconst y = 2;\n");
  });

  it("a quote inside a line comment doesn't start string state; later whitespace still collapses", () => {
    const code = "// it's fine\nconst   x   =   1;";
    expect(normalize(code)).toBe("// it's fine\nconst x = 1;");
  });

  it("a quote inside a block comment doesn't start string state", () => {
    const code = "/* it's   fine */\nconst   x   =   1;";
    expect(normalize(code)).toBe("/* it's   fine */\nconst x = 1;");
  });
});
