/**
 * The front end's output until expression parsing lands (PR 3 of the MX2
 * parser port; decision 166 addendum 1).
 *
 * The catalogue's containers (`MxExpressionContainer`, ast §4.1) carry a
 * Babel payload in `node` and its failure in `error`. This PR builds every
 * container's span, `outer`, `source` and `atoms`, but parses nothing, so it
 * cannot produce those two fields, and the catalogue has no "not parsed yet"
 * state. The tree is therefore typed here, privately, as the catalogue's
 * tree with each container's `node`/`error` left out. Nothing in this file
 * is exported from the package index; PR 3 deletes this file and the front
 * end returns `MxDocument` itself.
 */
import type {
  MxArguments,
  MxDocument,
  MxExpression,
  MxParameterList,
  MxPattern,
  MxStatements,
  MxTypeArguments,
  MxTypeParameters,
} from "@mxlang/babel/mx-ast";

type Container =
  | MxExpression
  | MxStatements
  | MxPattern
  | MxArguments
  | MxParameterList
  | MxTypeArguments
  | MxTypeParameters;

/** A container as this PR builds it: everything but the payload and its error. */
export type InterimContainer<C extends Container = Container> = Omit<
  C,
  "node" | "error"
>;

/** The catalogue's node type `T` with every container replaced by its interim form. */
export type Interim<T> = T extends Container
  ? InterimContainer<T>
  : T extends readonly (infer U)[]
    ? readonly Interim<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Interim<T[K]> }
      : T;

/** What `parse` returns until PR 3. */
export type InterimDocument = Interim<MxDocument>;
