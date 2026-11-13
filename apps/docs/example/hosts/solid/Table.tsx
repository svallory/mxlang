import { For, type JSX, Show } from "solid-js";
import type { AttrTag } from "@mxlang/host-solid";
import type { Member } from "./members.ts";

export interface Input {
  rows: Member[];
  head: AttrTag;
  row: AttrTag<{ content: (member: Member) => () => JSX.Element }>;
  empty?: AttrTag;
}

export function Table(props: Input) {
  return (
    <Show when={props.rows.length} fallback={props.empty?.content?.()}>
      <table>
        <thead>
          <tr>{props.head.content?.()}</tr>
        </thead>
        <tbody>
          <For each={props.rows}>{(member) => <tr>{props.row.content(member)()}</tr>}</For>
        </tbody>
      </table>
    </Show>
  );
}
