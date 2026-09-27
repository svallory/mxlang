export interface Input {
  a?: AttrTag | undefined;
  // biome-ignore lint/complexity/noBannedTypes: deliberately invalid compound AttrTag config
  b: AttrTag<{}> & { extra: 1 };
  c?: AttrTag[];
}
