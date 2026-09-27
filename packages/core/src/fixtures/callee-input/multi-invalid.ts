type Bad = boolean extends true ? { as: "data" } : { as: "renderable" };
export interface Input {
  x?: AttrTag<Bad>;
  y?: AttrTag;
}
