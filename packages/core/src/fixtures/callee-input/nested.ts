type Badge = { as: "renderable" };
export interface Input {
  tabs: AttrTag<{
    attrs: {
      label: string;
      icon?: AttrTag<{ attrs: { badge?: AttrTag<Badge> } }>;
    };
  }>[];
}
