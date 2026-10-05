import type { AttrTag } from "@mxlang/solid";

export interface Input {
  item: AttrTag<{ as: "renderable" }>;
}

export default function AttrCallee(_input: Input) {
  return null;
}
