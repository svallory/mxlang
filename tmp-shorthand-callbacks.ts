import { markoParser } from "./packages/core/src/stock-parser.ts";

const parser = markoParser();
if (!parser) throw new Error("no parser");

const cases = [
  "<div.bg-[#fff]/>",
  "<div.w-1.5/>",
  "<div.w-1/2/>",
  "<div.hover:bg-red/>",
  "<div .w-1/2/>",
  "<div .bg-[#fff]/>",
  "<div .w-1.5/>",
];

for (const source of cases) {
  const classParts: string[] = [];
  const idParts: string[] = [];
  let error = "";
  try {
    parser.createParser({
      onTagShorthandClass: (range: { start: number; end: number }) => {
        classParts.push(source.slice(range.start, range.end));
      },
      onTagShorthandId: (range: { start: number; end: number }) => {
        idParts.push(source.slice(range.start, range.end));
      },
      onError: (err: { message: string }) => { error = err.message; },
    }).parse(source);
  } catch (e) {
    error = (e as Error).message;
  }
  console.log(`${source}: class=${JSON.stringify(classParts)} id=${JSON.stringify(idParts)} error=${error}`);
}
