export interface AttrTagConfig {
  as?: "data" | "renderable";
  attrs?: object;
  params?: readonly unknown[];
}

export type AttrTagParams<C extends AttrTagConfig> =
  C["params"] extends readonly unknown[] ? C["params"] : [];

export type AttrTagAttrs<C extends AttrTagConfig> =
  // biome-ignore lint/complexity/noBannedTypes: the public contract intentionally means an object with no required attributes
  C["attrs"] extends object ? C["attrs"] : {};

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

export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: matches the public AttrTag default from decision 106
  C extends AttrTagConfig = {},
> = AttrTagOf<C, unknown>;
