type Picky = boolean extends true ? { as: "data" } : { as: "renderable" };
export interface Input {
  x?: AttrTag<Picky>;
}
