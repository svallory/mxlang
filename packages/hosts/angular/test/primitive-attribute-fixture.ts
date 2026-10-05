import { compile } from "../src/index.ts";

/** Names of the shared parity matrix (`scripts/attribute-value-probe.ts --parity`), direct form only: Angular rejects spreads. */
const names = [
  "title",
  "data-x",
  "aria-x",
  "class",
  "style",
  "disabled",
  "checked",
  "value",
  "autofocus",
  "readonly",
  "selected",
  "required",
  "open",
  "allowfullscreen",
  "checked@div",
];
const templates = [];
for (const name of names) {
  const attribute = name.replace("@div", "");
  const tag = name === "checked" || name === "value" ? "input" : "div";
  try {
    templates.push({
      form: `${name}/direct`,
      template: compile(`<${tag} ${attribute}=input.v/>`, "primitive.mx").code,
    });
  } catch (error) {
    templates.push({
      form: `${name}/direct`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
process.stdout.write(JSON.stringify(templates));
