import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "./index.ts";

// A real project under this package, so compiler-cli and core resolve exactly
// as they do for an Angular app. No generated tag .ts files exist on disk.
describe("Angular checking with virtual tag dependencies", () => {
  it("resolves nested tag imports and refreshes a callee's input type on the next check", () => {
    const dir = realpathSync(
      mkdtempSync(join(import.meta.dirname, "virtual-tags-")),
    );
    let checker: ReturnType<typeof createAngularChecker> | undefined;
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ mx: { host: "angular" } }),
      );
      mkdirSync(join(dir, "tags"));
      const tag = join(dir, "tags", "user-card.mx");
      const sourceOfTag = (type: string) =>
        `export interface Input { title: ${type} }\n<child title=input.title/>`;
      writeFileSync(tag, sourceOfTag("string"));
      writeFileSync(
        join(dir, "tags", "child.mx"),
        `export interface Input { title: string }\n<span>\${input.title}</span>`,
      );
      const file = join(dir, "x.component.ts");
      const source = `import { Component } from "@angular/core";
import { UserCard } from "./tags/user-card";
@Component({ selector: "app-x", standalone: true, imports: [UserCard],
  template: \`<mx-user-card [title]="title"></mx-user-card><p>{{ title.nmae }}</p>\` })
export class XComponent { title = "hi"; }
`;
      checker = createAngularChecker({ projectDir: dir });
      const initial = checker.check(file, source);
      expect(initial.filter((d) => d.source === "ts")).toEqual([]);
      expect(initial.map((d) => d.code)).not.toContain(-991010);
      expect(initial.find((d) => d.code === 2339)?.start).toBe(
        source.indexOf("nmae"),
      );
      writeFileSync(tag, sourceOfTag("number"));
      const changed = checker.check(file, source);
      expect(changed.some((d) => d.source === "ngtsc" && d.code === 2322)).toBe(
        true,
      );
      expect(changed.map((d) => d.code)).not.toContain(-991010);
    } finally {
      checker?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
