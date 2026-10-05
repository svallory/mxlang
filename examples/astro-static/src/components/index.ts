// A `.ts` barrel re-exporting a unit that declares `<return>`: a caller that
// imports it from here sees only a value, so it renders through the unit's
// `.render` sink entry (decision 155) rather than its compiled metadata.
export { default as Counter } from "./counter.mx";
