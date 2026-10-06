import { useState } from "react";
import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team({ members }: { members: Member[] }) {
  const [query, setQuery] = useState("");
  const shown = members.filter((member) => member.name.includes(query));

  return (
    <section id="team" className="panel">
      <input
        name="q"
        className="search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <Table
        rows={shown}
        head={
          <>
            <th>Name</th>
            <th>Teams</th>
          </>
        }
        row={(member) => (
          <>
            <td className={member.admin ? "admin" : undefined}>{member.name}</td>
            <td>
              {member.teams.map((team) => (
                <span key={team} className="tag">
                  {team}
                </span>
              ))}
            </td>
          </>
        )}
        empty={
          query ? (
            <p className="empty">Nobody matches “{query}”.</p>
          ) : (
            <p className="empty">No members yet.</p>
          )
        }
      />
    </section>
  );
}
