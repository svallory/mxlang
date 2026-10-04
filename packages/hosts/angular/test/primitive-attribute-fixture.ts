import { compile } from "../src/index.ts";

const names = [
  "title",
  "data-x",
  "aria-hidden",
  "is:raw",
  "disabled",
  "hidden",
  "checked",
  "class",
  "style",
];
const templates = [];
for (const name of names) {
  const tag = name === "checked" ? "input" : "div";
  const forms: Record<string, string> = {
    direct: `<${tag} ${name}=input.v/>`,
    spread: `<${tag} ...input.attrs/>`,
    folded: `<${tag} ${name}=input.v ...{}/>`,
    tail: `<${tag} ...{} ${name}=input.v/>`,
    dynamicName: `<${tag} ...{[input.name]:input.v}/>`,
    dynamic: `<\${input.tag} ${name}=input.v/>`,
    dynamicArgs: `<\${input.tag}(input.attrs)/>`,
    bound: `<${tag} ${name}:=input.v/>`,
  };
  for (const [form, source] of Object.entries(forms)) {
    try {
      templates.push({
        form: `${name}/${form}`,
        template: compile(source, "primitive.mx").code,
      });
    } catch (error) {
      templates.push({
        form: `${name}/${form}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
process.stdout.write(JSON.stringify(templates));
