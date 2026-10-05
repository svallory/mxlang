/**
 * The side-by-side examples on the host pages.
 *
 * Every host page (and the Hosts intro) opens with one component twice: the
 * framework's own idiomatic version, then the same component with MX in place
 * of the JSX or template. Both are real files in `example/hosts/<dir>/`, next
 * to the hand-written component they call; the page quotes them verbatim, and
 * `host-examples.test.ts` fails when
 *
 *   - the MX file stops compiling through that host's own entry point (so a
 *     docs example cannot outlive the emitter that was supposed to accept it),
 *   - the compile drops a warning,
 *   - the output loses one of the constructs the example exists to show, or
 *   - a page's fenced block no longer matches the file it was copied from.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileNgMx } from "@mxlang/angular";
import { lowerAstroMx } from "@mxlang/astro/template";
import type { MxWarning } from "@mxlang/core";
import { compileHonoRegion } from "@mxlang/hono";
import { print } from "@mxlang/tsx-bridge";
import { compilePreactRegion } from "@mxlang/preact";
import { compileReactRegion } from "@mxlang/react";
import { compileSolidMx } from "@mxlang/solid";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
export const hostsExampleDir = join(docsRoot, "example", "hosts");

export interface HostExample {
  /** The host page, `docs/hosts/<page>.md`. */
  page: string;
  /** The framework's own component, in `example/hosts/<dir>/`. */
  native: string;
  /** The same component with MX in place of the JSX or template. */
  mx: string;
  /** Compiles the MX file through the host's own entry point. */
  compile: (source: string, filename: string, warnings: MxWarning[]) => string;
  /** Strings the compiled output must contain: the constructs on show. */
  emits: string[];
}

type RegionCompile =
  | typeof compileReactRegion
  | typeof compilePreactRegion
  | typeof compileHonoRegion
  | typeof compileSolidMx;

/**
 * A region file (`.<host>.mx`) is a TypeScript module with MX regions; the
 * parser finds each region and hands it to the host, as the Vite plugin does.
 */
function regionFile(compile: RegionCompile): HostExample["compile"] {
  return (source, filename, warnings) =>
    print(source, filename, {
      mx: true,
      mxRegionCompile: (input: { source: string }) =>
        (compile as typeof compileReactRegion)(input.source, {
          ...input,
          warnings,
        }),
    } as Parameters<typeof print>[2]).code;
}

/** What the Team example must still lower to on a JSX-shaped host. */
const TEAM_JSX = [
  'name="q"',
  'id="team"',
  'satisfies NonNullable<Parameters<typeof Table>[0]["row"]>',
  "Nobody matches",
];

export const hostExamples: Record<string, HostExample> = {
  intro: {
    page: "intro",
    native: "intro/Invite.tsx",
    mx: "intro/Invite.react.mx",
    compile: regionFile(compileReactRegion),
    emits: ['name="email"', 'id="email"', 'className="field"', '"title":'],
  },
  react: {
    page: "react",
    native: "react/Team.tsx",
    mx: "react/Team.react.mx",
    compile: regionFile(compileReactRegion),
    emits: [...TEAM_JSX, 'className="panel"', "key={team}"],
  },
  preact: {
    page: "preact",
    native: "preact/Team.tsx",
    mx: "preact/Team.preact.mx",
    compile: regionFile(compilePreactRegion),
    emits: [...TEAM_JSX, 'class="panel"', "key={team}"],
  },
  hono: {
    page: "hono",
    native: "hono/Team.tsx",
    mx: "hono/Team.hono.mx",
    compile: regionFile(compileHonoRegion),
    emits: [...TEAM_JSX, 'class="panel"', "key={team}"],
  },
  solid: {
    page: "solid",
    native: "solid/Team.tsx",
    mx: "solid/Team.solid.mx",
    compile: regionFile(compileSolidMx),
    emits: [...TEAM_JSX, "<For each={member.teams}>", "<Show when={query()}"],
  },
  astro: {
    page: "astro",
    native: "astro/Team.astro",
    mx: "astro/Team.astro.mx",
    compile: (source, filename, warnings) =>
      lowerAstroMx(source, filename, { warnings }).code,
    emits: [
      '<Fragment slot="title">',
      '<Fragment slot="footer">',
      "class:list={{ admin: member.admin }}",
      "No members yet.",
    ],
  },
  angular: {
    page: "angular",
    native: "angular/team.component.ts",
    mx: "angular/team.component.ng.mx",
    compile: (source, filename, warnings) =>
      compileNgMx(source, filename, { warnings }).code,
    emits: [
      'ngProjectAs="[title]"',
      "imports: [Card, NgClass]",
      "@for (member of shown; track member.id)",
      'name="q"',
      "} @else {",
    ],
  },
};

export function readHostExample(file: string): string {
  return readFileSync(join(hostsExampleDir, file), "utf8");
}

export function hostPage(page: string): string {
  return readFileSync(join(docsRoot, "docs", "hosts", `${page}.md`), "utf8");
}

/** The bodies of every fenced code block in a markdown file. */
export function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /^```[^\n]*\n([\s\S]*?)^```$/gm;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) blocks.push(m[1]);
  return blocks;
}
