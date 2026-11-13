/**
 * Type-level drift guard for `lean-runtime.ts`: compiled by the package
 * typecheck, never executed. Every name the stub exports is asserted equal to
 * the real one.
 */
import type { escape as coreEscape } from "@mxlang/core";
import type {
  AttrTag as RealAttrTag,
  BufferedOut as RealBufferedOut,
  Out as RealOut,
  createBufferedOut as realCreateBufferedOut,
  createOut as realCreateOut,
} from "../index.ts";
import type {
  AttrTag as LeanAttrTag,
  BufferedOut as LeanBufferedOut,
  Out as LeanOut,
  createBufferedOut as leanCreateBufferedOut,
  createOut as leanCreateOut,
  escape as leanEscape,
} from "./lean-runtime.ts";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

type Data = { id: number };
type Params = { content: (a: number, b?: string) => string };

export type LeanRuntimeMatchesReal = [
  Assert<Equals<typeof leanEscape, typeof coreEscape>>,
  Assert<Equals<LeanOut, RealOut>>,
  Assert<Equals<LeanBufferedOut, RealBufferedOut>>,
  Assert<Equals<typeof leanCreateOut, typeof realCreateOut>>,
  Assert<Equals<typeof leanCreateBufferedOut, typeof realCreateBufferedOut>>,
  Assert<Equals<LeanAttrTag, RealAttrTag>>,
  Assert<Equals<LeanAttrTag<Data>, RealAttrTag<Data>>>,
  Assert<Equals<LeanAttrTag<Params>, RealAttrTag<Params>>>,
  Assert<Equals<LeanAttrTag<{ x?: 1 }>, RealAttrTag<{ x?: 1 }>>>,
];
