/**
 * Decision 163 addendum 8 item 3 (and the B1 review finding): every atom the
 * template parser announces is listed by exactly one container. `atomLoss`
 * parses `source` twice, once through the front end and once through the
 * template parser with the same tag types, and returns what does not match.
 */
import type { MxBodyMode, MxStatementKeyword } from "@mxlang/babel/mx-ast";
import { createParser, TagType } from "../../template/index.ts";
import { parse } from "../parse.ts";
import { allAtoms } from "./invariants.ts";

const TYPE: Record<MxBodyMode, number | undefined> = {
  html: undefined,
  preserve: undefined,
  "parsed-text": TagType.text,
  "parsed-text-preserve": TagType.text,
  void: TagType.void,
};

/** The atoms the parser announces and the end of the last other event it reported. */
function announced(
  source: string,
  statementKeywords: ReadonlySet<MxStatementKeyword>,
  tagShape: (name: string) => MxBodyMode,
): { atoms: string[]; lastEventEnd: number } {
  const atoms: string[] = [];
  let lastEventEnd = 0;
  let open: number | undefined;
  const handlers = new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string" || !name.startsWith("on"))
          return undefined;
        return (event: {
          start: number;
          end: number;
          expressions?: unknown[];
        }) => {
          if (name === "onAtom") {
            atoms.push(`${event.start},${event.end}`);
            return undefined;
          }
          lastEventEnd = Math.max(lastEventEnd, event.end);
          if (name === "onOpenTagStart") open = event.start;
          if (name !== "onOpenTagName") return undefined;
          const concise = open === undefined;
          open = undefined;
          if (event.expressions?.length) return undefined;
          const written = source.slice(event.start, event.end);
          if (concise && statementKeywords.has(written as MxStatementKeyword)) {
            return TagType.statement;
          }
          if (written.startsWith("@")) return undefined;
          return TYPE[tagShape(written)];
        };
      },
    },
  );
  try {
    createParser(handlers).parse(source);
  } catch {
    // a template-parser throw is the front end's internal error, tested apart
  }
  return { atoms, lastEventEnd };
}

/**
 * The problems with the atoms of one input: an atom listed twice, an atom
 * listed that was never announced, or an announced atom no container lists.
 * The last is allowed only where the parse itself lost the construct: after
 * a template error, or past the parser's last event at a silent end of
 * input (TODO `concise-eof-interpolation-drops-event`).
 */
export function atomLoss(
  source: string,
  statementKeywords: ReadonlySet<MxStatementKeyword>,
  tagShape: (name: string) => MxBodyMode,
): string[] {
  const document = parse(source, { statementKeywords, tagShape });
  const offset = document.base.offset;
  const listed = allAtoms(document).map(
    (a) => `${a.start - offset},${a.end - offset}`,
  );
  const { atoms, lastEventEnd } = announced(
    source,
    statementKeywords,
    tagShape,
  );
  const problems: string[] = [];
  if (new Set(listed).size !== listed.length)
    problems.push(`listed twice: ${listed}`);
  for (const atom of listed) {
    if (!atoms.includes(atom)) problems.push(`listed, not announced: ${atom}`);
  }
  for (const atom of atoms) {
    if (listed.includes(atom)) continue;
    const start = Number(atom.split(",")[0]);
    const lostByTheParse = !document.complete || start >= lastEventEnd;
    if (!lostByTheParse) problems.push(`announced, in no container: ${atom}`);
  }
  return problems;
}
