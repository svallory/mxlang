import { parseFragment } from "./packages/core/src/fragment.ts";

const cases = ["<div .w-1/2/>", "<div .bg-[#fff]/>", "<div .w-1.5/>"];
for (const source of cases) {
  const { body } = parseFragment(source, { filename: "test.mx" });
  console.log(`=== ${source} ===`);
  console.log(JSON.stringify(body[0].attributes, null, 2));
}
