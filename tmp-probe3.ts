import { isShorthandWord } from "./packages/core/src/name-sugar.ts";

const words = [
  "w-1/2",
  "w-1/foo",
  "w-1/",
  "w-1/ ",
];

for (const word of words) {
  console.log(`.${word} => ${isShorthandWord(".", word)}`);
}
