import { compilePreactRegion } from "./packages/hosts/preact/src/index.ts";

const source = `const x = <div.w-1/>;`;
const bad = `const x = <div.w-1/2/>;`;

for (const src of [source, bad]) {
  try {
    const result = compilePreactRegion(src, { filename: "test.preact.mx" });
    console.log(`${src} => OK: ${result.code.slice(0, 80)}`);
  } catch (e) {
    console.log(`${src} => ERROR: ${(e as Error).message.split("\n").slice(0, 6).join("\n")}`);
  }
}
