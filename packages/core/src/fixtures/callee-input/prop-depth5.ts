type T1 = T2;
type T2 = T3;
type T3 = T4;
type T4 = T5;
type T5 = AttrTag<{ as: "renderable" }>;
export interface Input {
  x?: T1;
}
