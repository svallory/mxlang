import type { Cfg } from "./coll-dep";

type Local = { as: "renderable" };
export interface Input {
  a?: AttrTag<Cfg>;
  b?: AttrTag<Local>;
}
