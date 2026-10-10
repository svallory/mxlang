import type { AttrTag } from "@mxlang/host-solid";

export interface Input {
  item: AttrTag<{ as: "renderable" }>;
}

export default function AttrCallee(_input: Input) {
  return null;
}
