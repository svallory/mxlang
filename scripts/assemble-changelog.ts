#!/usr/bin/env bun
//
// Changelog fragments. Every PR adds `changes/<slug>.md`
// (slug = branch name with `/` as `-`) instead of editing a package CHANGELOG,
// which is what made any two open PRs conflict at the top of every file.
// `bun run changelog:assemble` folds every fragment into the `## Unreleased`
// section of each package CHANGELOG it names (creating the section when the
// file has none), in deterministic slug order, then deletes the fragment.
// New entries go at the TOP of the section, one line each with no blank
// line between them; a run's batch keeps slug order and sits above every
// older entry, so the section reads newest batch first.
// `--release <version>` additionally renames `## Unreleased` to
// `## <version> — <date>` in every package CHANGELOG that has one;
// `--packages core,data` (only with `--release`) restricts that rename to the
// named packages, for a release that ships only some of them. Fragment
// folding is never restricted.
//
// Idempotent: a second run with no fragments left changes nothing.

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const root = `${import.meta.dir}/../`;
const kinds = ["Added", "Changed", "Fixed", "Removed"] as const;
type Kind = (typeof kinds)[number];

export interface Fragment {
  slug: string;
  packages: string[];
  kind: Kind;
  body: string;
}

export class FragmentError extends Error {}

// `packages: [core, data]` — workspace short names as used by the CHANGELOG
// headings (the package directory's basename). May be empty for a change that
// belongs to no package (process/docs-only); such a fragment is consumed
// without appending anywhere.
const packagesRe = /^packages:\s*\[(.*)\]\s*$/;
const kindRe = /^kind:\s*(\S+)\s*$/;

export function parseFragment(slug: string, text: string): Fragment {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new FragmentError(`${slug}: expected the file to open with \`---\``);
  }
  const close = lines.indexOf("---", 1);
  if (close === -1) {
    throw new FragmentError(`${slug}: no closing \`---\` for the front matter`);
  }
  let packages: string[] | null = null;
  let kind: Kind | null = null;
  for (const line of lines.slice(1, close)) {
    const pkgMatch = packagesRe.exec(line);
    if (pkgMatch) {
      packages = pkgMatch[1]
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      continue;
    }
    const kindMatch = kindRe.exec(line);
    if (kindMatch) {
      const value = kindMatch[1];
      if (!(kinds as readonly string[]).includes(value)) {
        throw new FragmentError(
          `${slug}: kind must be one of ${kinds.join(" | ")}, got \`${value}\``,
        );
      }
      kind = value as Kind;
    }
  }
  if (packages === null) {
    throw new FragmentError(
      `${slug}: front matter needs a \`packages: [name]\` line`,
    );
  }
  if (kind === null) {
    throw new FragmentError(
      `${slug}: front matter needs a \`kind: Added | Changed | Fixed | Removed\` line`,
    );
  }
  // One Markdown paragraph: the entry is a single changelog line.
  const body = lines
    .slice(close + 1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (body.length === 0) {
    throw new FragmentError(
      `${slug}: the body below the front matter is empty`,
    );
  }
  return { slug, packages, kind, body };
}

// Every `changes/<slug>.md`, in slug order, unparsed. The one reader both
// `changelog:assemble` and the CI fragment check use, so they see the same set.
export function readFragmentFiles(
  changesDir: string,
): { slug: string; text: string }[] {
  if (!existsSync(changesDir)) return [];
  return readdirSync(changesDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      slug: basename(name, ".md"),
      text: readFileSync(join(changesDir, name), "utf8"),
    }));
}

