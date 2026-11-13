import type { AttrTag } from "@mxlang/host-react";
import type { ReactNode } from "react";

export interface Input {
  open: boolean;
  title: AttrTag;
  actions: AttrTag;
  children?: ReactNode;
}

export function Dialog({ open, title, actions, children }: Input) {
  return (
    <dialog open={open}>
      <h2>{title.content}</h2>
      {children}
      <footer>{actions.content}</footer>
    </dialog>
  );
}
