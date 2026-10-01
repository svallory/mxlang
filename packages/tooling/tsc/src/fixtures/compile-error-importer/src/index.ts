import type { Input as TypeOnly } from "./Broken.mx";
import * as NS from "./Broken.mx";
import Broken, { helper, type Input } from "./Broken.mx";

export const uses: [
  unknown,
  unknown,
  unknown,
  unknown,
  Input<number>,
  TypeOnly,
] = [Broken, helper, NS.default, NS.helper, null as never, null as never];
