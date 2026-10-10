import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache } from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";
import { isMxDocument } from "./server.ts";

const dirs: string[] = [];
function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-dispatch-r2-")));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "dispatch-r2", mx: { host: "solid" } }),
  );
  return dir;
}
afterEach(() => {
  clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function reactTypedCallee(dir: string): void {
  writeFileSync(
    join(dir, "Card.mx"),
    'import type { AttrTag } from "@mxlang/host-react"\nexport interface Input { header: AttrTag }\n<div/>\n',
  );
}

describe("round 2 cross-target attribute tags", () => {
  it("reports the required header of a react-typed callee from a solid page", () => {
    const dir = project();
    reactTypedCallee(dir);
    const dependencies = new Set<string>();
    const diagnostics = diagnoseDocument(
      'import Card from "./Card.mx"\n<Card/>\n',
      join(dir, "page.mx"),
      { target: "solid-jsx", host: "solid" },
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain(
      "missing required attribute tag `<@header>`",
    );
    // The existing Solid compiler returns dependencies on success, but does
    // not attach them to failed compiles. Pin its supported return path here;
    // changing its error contract is separate from forwarding the lookup.
    expect(
      diagnoseDocument(
        'import Card from "./Card.mx"\n<Card><@header>Header</@header></Card>\n',
        join(dir, "page.mx"),
        { target: "solid-jsx", host: "solid" },
        undefined,
        "mx",
        undefined,
        undefined,
        dependencies,
      ),
    ).toEqual([]);
    expect(dependencies).toContain(join(dir, "Card.mx"));
  });

  it("reports the required header of a react-typed callee from a solid region", () => {
    const dir = project();
    reactTypedCallee(dir);
    const diagnostics = diagnoseDocument(
      'import Card from "./Card.mx";\nexport const view = () => <Card/>;\n',
      join(dir, "page.solid.mx"),
      { target: "solid-jsx", host: "solid" },
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain(
      "missing required attribute tag `<@header>`",
    );
  });
});

const languageIds = ["ngmx", "astromx"] as const;
const filenames = ["page.mx", "X.SOLID.MX", "x.Solid.mx", "a.b.mx"] as const;
describe("round 2 silent-kind language-id matrix", () => {
  for (const languageId of languageIds) {
    for (const filename of filenames) {
      it(`${languageId} does not silence ${filename}`, () => {
        const uri = join(project(), filename);
        const source = "<let/count=0/>\n";
        const policy = { target: "html", strict: true };
        const baseline = diagnoseDocument(source, uri, policy);
        expect(baseline).toHaveLength(1);
        expect(
          diagnoseDocument(source, uri, policy, undefined, languageId),
        ).toEqual(baseline);
      });
      it(`${languageId} does not change server recognition for ${filename}`, () => {
        const uri = `file:///app/${filename}`;
        expect(isMxDocument(uri, languageId)).toBe(isMxDocument(uri, ""));
      });
    }
    it(`${languageId} alone does not make an untitled or TypeScript buffer an MX document`, () => {
      expect(isMxDocument("untitled:App", languageId)).toBe(false);
      expect(isMxDocument("file:///app/page.ts", languageId)).toBe(false);
    });
  }
});
