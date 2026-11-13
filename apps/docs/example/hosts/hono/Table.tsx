import type { AttrTag } from "@mxlang/host-hono";
import type { Child } from "hono/jsx";
import type { Member } from "./members.ts";

export interface Input {
  rows: Member[];
  head: AttrTag;
  row: AttrTag<{ content: (member: Member) => Child }>;
  empty?: AttrTag;
}

export function Table({ rows, head, row, empty }: Input) {
  if (rows.length === 0) return <>{empty?.content}</>;
  return (
    <table>
      <thead>
        <tr>{head.content}</tr>
      </thead>
      <tbody>
        {rows.map((member) => (
          <tr key={member.id}>{row.content(member)}</tr>
        ))}
      </tbody>
    </table>
  );
}
