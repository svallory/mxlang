/**
 * Contract keys a syntax module owns (`SyntaxModule.contractFields`,
 * lang-ext-move-sugars-to-mesh slice a2). A claimed key is accepted at
 * registration as opaque data, reaches the module's `afterLower` on
 * `ContractCall.contract`, and is never checked by core. A key core checks
 * itself can be claimed only when it is one of the fields a module may take
 * over (the atom contract's `values`, `pattern`, `ref` and `declares`); any
 * other key core owns stays core's.
 */
import { isTranslateError, TranslateError } from "./core.ts";
import type { ContractData } from "./lowered-unit.ts";
import type { SyntaxModule } from "./syntax-table.ts";

/** What a syntax module claims, as `SyntaxModule.contractFields` states it. @unstable */
export interface ContractFields {
  /** Keys of an attribute declaration (`attributes.<name>`, at any attribute-tag depth). */
  readonly attribute?: readonly string[];
  /** Keys of a tag's own contract (beside `attributes`, `children`, …). */
  readonly tag?: readonly string[];
}

/** The claimed keys, as sets; empty when the file has no module or it claims nothing. */
export interface ClaimedFields {
  readonly attribute: ReadonlySet<string>;
  readonly tag: ReadonlySet<string>;
  /** The module's registration check of a contract that uses a claimed key. */
  readonly check?: SyntaxModule["checkContract"];
}

/** What `SyntaxModule.checkContract` is handed besides the contract. @unstable */
export interface ContractCheckContext {
  /**
   * A registration error in the module's words, raised where core's own
   * registration error for the contract lands (a sidecar's file, an
   * `mx.contracts` module at 1:0, no position for the `customTags` option),
   * carrying `code` as `diagnosticCode`.
   */
  fail(message: string, options?: { readonly code?: string }): never;
}

/** Core's attribute-declaration keys a module may take over. */
export const MOVABLE_ATTRIBUTE_FIELDS = ["values", "pattern", "ref"] as const;
/** Core's tag-contract keys a module may take over. */
export const MOVABLE_TAG_FIELDS = ["declares"] as const;

/** Core's attribute-declaration keys no module may claim. */
const CORE_ATTRIBUTE_FIELDS = [
  "type",
  "items",
  "required",
  "enum",
  "default",
  "literalOnly",
];

/** Core's tag-contract keys no module may claim. */
const CORE_TAG_FIELDS = [
  "defaultTag",
  "parseOptions",
  "attributes",
  "attributeTags",
  "children",
  "parents",
  "analyze",
  "transform",
  "finalize",
  "template",
];

const NONE: ClaimedFields = Object.freeze({
  attribute: new Set<string>(),
  tag: new Set<string>(),
});

const byModule = new WeakMap<object, ClaimedFields>();

/** The keys `module` claims (none without a module), with its `checkContract`. */
export function claimedFields(module: SyntaxModule | undefined): ClaimedFields {
  const fields = module?.contractFields;
  if (!module || !fields) return NONE;
  const known = byModule.get(module);
  if (known) return known;
  const claimed: ClaimedFields = {
    attribute: new Set(fields.attribute ?? []),
    tag: new Set(fields.tag ?? []),
    ...(module.checkContract ? { check: module.checkContract } : {}),
  };
  byModule.set(module, claimed);
  return claimed;
}

/**
 * A contract's declarations as plain data, as a module reads them:
 * `attributes`, `attributeTags`, `children` and the claimed tag keys it
 * states. The declaration objects are the registered ones, not copies.
 */
export function contractData(
  declaration: object,
  tagFields: ReadonlySet<string>,
): ContractData {
  const source = declaration as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const key of ["attributes", "attributeTags", "children"]) {
    if (source[key] !== undefined) data[key] = source[key];
  }
  for (const key of tagFields) {
    if (Object.hasOwn(declaration, key)) data[key] = source[key];
  }
  return Object.freeze(data);
}

function entriesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Does a contract use a key `claimed` lists: a claimed tag key on the tag,
 * or a claimed attribute key at any depth (attribute tags, named and
 * `"*"`, and inline `children["*"]` contracts)?
 */
