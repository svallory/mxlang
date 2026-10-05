import type { ContractMap } from "@mxlang/core";

export default {
  attributes: {
    children: {
      title: {},
      "*": { pattern: "^[a-z][a-z0-9_]*$", contract: "attribute" },
    },
  },
  title: { parents: ["attributes"], attributes: { type: { type: "string" } } },
  attribute: {
    parents: ["attributes"],
    attributes: { type: { type: "string" } },
  },
} satisfies ContractMap;
