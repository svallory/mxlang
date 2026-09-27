import type { B } from "./cycle-b";
export type A = B;
export interface Input {
  x?: AttrTag<A>;
}