function usesClaimed(
  declaration: unknown,
  claimed: ClaimedFields,
  top: boolean,
  path: Set<object>,
): boolean {
  if (!declaration || typeof declaration !== "object") return false;
  if (path.has(declaration)) return false;
  path.add(declaration);
  const contract = declaration as Record<string, unknown>;
  if (top) {
    for (const key of claimed.tag) {
      if (Object.hasOwn(contract, key)) return true;
    }
  }
  const attributes = contract.attributes;
  if (attributes && typeof attributes === "object") {
    for (const attribute of Object.values(attributes)) {
      if (!attribute || typeof attribute !== "object") continue;
      for (const key of claimed.attribute) {
        if (Object.hasOwn(attribute, key)) return true;
      }
    }
  }
  const nested: unknown[] = [];
  const children = contract.children as Record<string, unknown> | undefined;
  if (
    children &&
    typeof children === "object" &&
    Object.hasOwn(children, "*")
  ) {
    nested.push(...entriesOf(children["*"]));
  }
  const tags = contract.attributeTags as Record<string, unknown> | undefined;
  if (tags && typeof tags === "object") {
    for (const [name, value] of Object.entries(tags)) {
      nested.push(...(name === "*" ? entriesOf(value) : [value]));
    }
  }
  return nested.some((entry) => usesClaimed(entry, claimed, false, path));
}

/**
 * Runs the module's `checkContract` on `definition` when it uses a claimed
 * key. Its `fail` throws core's registration error shape (no position, no
 * file), so each registration path places it as it places core's own.
 */
export function checkClaimedContract(
  tag: string,
  definition: object,
  claimed: ClaimedFields,
): void {
  const check = claimed.check;
  if (!check || !usesClaimed(definition, claimed, true, new Set())) return;
  const fail = (message: string, options?: { code?: string }): never => {
    const error = new TranslateError(String(message), 0, 0);
    if (options?.code !== undefined)
      error.diagnosticCode = String(options.code);
    throw error;
  };
  try {
    check(tag, contractData(definition, claimed.tag), { fail });
  } catch (error) {
    if (isTranslateError(error)) throw error;
    throw new TranslateError(
      `the syntax module's \`checkContract\` threw on tag "${tag}": ${error instanceof Error ? error.message : String(error)}`,
      0,
      0,
    );
  }
}

/** How a file's syntax module is found; set by `syntax-table.ts` when it loads. */
let moduleOfFile: ((filePath: string) => SyntaxModule | undefined) | undefined;

/**
 * Registers how a file's syntax module is resolved, for the discovery scan
 * (`claimedFieldsOf`). `syntax-table.ts` registers `resolveSyntaxOf` as it
 * loads, so the scan does not import the syntax table (and the parser
 * behind it): `scan-cache.ts` stays loadable on its own.
 */
export function registerSyntaxResolver(
  resolve: (filePath: string) => SyntaxModule | undefined,
): void {
  moduleOfFile = resolve;
}

/**
 * The keys `filePath`'s syntax module claims (its nearest
 * `package.json#mx.syntax`), for registration in a discovery scan. A
 * manifest whose `mx.syntax` does not resolve claims nothing here; the
 * compile of the file reports that error itself.
 */
export function claimedFieldsOf(filePath: string): ClaimedFields {
  if (!moduleOfFile) return NONE;
  try {
    return claimedFields(moduleOfFile(filePath));
  } catch {
    return NONE;
  }
}

/** Does the module take over any of the atom contract's fields? */
export function claimsAtomFields(claimed: ClaimedFields): boolean {
  return (
    MOVABLE_ATTRIBUTE_FIELDS.some((key) => claimed.attribute.has(key)) ||
    MOVABLE_TAG_FIELDS.some((key) => claimed.tag.has(key))
  );
}

/**
 * `contractFields`' shape, for a module's registration: an object with
 * `attribute` and `tag` lists of non-empty strings, none naming a key core
 * keeps. `path` prefixes the field (`syntax.`, or nothing for a module file).
 */
export function checkContractFields(
  value: unknown,
  path: string,
  fail: (message: string) => never,
): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      `\`${path}contractFields\` must be an object (\`{ attribute?: string[], tag?: string[] }\`)`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "attribute" && key !== "tag") {
      fail(
        `\`${path}contractFields.${key}\` is not a contract field list (attribute, tag)`,
      );
    }
  }
  for (const [list, owned] of [
    ["attribute", CORE_ATTRIBUTE_FIELDS],
    ["tag", CORE_TAG_FIELDS],
  ] as const) {
    const keys = record[list];
    if (keys === undefined) continue;
    if (
      !Array.isArray(keys) ||
      !keys.every((key) => typeof key === "string" && key !== "")
    ) {
      fail(
        `\`${path}contractFields.${list}\` must be an array of non-empty key names`,
      );
    }
    for (const key of keys as string[]) {
      if (owned.includes(key)) {
        fail(
          `\`${path}contractFields.${list}\` cannot claim \`${key}\`: core checks it`,
        );
      }
    }
  }
}
