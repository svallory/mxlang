import { mx } from "./packages/targets/html/src/index.ts";

const cases = [
  "<div.hover:bg-red/>",
  "<div.a.b#c/>",
  "<div.w-1/>",
  "<div .hover:bg-red/>",
  "<div .a.b#c/>",
  "<div .w-1/>",
];

for (const source of cases) {
  try {
    console.log(`${source} => ${JSON.stringify(mx(source)({}))}`);
  } catch (e) {
    console.log(`${source} => ERROR: ${(e as Error).message.split("\n")[3] ?? (e as Error).message}`);
  }
}
