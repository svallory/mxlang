import { createSignal, For, Show } from "solid-js";
import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team(props: { members: Member[] }) {
  const [query, setQuery] = createSignal("");
  const shown = () => props.members.filter((member) => member.name.includes(query()));

  return (
    <section id="team" class="panel">
      <input
        name="q"
        class="search"
        type="search"
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <Table
        rows={shown()}
        head={() => (
          <>
            <th>Name</th>
            <th>Teams</th>
          </>
        )}
        row={(member) => () => (
          <>
            <td class={{ admin: member.admin }}>{member.name}</td>
            <td>
              <For each={member.teams}>{(team) => <span class="tag">{team}</span>}</For>
            </td>
          </>
        )}
        empty={() => (
          <Show when={query()} fallback={<p class="empty">No members yet.</p>}>
            <p class="empty">Nobody matches “{query()}”.</p>
          </Show>
        )}
      />
    </section>
  );
}
