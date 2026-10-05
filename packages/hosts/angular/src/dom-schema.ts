import { createRequire } from "node:module";

/**
 * Angular's own DOM schema, read from the compiler's `DomElementSchemaRegistry`
 * (the registry NG8002 itself consults), never from a hand-kept list.
 *
 * The registry is created on first use: `@angular/compiler` is only loaded
 * when a template binds a dynamic attribute on a native element.
 */
interface Registry {
  hasProperty(tag: string, name: string, schemas: unknown[]): boolean;
  getMappedPropName(name: string): string;
  allKnownElementNames(): string[];
  /** The registry's per-element `name -> "boolean" | "number" | "string"` map; private in Angular. */
  _schema?: Map<string, Map<string, string>>;
}

let registry: Registry | undefined;
const elsewhere = new Map<string, boolean>();

function load(): Registry {
  if (!registry) {
    const compiler = createRequire(import.meta.url)("@angular/compiler") as {
      DomElementSchemaRegistry: new () => Registry;
    };
    registry = new compiler.DomElementSchemaRegistry();
  }
  return registry;
}

/** How a plain dynamic attribute name binds on a native element. */
export type NativeBinding =
  /** A DOM property of this element: `[name]`, with the property's own type. */
  | { kind: "property"; type: "boolean" | "other" }
  /** Known to the schema, but not a property of this element: `[attr.name]`. */
  | { kind: "attribute" }
  /** Unknown to the whole schema (a directive input, a typo): `[name]` untouched. */
  | { kind: "unknown" };

export function nativeBinding(tag: string, name: string): NativeBinding {
  const schema = load();
  const mapped = schema.getMappedPropName(name);
  if (schema.hasProperty(tag, mapped, [])) {
    const properties =
      schema._schema?.get(tag.toLowerCase()) ?? schema._schema?.get("unknown");
    return {
      kind: "property",
      type: properties?.get(mapped) === "boolean" ? "boolean" : "other",
    };
  }
  let known = elsewhere.get(mapped);
  if (known === undefined) {
    known = schema
      .allKnownElementNames()
      .some((element) => schema.hasProperty(element, mapped, []));
    elsewhere.set(mapped, known);
  }
  return known ? { kind: "attribute" } : { kind: "unknown" };
}
