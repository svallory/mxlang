export interface AttrTagConfig {
  as?: "data" | "renderable";
  attrs?: object;
  params?: readonly unknown[];
}

export type AttrTagOf<C extends AttrTagConfig, R> = C["as"] extends "renderable"
  ? C["params"] extends readonly unknown[]
    ? (...args: C["params"]) => R
    : R
  : // biome-ignore lint/complexity/noBannedTypes: the public contract intentionally means any non-nullish empty config
    (C["attrs"] extends object ? C["attrs"] : {}) & {
      content?: C["params"] extends readonly unknown[]
        ? (...args: C["params"]) => R
        : R;
    };

// biome-ignore lint/complexity/noBannedTypes: matches the public AttrTag default from decision 106
export type AttrTag<C extends AttrTagConfig = {}> = AttrTagOf<C, unknown>;
