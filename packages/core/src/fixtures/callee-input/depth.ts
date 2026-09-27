type C1 = C2;
type C2 = C3;
type C3 = C4;
type C4 = C5;
type C5 = { as: "renderable" };
export interface Input {
  x?: AttrTag<C1>;
}
