import { parseFragment } from "./packages/core/src/fragment.ts";

const { body } = parseFragment("<div .hover:bg-red/>", { filename: "test.mx" });
console.log(JSON.stringify(body[0].attributes, null, 2));
