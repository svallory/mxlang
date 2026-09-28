type P1 = P2;
type P2 = P3;
type P3 = P4;
type P4 = { x?: AttrTag<{ as: "renderable" }> };
export type Input = { y?: string } & P1;
