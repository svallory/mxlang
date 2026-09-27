// biome-ignore lint/correctness/noUnusedImports: proves an unrelated AttrTag import cannot leak
import type { AttrTag } from "some-lib";
export type Cfg = { as: "renderable" };
