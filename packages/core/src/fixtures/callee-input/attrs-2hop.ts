type A1 = A2;
type A2 = { icon?: AttrTag };
export interface Input {
  x?: AttrTag<{ attrs: A1 }>;
}
