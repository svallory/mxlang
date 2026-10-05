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
for (const [form, source] of Object.entries({
  "structural/ngFor":
    '<li *ngFor="let p of input.items" title=p data-x=p class=p/>',
  "structural/ngIf": '<li *ngIf="input.items as list" title=list.length/>',
})) {
  templates.push({ form, template: compile(source, "primitive.mx").code });
}
/** DOM-property cells and the unknown-name cases (`tag/name`), see primitive-attributes.test.ts. */
for (const [tag, name] of [
  ["div", "title"],
  ["div", "hidden"],
  ["div", "draggable"],
  ["div", "tabindex"],
  ["button", "disabled"],
  ["option", "selected"],
  ["div", "header"],
  ["div", "hi"],
]) {
  templates.push({
    form: `cell/${tag}/${name}`,
    template: compile(`<${tag} ${name}=input.v/>`, "primitive.mx").code,
  });
}
templates.push({
  form: "slot/header",
  template: compile(
    "<app-child><div header=input.v>H</div></app-child>",
    "primitive.mx",
  ).code,
});
process.stdout.write(JSON.stringify(templates));
