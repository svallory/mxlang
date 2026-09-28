type P1 = P2;
type P2 = P3;
type P3 = P4;
type P4 = P5;
type P5 = { x?: AttrTag<{ as: "renderable" }> };
export type Input = { y?: string } & P1;
