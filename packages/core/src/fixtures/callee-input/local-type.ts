// biome-ignore lint/complexity/noBannedTypes: deliberately shadows the real AttrTag type
type AttrTag<T = {}> = { fake: T };
export interface Input {
  x?: AttrTag<{ as: "renderable" }>;
}
