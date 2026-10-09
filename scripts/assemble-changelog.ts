#!/usr/bin/env bun
//
// decision 190 item 4: changelog fragments. Every PR adds `changes/<slug>.md`
// (slug = branch name with `/` as `-`) instead of editing a package CHANGELOG,
// which is what made any two open PRs conflict at the top of every file.
// `bun run changelog:assemble` folds every fragment into the `## Unreleased`
// section of each package CHANGELOG it names (creating the section when the
// file has none), in deterministic slug order, then deletes the fragment.
// `--release <version>` additionally renames `## Unreleased` to
// `## <version> — <date>` in every package CHANGELOG that has one.
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
const changesDir = join(root, "changes");
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

const unreleasedHeading = "## Unreleased";

// Appends one entry line at the end of the `## Unreleased` section, creating
// the section right under the file's `#` title when the file has none. Never
// reformats existing lines: it only inserts.
export function appendEntry(text: string, entry: string): string {
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
      entry,
      "",
      ...rest,
    ].join("\n");
  }
  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  let lastContent = sectionEnd;
  while (
    lastContent > headingIndex + 1 &&
    lines[lastContent - 1].trim() === ""
  ) {
    lastContent--;
  }
  return [
    ...lines.slice(0, lastContent),
    "",
    entry,
    "",
    ...lines.slice(sectionEnd),
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

export interface AssembleResult {
  appended: number;
  renamedFiles: string[];
  consumedFragments: string[];
}

export function assembleChangelog(
  repoRoot: string,
  opts: { release?: string; date?: string; changesPath?: string } = {},
): AssembleResult {
  const changesDir = opts.changesPath ?? join(repoRoot, "changes");
  const fragments: Fragment[] = existsSync(changesDir)
    ? readdirSync(changesDir)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) =>
          parseFragment(
            basename(name, ".md"),
            readFileSync(join(changesDir, name), "utf8"),
          ),
        )
    : [];

  const packages = discoverPackages(repoRoot);
  // Per package, entries in slug order.
  const byPackage = new Map<string, string[]>();
  for (const fragment of fragments) {
    for (const name of fragment.packages) {
      if (!packages.has(name)) {
        throw new FragmentError(
          `\`${fragment.slug}\` names package \`${name}\`, which has no CHANGELOG.md (known: ${[...packages.keys()].sort().join(", ")})`,
        );
      }
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
    let text = readFileSync(changelogPath, "utf8");
    for (const entry of entries) {
      text = appendEntry(text, entry);
      appended++;
    }
    writeFileSync(changelogPath, text);
  }

  const renamedFiles: string[] = [];
  if (opts.release) {
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    for (const changelogPath of [...packages.values()].sort()) {
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
  const args = process.argv.slice(2);
  let release: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--release") {
      release = args[i + 1];
      if (!release) {
        console.error(
          "usage: bun run changelog:assemble [--release <version>]",
        );
        process.exit(2);
      }
      i++;
    } else {
      console.error(`unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  const result = assembleChangelog(root, { release });
  for (const slug of result.consumedFragments) {
    console.log(`[changelog] consumed fragment ${slug}`);
  }
  console.log(
    `[changelog] appended ${result.appended} entr${result.appended === 1 ? "y" : "ies"}`,
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
