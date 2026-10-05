import { escape as __mxEscape } from "@mxlang/html";

export interface Input {
  name: string;
  items: string[];
}

function Greeting(input: Input): string {
  let __mxOut = "";
  const count = input.items.length;
  __mxOut += "<h1 class=\"title\">Hello, ";
  __mxOut += __mxEscape(input.name);
  __mxOut += "!</h1>";
  if (count) {
    __mxOut += "<ul>";
    const __mxFor6 = input.items;
    const __mxFor7 = __mxFor6 ? __mxFor6 : [];
    for (const item of __mxFor7) {
      __mxOut += "<li>";
      __mxOut += __mxEscape(item);
      __mxOut += "</li>";
    }
    __mxOut += "</ul>";
  } else {
    __mxOut += "<p hidden>Nothing yet.</p>";
  }
  return __mxOut;
}
Object.defineProperty(Greeting, Symbol.for("mx.component"), { value: true });

export default Greeting;
