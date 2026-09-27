export interface Input {
  title: string;
  count?: number;
  header?: AttrTag<{ as: "renderable" }>;
  footer: AttrTag<{ params: [year: number] }>;
  items: AttrTag<{ as: "data"; attrs: { id: string } }>[];
  groups: Array<AttrTag<{ attrs: { label: string } }>>;
  readonlyItems: readonly AttrTag[];
  optionalItems?: AttrTag[];
}
