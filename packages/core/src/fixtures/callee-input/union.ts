export interface Input { a?: AttrTag | undefined; b: AttrTag<{}> & { extra: 1 }; c?: (AttrTag)[] }
