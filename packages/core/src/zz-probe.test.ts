// biome-ignore-all lint: probe
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { compileSource } from "./compile.ts";
import type { Policy } from "./declarations.ts";
import { lookup } from "./test-targets.ts";
const dir = mkdtempSync(join(tmpdir(), "mx-probe-"));
writeFileSync(join(dir, "Foo.mx"), "<return=1/>\n");
writeFileSync(join(dir, "barrel.ts"), "export const x = 1;\n");
const PAGE = join(dir, "page.mx");
const policy: Policy = { tags: {}, isElement: () => true, isComponent: (n, c: any) => /^[A-Z]/.test(n) || c.defines?.has(n) };
const S: Record<string,string> = {
 a1: "<define/Bar><@item/></define>\n<Bar/>",
 a2: "<define/Bar><@item/></define>",
 b1: "<if=input.a><define/Foo>x</define></if><div>${typeof Foo}</div>",
 b2: "<if=input.a>${typeof Foo}<define/Foo>x</define></if>",
 c1: "<div><define/Foo>a</define></div><div><define/Foo>b</define></div>",
 c2: "<define/Foo>a</define><div><define/Foo>b</define></div>",
 d1: "<define/D><return=1/></define>",
 e1: 'import Barrel from "./barrel.ts"\n<Barrel/c/>',
 f1: "<script>console.log(D)</script><div><define/D>x</define></div>",
 f2: "<if=true>${typeof D}</if><else><define/D>x</define></else>",
 g1: 'import Foo from "./Foo.mx"\n<Foo/x>${x}</Foo>',
 g2: 'import Foo from "./Foo.mx"\n<Foo/x a=1><@b c=x/></Foo>',
 g3: 'import Foo from "./Foo.mx"\n<Foo/x a=x/>',
 h1: "<define/Foo<T>|{ v }: { v: T }|>${v}</define>\n<Foo v=1/>",
};
it("probe", () => {
  for (const [k, src] of Object.entries(S)) {
    try {
      const out = compileSource(src, PAGE, policy, { targets: lookup, tagDiscoveryDirs: [], customTags: {}, emitIr: (ir: any) => JSON.stringify(ir.body ?? ir).slice(0,0) } as any);
      console.log("PROBE", k, "OK", typeof out === "string" ? out.slice(0, 200) : "");
    } catch (e: any) {
      console.log("PROBE", k, "ERR", e.diagnosticCode, e.line, e.column, e.message.slice(0, 220));
    }
  }
});
