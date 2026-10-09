/**
 * The two lists Mesh's contracts read from `@meshfw/model`, copied from Mesh
 * (`packages/model/src/action-types.ts` and `attribute-types.ts`; commit and
 * licence in this directory's README.md and LICENSE).
 */

/** Fixed action types used by declarations, auto and scoped rules. */
export const ACTION_TYPES = Object.freeze([
  "create",
  "read",
  "update",
  "destroy",
] as const);

/** The entity-file type tags and their generated TypeScript representation. */
export const ATTRIBUTE_TYPES = Object.freeze([
  { name: "uuid", tsType: "string" },
  { name: "string", tsType: "string" },
  { name: "integer", tsType: "number" },
  { name: "float", tsType: "number" },
  { name: "decimal", tsType: "number" },
  { name: "boolean", tsType: "boolean" },
  { name: "enum", tsType: "string" },
  { name: "date", tsType: "Date" },
  { name: "datetime", tsType: "Date" },
  { name: "timestamp", tsType: "Date" },
] as const);
