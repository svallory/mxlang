import { escape as __mxEscape, createOut as __mxCreateOut, type Out as __MxOut } from "@mxlang/html";

export interface Input {
  name: string;
  items: string[];
}

function Greeting(input: Input): string {
  const __mxOut = __mxCreateOut();
  __mxRender(input, __mxOut);
  return __mxOut.toString();
}
Greeting.render = __mxRender;

function __mxRender(input: Input, __mxOut: __MxOut): void {
  const count = input.items.length;
  __mxOut.write("<h1 class=\"title\">Hello, ");
  __mxOut.write(__mxEscape(input.name));
  __mxOut.write("!</h1>");
  if (count) {
    __mxOut.write("<ul>");
    const __mxFor6 = input.items;
    const __mxFor7 = __mxFor6 ? __mxFor6 : [];
    for (const item of __mxFor7) {
      __mxOut.write("<li>");
      __mxOut.write(__mxEscape(item));
      __mxOut.write("</li>");
    }
    __mxOut.write("</ul>");
  } else {
    __mxOut.write("<p hidden>Nothing yet.</p>");
  }
}
export { __mxRender as render };
Object.defineProperty(Greeting, Symbol.for("mx.component"), { value: true });

export default Greeting as ((input: Input) => string) & { render: typeof __mxRender };
