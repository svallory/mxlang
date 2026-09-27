type T1 = T2;
type T2 = T3;
type T3 = T4;
type T4 = AttrTag<{ as: "renderable" }>;
export interface Input {
  x?: T1;
}
