import type { Ctx } from "./core.ts";
import type { ComponentTarget } from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";

export interface AttrTagDecl {
  cardinality: "optional" | "required" | "array";
  as: "data" | "renderable";
  hasAttrs: boolean;
  hasParams: boolean;
  nested: Map<string, AttrTagDecl>;
  nestedOpen: boolean;
  span: SourceSpan;
}

export type CalleeInput =
  | {
      kind: "declared";
      path: string;
      attrTags: Map<string, AttrTagDecl>;
      otherProps: Set<string>;
      open: boolean;
    }
  | { kind: "none"; path?: string }
  | { kind: "unresolved"; specifier: string }
  | {
      kind: "invalid";
      path: string;
      errors: Map<string, { message: string; span: SourceSpan }>;
    };

// STUB: replaced by task 1a
export function readCalleeInput(
  _target: ComponentTarget,
  _ctx: Ctx,
): { input: CalleeInput; dependencies: string[] } {
  return { input: { kind: "none" }, dependencies: [] };
}
