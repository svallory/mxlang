interface B1 extends B2 {}
interface B2 extends B3 {}
interface B3 extends B4 {}
interface B4 extends B5 {}
interface B5 {
  x?: AttrTag<{ as: "renderable" }>;
}
export interface Input extends B1 {}
