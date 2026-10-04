import type { ContractMap } from "@mxlang/core";

export default {
  service: {
    parents: ["#root"],
    attributes: { value: { type: "string", required: true } },
    children: { port: { repeatable: true } },
  },
  port: {
    parents: ["service"],
    attributes: { value: { type: "string", required: true } },
  },
} satisfies ContractMap;
