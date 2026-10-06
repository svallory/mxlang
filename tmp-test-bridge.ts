import { parseFragment } from "./packages/core/src/fragment.ts";
import { lower } from "./packages/core/src/lower.ts";
import { newCtx, printExpression } from "./packages/core/src/core.ts";
import type { Policy } from "./packages/core/src/declarations.ts";
import { lookup } from "./packages/core/src/test-targets.ts";

function policy(): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    resolveDefaultTag: () => "input",
  };
}

function lowerSource(source: string) {
  const { body } = parseFragment(source, { filename: "test.mx" });
  const ctx = newCtx(source, printExpression, policy(), undefined, "test.mx", lookup);
  return lower(ctx, body);
}

const cases = [
  "<div.bg-[#fff]/>",
  "<div.w-1.5/>",
  "<div.w-1/2/>",
  "<div .bg-[#fff]/>",
  "<div .w-1.5/>",
  "<div .w-1/2/>",
  "<div.hover:bg-red/>",
  "<div.a.b#c/>",
  "<div.w-1/>",
];

for (const source of cases) {
  try {
    lowerSource(source);
    console.log(`${source} => OK`);
  } catch (e) {
    const err = e as Error;
    console.log(`${source} => ERROR: ${err.message.split("\n")[0]}`);
  }
}
