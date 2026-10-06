import { isShorthandWord } from "./packages/core/src/name-sugar.ts";

const cases = [
  ".bg-[#fff]",
  ".w-[calc(100%-2rem)]",
  ".bg-[url('/x.png')]",
  ".data-[state=open]:flex",
  ".[&>*]:p-4",
  ".w-1/2",
  ".w-1.5",
  ".hover:bg-red",
];

for (const c of cases) {
  const sigil = c[0];
  const word = c.slice(1);
  console.log(`${c} => isShorthandWord(${sigil}, ${word}) = ${isShorthandWord(sigil, word)}`);
}
