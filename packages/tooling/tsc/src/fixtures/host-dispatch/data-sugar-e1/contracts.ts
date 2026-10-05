import type { ContractMap } from "@mxlang/core";

export default {
  attributes: {
    defaultTag: "attribute",
    children: { attribute: { repeatable: true } },
  },
  attribute: { attributes: { type: { type: "string" } } },
} satisfies ContractMap;