// Discovers every package that owns a CHANGELOG.md, keyed by the short name
// fragments use (the package directory's basename). Scans both workspace
// depths (`packages/*` and `packages/*/*`), so no group list is hardcoded.
export function discoverPackages(repoRoot: string): Map<string, string> {
  const found = new Map<string, string>();
  const groups = readdirSync(join(repoRoot, "packages"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const group of groups) {
    const entries = [
      join(repoRoot, "packages", group),
      ...readdirSync(join(repoRoot, "packages", group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(repoRoot, "packages", group, entry.name)),
    ];
    for (const dir of entries) {
      const changelog = join(dir, "CHANGELOG.md");
      if (!existsSync(changelog)) continue;
      const short = basename(dir);
      if (found.has(short) && found.get(short) !== changelog) {
        throw new FragmentError(
          `duplicate package short name \`${short}\`: ${found.get(short)} and ${changelog}`,
        );
      }
      found.set(short, changelog);
    }
  }
  return found;
}

// The one rule for "this fragment may be assembled": it names only packages
// that own a CHANGELOG.md. `assembleChangelog` and the CI fragment check
// (check-changelog-fragment.ts) both call it, so CI refuses what assemble would.
export function assertFragmentPackages(
  fragment: Fragment,
  packages: ReadonlyMap<string, string>,
): void {
  for (const name of fragment.packages) {
    if (!packages.has(name)) {
      throw new FragmentError(
        `\`${fragment.slug}\` names package \`${name}\`, which has no CHANGELOG.md (known: ${[...packages.keys()].sort().join(", ")})`,
      );
    }
  }
}

const unreleasedHeading = "## Unreleased";

// Inserts `entries` (in the order given, one line each, no blank line between
// them) at the top of the `## Unreleased` section, creating the section right
// under the file's `#` title when the file has none. The blank lines directly
// under the heading become one; every existing line from the section's first
// non-blank line on is kept untouched. An empty section (the next `## `
// heading or the end of the file follows) gets one blank line after the
// entries.
export function prependEntries(
  text: string,
  entries: readonly string[],
): string {
  if (entries.length === 0) return text;
  const lines = text.split("\n");
  const headingIndex = lines.findIndex(
    (line) => line.trim() === unreleasedHeading,
  );
  if (headingIndex === -1) {
    const titleIndex = lines.findIndex((line) => line.startsWith("# "));
    if (titleIndex === -1) {
      throw new FragmentError(
        "CHANGELOG has neither `## Unreleased` nor a `#` title",
      );
    }
    const rest = lines.slice(titleIndex + 1);
    if (rest[0] === "") rest.shift();
    return [
      ...lines.slice(0, titleIndex + 1),
      "",
      unreleasedHeading,
      "",
      ...entries,
      "",
      ...rest,
    ].join("\n");
  }
  let firstContent = headingIndex + 1;
  while (firstContent < lines.length && lines[firstContent].trim() === "") {
    firstContent++;
  }
  const empty =
    firstContent === lines.length || /^## /.test(lines[firstContent]);
  return [
    ...lines.slice(0, headingIndex + 1),
    "",
    ...entries,
    ...(empty ? [""] : []),
    ...lines.slice(firstContent),
  ].join("\n");
}

// Renames the `## Unreleased` heading to `## <version> — <date>`. Files
// without the section are returned unchanged.
export function renameUnreleased(
  text: string,
  version: string,
  date: string,
): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim() === unreleasedHeading);
  if (index === -1) return text;
  lines[index] = `## ${version} — ${date}`;
  return lines.join("\n");
}

