import { parseFragment } from "./packages/core/src/fragment.ts";

const cases = ["<div.w-1/2/>", "<div.bg-[#fff]/>", "<div.w-1.5/>"];

for (const source of cases) {
  try {
    const result = parseFragment(source, { filename: "test.mx" });
    console.log(`${source} => parsed, body: ${JSON.stringify(result.body.map((n: any) => n.type))}`);
  } catch (e) {
    console.log(`${source} => PARSE ERROR: ${(e as Error).message}`);
  }
}
