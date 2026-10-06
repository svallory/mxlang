import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function mxTwins(scratch: string): void {
  for (const file of markoFiles(scratch)) {
    const twin = file.replace(/\.marko$/, ".mx");
    if (existsSync(twin)) {
      rmSync(file);
      continue;
    }
    const source = readFileSync(file, "utf8").replace(
      /(from\s+["'])(\.[^"']*)\.marko(["'])/g,
      "$1$2.mx$3",
    );
    writeFileSync(twin, source);
    rmSync(file);
  }
}

function markoFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...markoFiles(full));
    else if (entry.endsWith(".marko")) results.push(full);
  }
  return results;
}
