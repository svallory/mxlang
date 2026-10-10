import type { AttrTag } from "@mxlang/host-react";
import type { ReactNode } from "react";

export interface Input {
  open: boolean;
  title: AttrTag<{ as: "renderable" }>;
  actions: AttrTag<{ as: "renderable" }>;
  children?: ReactNode;
}

export function Dialog({ open, title, actions, children }: Input) {
  return (
    <dialog open={open}>
      <h2>{title}</h2>
      {children}
      <footer>{actions}</footer>
    </dialog>
  );
}
