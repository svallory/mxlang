type Base = Omit<Other, "y">;
export interface Input extends Base {
  x?: AttrTag;
}
