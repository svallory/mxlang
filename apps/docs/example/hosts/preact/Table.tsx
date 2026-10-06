import type { AttrTag } from "@mxlang/preact";
import type { Member } from "./members.ts";

export interface Input {
  rows: Member[];
  head: AttrTag<{ as: "renderable" }>;
  row: AttrTag<{ as: "renderable"; params: [member: Member] }>;
  empty?: AttrTag<{ as: "renderable" }>;
}

export function Table({ rows, head, row, empty }: Input) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <table>
      <thead>
        <tr>{head}</tr>
      </thead>
      <tbody>
        {rows.map((member) => (
          <tr key={member.id}>{row(member)}</tr>
        ))}
      </tbody>
    </table>
  );
}
