// biome-ignore lint/complexity/noBannedTypes: deliberately shadows the real AttrTag type
interface AttrTag<T = {}> {
  fake: T;
}
export interface Input {
  x?: AttrTag;
}
