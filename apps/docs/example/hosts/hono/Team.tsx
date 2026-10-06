import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team({ members, query }: { members: Member[]; query: string }) {
  const shown = members.filter((member) => member.name.includes(query));

  return (
    <section id="team" class="panel">
      <form method="get">
        <input name="q" class="search" type="search" value={query} />
      </form>
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
            <td class={member.admin ? "admin" : undefined}>{member.name}</td>
            <td>
              {member.teams.map((team) => (
                <span key={team} class="tag">
                  {team}
                </span>
              ))}
            </td>
          </>
        )}
        empty={
          query ? (
            <p class="empty">Nobody matches “{query}”.</p>
          ) : (
            <p class="empty">No members yet.</p>
          )
        }
      />
    </section>
  );
}
