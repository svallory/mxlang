import { For, Show } from "solid-js";
import type { AttrTag } from "@mxlang/host-solid";
import type { Member } from "./members.ts";

export interface Input {
  rows: Member[];
  head: AttrTag<{ as: "renderable" }>;
  row: AttrTag<{ as: "renderable"; params: [member: Member] }>;
  empty?: AttrTag<{ as: "renderable" }>;
}

export function Table(props: Input) {
  return (
    <Show when={props.rows.length} fallback={props.empty?.()}>
      <table>
        <thead>
          <tr>{props.head()}</tr>
        </thead>
        <tbody>
          <For each={props.rows}>{(member) => <tr>{props.row(member)()}</tr>}</For>
        </tbody>
      </table>
    </Show>
  );
}
