type AttrTag<T = {}> = { fake: T };
export interface Input { x?: AttrTag<{ as: "renderable" }> }
