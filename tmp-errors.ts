import { mx } from "./packages/targets/html/src/index.ts";

const cases = [
  "<div.bg-[#fff]/>",
  "<div.w-[calc(100%-2rem)]/>",
  "<div.bg-[url('/x.png')]/>",
  "<div.data-[state=open]:flex/>",
  "<div.[&>*]:p-4/>",
];

for (const source of cases) {
  try {
    mx(source)({});
    console.log(`${source} => OK`);
  } catch (e) {
    console.log(`${source} => ERROR: ${(e as Error).message}`);
  }
}
