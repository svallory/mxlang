type A1 = A2;
type A2 = A3;
type A3 = A4;
type A4 = { badge?: AttrTag<{ as: "renderable" }> };
export interface Input {
  tab?: AttrTag<{ attrs: A1 }>;
}
