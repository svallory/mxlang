import varType from "./VarType.mx";
import wrongProp from "./WrongProp.mx";

// Both templates are type-checked for their own sake; the exports keep the
// fixture from being dead code the compiler could skip.
export const a: string = wrongProp({ title: "hi" });
export const b: string = varType({ title: "hi" });
