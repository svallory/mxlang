import { mx } from "./packages/targets/html/src/index.ts";
import { compilePreactMx } from "./packages/hosts/preact/src/index.ts";

const cases = [
  "<div.bg-[#fff]/>",
  "<div.w-1.5/>",
  "<div.w-1/2/>",
  "<div.hover:bg-red/>",
  "<div.a.b#c/>",
  "<div.w-1/>",
];

console.log("=== @mxlang/html ===");
for (const source of cases) {
  try {
    const render = mx(source);
    console.log(`${source} => ${JSON.stringify(render({}))}`);
  } catch (e) {
    console.log(`${source} => ERROR: ${(e as Error).message}`);
  }
}

console.log("\n=== @mxlang/preact (compile output) ===");
for (const source of cases) {
  try {
    const { code } = compilePreactMx(source, "test.mx");
    console.log(`${source} =>\n${code.split("\n").slice(0, 8).join("\n")}\n---`);
  } catch (e) {
    console.log(`${source} => ERROR: ${(e as Error).message}`);
  }
}
