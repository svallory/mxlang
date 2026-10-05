import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/**
 * Angular's own DOM schema, read from the compiler's `DomElementSchemaRegistry`
 * (the registry NG8002 itself consults), never from a hand-kept list.
 *
 * `@angular/compiler` is an optional peer dependency, never bundled: it is
 * resolved from the project the compiled file belongs to (the copy whose
 * schema the project's own NG8002 uses), then from this package's own
 * location, the way `@mxlang/angular-checker` resolves `@angular/compiler-cli`.
 * It is loaded only when a template binds a dynamic attribute on a native
 * element; when it cannot be, {@link AngularCompilerUnavailableError} says
 * what to install, and the emitter positions it at that attribute.
 */

/** The `@angular/compiler` versions this host is tested against. */
export const SUPPORTED_COMPILER_RANGE = ">=22.0.0 <23.0.0";

/** The version the private `_schema` shape below was checked against. */
export const SCHEMA_SHAPE_CHECKED_AGAINST = "22.1.7";

/** The public registry API this host uses. */
interface Registry {
  hasProperty(tag: string, name: string, schemas: unknown[]): boolean;
  getMappedPropName(name: string): string;
  allKnownElementNames(): string[];
  /** A tag's DOM property names, in their IDL spelling (`maxLength`). */
  allKnownAttributesOfElement(tag: string): string[];
}

/**
 * The registry's private per-element `name -> "boolean" | "number" |
 * "string" | "object"` map. No public API exposes a property's type, and
 * boolean-ness decides whether `[name]` gets a real boolean (`hidden`,
 * `checked`) or the value text, so this one read is private and its shape is
 * checked on load (and pinned by a test) instead of degrading silently.
 */
type TypeMap = Map<string, Map<string, string>>;

/** Thrown when no usable `@angular/compiler` resolves; the message says what to install. */
export class AngularCompilerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AngularCompilerUnavailableError";
  }
}

interface Schema {
  registry: Registry;
  types: TypeMap;
  /** Lowercased IDL property name -> known on some element. */
  lowercased: Set<string>;
}

const HOW_TO_FIX = `install a supported @angular/compiler (${SUPPORTED_COMPILER_RANGE}) in your project (\`bun add -d @angular/compiler\`); @mxlang/angular reads Angular's DOM schema from it to decide between \`[name]\` and \`[attr.name]\` for a dynamic attribute on a native element`;

/** One schema per resolved `@angular/compiler` package. */
const schemas = new Map<string, Schema>();
/** Project directory -> its resolved package (or the error to raise again). */
const resolved = new Map<string, string | AngularCompilerUnavailableError>();

function resolvePackage(fromFile: string): string {
  const projectDir = dirname(resolve(fromFile));
  let hit = resolved.get(projectDir);
  if (hit === undefined) {
    hit = new AngularCompilerUnavailableError(
      `@angular/compiler was not found from ${projectDir}: ${HOW_TO_FIX}.`,
    );
    for (const anchor of [join(projectDir, "noop.js"), import.meta.url]) {
      try {
        hit = createRequire(anchor).resolve("@angular/compiler/package.json");
        break;
      } catch {}
    }
    resolved.set(projectDir, hit);
  }
  if (hit instanceof AngularCompilerUnavailableError) throw hit;
  return hit;
}

function load(fromFile: string): Schema {
  const packageJson = resolvePackage(fromFile);
  const cached = schemas.get(packageJson);
  if (cached) return cached;
  const requireCompiler = createRequire(packageJson);
  const { version } = requireCompiler(packageJson) as { version?: unknown };
  if (typeof version !== "string" || !/^22\./.test(version)) {
    throw new AngularCompilerUnavailableError(
      `@angular/compiler ${String(version)} (${packageJson}) is outside the supported range ${SUPPORTED_COMPILER_RANGE}: ${HOW_TO_FIX}.`,
    );
  }
  const compiler = requireCompiler("@angular/compiler") as {
    DomElementSchemaRegistry: new () => Registry & { _schema?: unknown };
  };
  const registry = new compiler.DomElementSchemaRegistry();
  const types = registry._schema;
  if (!isTypeMap(types)) {
    throw new AngularCompilerUnavailableError(
      `@angular/compiler ${version} no longer has the DomElementSchemaRegistry type map @mxlang/angular reads (checked against ${SCHEMA_SHAPE_CHECKED_AGAINST}); please report this to mx`,
    );
  }
  const lowercased = new Set<string>();
  for (const element of registry.allKnownElementNames()) {
    for (const property of registry.allKnownAttributesOfElement(element)) {
      lowercased.add(property.toLowerCase());
    }
  }
  const schema = { registry, types, lowercased };
  schemas.set(packageJson, schema);
  return schema;
}

/** The private map exists and still classifies two properties as it did when checked. */
function isTypeMap(value: unknown): value is TypeMap {
  if (!(value instanceof Map)) return false;
  const input = value.get("input");
  return (
    input instanceof Map &&
    input.get("checked") === "boolean" &&
    input.get("value") === "string"
  );
}

/**
 * Writable DOM properties whose IDL type is an interface, so binding a
 * primitive to them throws at render. Angular's schema has no read-only
 * properties (measured: none of its entries is a getter-only accessor in
 * jsdom), and its `"object"` type also covers nullable strings and
 * `[PutForwards=value]` token lists (`part`, `sandbox`, `sizes`), which do
 * accept a string; these are the lowercase-spelled ones that do not:
 * - `input.files`: `attribute FileList? files`,
 *   https://html.spec.whatwg.org/multipage/input.html#dom-input-files
 * - `table.caption`: `attribute HTMLTableCaptionElement? caption`,
 *   https://html.spec.whatwg.org/multipage/tables.html#dom-table-caption
 */
export const INTERFACE_TYPED_PROPERTIES: ReadonlyMap<string, string> = new Map([
  ["input", "files"],
  ["table", "caption"],
]);

/** How a plain dynamic attribute name binds on a native element. */
export type NativeBinding =
  /** A DOM property of this element: `[name]`, with the property's own type. */
  | { kind: "property"; type: "boolean" | "other" }
  /** A real attribute that is not a writable primitive property here: `[attr.name]`. */
  | { kind: "attribute" }
  /** Unknown to the whole schema (a directive input, a typo): `[name]` untouched. */
  | { kind: "unknown" };

/**
 * How `name` (a plain lowercase attribute) binds on `tag`. `fromFile` is the
 * file being compiled: `@angular/compiler` is resolved from its project.
 *
 * Throws {@link AngularCompilerUnavailableError} when no supported
 * `@angular/compiler` resolves.
 */
export function nativeBinding(
  tag: string,
  name: string,
  fromFile: string,
): NativeBinding {
  const { registry, types, lowercased } = load(fromFile);
  const mapped = registry.getMappedPropName(name);
  const element = tag.toLowerCase();
  if (registry.hasProperty(tag, mapped, [])) {
    if (INTERFACE_TYPED_PROPERTIES.get(element) === mapped) {
      return { kind: "attribute" };
    }
    const properties = types.get(element) ?? types.get("unknown");
    return {
      kind: "property",
      type: properties?.get(mapped) === "boolean" ? "boolean" : "other",
    };
  }
  // The attribute's own spelling misses the registry, but HTML attributes are
  // case-insensitive and the registry keys their IDL spelling (`maxlength` is
  // `maxLength`): any element knowing the name in any case makes it a real
  // attribute, which Marko prints as one.
  return lowercased.has(name) || lowercased.has(mapped.toLowerCase())
    ? { kind: "attribute" }
    : { kind: "unknown" };
}
