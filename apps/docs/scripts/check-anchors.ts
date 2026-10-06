/**
 * `bun run check:anchors` — the last step of the docs build, after
 * `docmd build`.
 *
 * It walks the built `site/` and fails on any `#fragment` href that resolves
 * to no `id`, printing one `page: href -> missing id` line each. Only the
 * built HTML carries docmd's real ids (the page-title/parent-heading
 * prefixes), so this cannot run before `docmd build` and is not a check over
 * the markdown; see `anchors.ts` for why.
 *
 * CI runs it through `bun run --cwd apps/docs build` (`pack-probe-docs`), and
 * `apps/docs test` covers the same walk against the built site when one
 * exists.
 */

import { existsSync } from "node:fs";
import {
  findBrokenAnchors,
  formatBrokenAnchors,
  siteHtmlFiles,
  siteRoot,
} from "./anchors.ts";

if (!existsSync(siteRoot)) {
  console.error(
    `check:anchors: ${siteRoot} does not exist. It reads the built site, so run it ` +
      `after \`docmd build\` (\`bun run build\` in apps/docs).`,
  );
  process.exit(1);
}

const broken = findBrokenAnchors(siteRoot);

if (broken.length > 0) {
  const pages = siteHtmlFiles(siteRoot).length;
  console.error(
    `check:anchors: ${broken.length} fragment link(s) resolve to no heading in the ` +
      `built site (${pages} pages checked):`,
  );
  for (const line of formatBrokenAnchors(broken)) console.error(`  ${line}`);
  console.error(
    `  docmd prefixes a heading id with its parent headings and the page title, ` +
      `so the fix is the id the target page's heading actually generates.`,
  );
  process.exit(1);
}

console.log(`check:anchors: every fragment link in the built site resolves.`);
