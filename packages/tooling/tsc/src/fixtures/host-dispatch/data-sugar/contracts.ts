import type { ContractMap } from "@mxlang/core";

export default {
  attributes: {
    defaultTag: "attribute",
    children: { attribute: { repeatable: true } },
  },
  attribute: {
    attributes: { name: { type: "string" }, type: { type: "string" } },
  },
} satisfies ContractMap;
