import type { AttrTag } from "@mxlang/host-react";
import type { ReactNode } from "react";
import type { Member } from "./members.ts";

export interface Input {
  rows: Member[];
  head: AttrTag;
  row: AttrTag<{ content: (member: Member) => ReactNode }>;
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
