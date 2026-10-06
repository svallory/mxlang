import { createRequire } from "node:module";
import { type Ctx, type Node, newCtx } from "./packages/core/src/core.ts";
import type { Policy } from "./packages/core/src/declarations.ts";
import { parseFragment } from "./packages/core/src/fragment.ts";
import type { Ir } from "./packages/core/src/ir.ts";
import { lower } from "./packages/core/src/lower.ts";
import { printExpression } from "./packages/core/src/compile.ts";
import { lookup } from "./packages/core/src/test-targets.ts";

function policy(): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    resolveDefaultTag: () => "input",
  };
}

function lowerSource(source: string): Ir {
  const { body } = parseFragment(source, { filename: "test.mx" });
  const ctx: Ctx = newCtx(
    source,
    printExpression,
    policy(),
    undefined,
    "test.mx",
    lookup,
  );
  return lower(ctx, body);
}

const cases = ["<div.w-1/2/>", "<div.bg-[#fff]/>", "<div.w-1.5/>"];
for (const source of cases) {
  try {
    lowerSource(source);
    console.log(`${source} => OK`);
  } catch (e) {
    console.log(`${source} => ERROR: ${(e as Error).message}`);
  }
}
