export const UNKNOWN = 0;
export const NAME = 1;
export const VALUE = 2;
export const ARGUMENT = 3;
export const TYPE_PARAMS = 4;
export const BLOCK = 5;
/** MX (decision 182): the `=value` of an attribute trigger. */
export const TRIGGER_VALUE = 6;

export type AttrStage =
  | typeof UNKNOWN
  | typeof NAME
  | typeof VALUE
  | typeof ARGUMENT
  | typeof TYPE_PARAMS
  | typeof BLOCK
  | typeof TRIGGER_VALUE;
