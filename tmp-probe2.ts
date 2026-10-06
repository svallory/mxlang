import { isShorthandWord } from "./packages/core/src/name-sugar.ts";

const cases = [
  [".", "bg-["],
  ["#", "fff]"],
  [".", "w-1"],
  [".", "5"],
  [".", "w-1/2"],
];

for (const [sigil, word] of cases) {
  console.log(`${sigil}${word} => ${isShorthandWord(sigil, word)}`);
}