function assertKnownPackages(
  names: readonly string[],
  packages: ReadonlyMap<string, string>,
): void {
  const unknown = names.filter((name) => !packages.has(name));
  if (unknown.length > 0) {
    throw new FragmentError(
      `--packages names ${unknown.map((name) => `\`${name}\``).join(", ")}, which has no CHANGELOG.md (known: ${[...packages.keys()].sort().join(", ")})`,
    );
  }
}

export const usage =
  "usage: bun run changelog:assemble [--release <version> [--packages <name,name>]]";

export interface AssembleArgs {
  release?: string;
  packages?: string[];
}

// The CLI's argument parser, pure so it is testable without a spawn. Throws
// a FragmentError (the CLI exits 2 with its message) on a missing value, an
// unknown argument, `--packages` without `--release`, or a package name with
// no CHANGELOG.md among `packages`.
export function parseAssembleArgs(
  args: readonly string[],
  packages: ReadonlyMap<string, string>,
): AssembleArgs {
  const parsed: AssembleArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--release" || arg === "--packages") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        throw new FragmentError(`${arg} needs a value\n${usage}`);
      }
      if (arg === "--release") parsed.release = value;
      else {
        parsed.packages = value
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
      }
      i++;
    } else {
      throw new FragmentError(`unknown argument: ${arg}\n${usage}`);
    }
  }
  if (parsed.packages && !parsed.release) {
    throw new FragmentError(`--packages needs --release\n${usage}`);
  }
  if (parsed.packages) assertKnownPackages(parsed.packages, packages);
  return parsed;
}

export interface AssembleResult {
  appended: number;
  renamedFiles: string[];
  consumedFragments: string[];
}

export function assembleChangelog(
  repoRoot: string,
  opts: {
    release?: string;
    date?: string;
    changesPath?: string;
    /** With `release`, rename only these packages' headings (short names). */
    packages?: readonly string[];
  } = {},
): AssembleResult {
  const changesDir = opts.changesPath ?? join(repoRoot, "changes");
  const fragments: Fragment[] = readFragmentFiles(changesDir).map(
    ({ slug, text }) => parseFragment(slug, text),
  );

  const packages = discoverPackages(repoRoot);
  if (opts.packages) assertKnownPackages(opts.packages, packages);
  // Per package, entries in slug order.
  const byPackage = new Map<string, string[]>();
  for (const fragment of fragments) {
    assertFragmentPackages(fragment, packages);
    for (const name of fragment.packages) {
      const entries = byPackage.get(name) ?? [];
      entries.push(
        `- **${fragment.kind} (${fragment.slug}):** ${fragment.body}`,
      );
      byPackage.set(name, entries);
    }
  }

  let appended = 0;
  for (const [name, entries] of [...byPackage.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const changelogPath = packages.get(name) as string;
    // The whole batch in one call: inserting entry by entry would reverse it.
    const text = prependEntries(readFileSync(changelogPath, "utf8"), entries);
    appended += entries.length;
    writeFileSync(changelogPath, text);
  }

  const renamedFiles: string[] = [];
  if (opts.release) {
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const targets = opts.packages
      ? opts.packages.map((name) => packages.get(name) as string)
      : [...packages.values()];
    for (const changelogPath of [...new Set(targets)].sort()) {
      const text = readFileSync(changelogPath, "utf8");
      const renamed = renameUnreleased(text, opts.release, date);
      if (renamed !== text) {
        writeFileSync(changelogPath, renamed);
        renamedFiles.push(changelogPath);
      }
    }
  }

  for (const fragment of fragments) {
    rmSync(join(changesDir, `${fragment.slug}.md`));
  }

  return {
    appended,
    renamedFiles,
    consumedFragments: fragments.map((f) => f.slug),
  };
}

if (import.meta.main) {
  let args: AssembleArgs;
  try {
    args = parseAssembleArgs(process.argv.slice(2), discoverPackages(root));
  } catch (error) {
    if (!(error instanceof FragmentError)) throw error;
    console.error(error.message);
    process.exit(2);
  }
  const { release, packages } = args;
  const result = assembleChangelog(root, { release, packages });
  for (const slug of result.consumedFragments) {
    console.log(`[changelog] consumed fragment ${slug}`);
  }
  console.log(
    `[changelog] added ${result.appended} entr${result.appended === 1 ? "y" : "ies"}`,
  );
  if (release) {
    console.log(
      `[changelog] renamed ## Unreleased to ## ${release} in ${result.renamedFiles.length} CHANGELOG(s)`,
    );
  }
  if (result.consumedFragments.length === 0 && !release) {
    console.log("[changelog] no fragments in changes/; nothing to do");
  }
}
