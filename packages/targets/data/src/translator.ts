/**
 * The Marko translator a data file compiles under: the data taglib plus
 * core's own entries. Required lazily (it reaches `@marko/compiler`), so the
 * descriptor stays light. `parse.ts` compiles through the same configuration
 * (`compileSource` builds it from these taglibs), which is what lets the
 * registry answer "is this a plain tag here?" from the lookup a data compile
 * really uses.
 */
import {
  createTranslator,
  type TargetLookup,
  type Translator,
} from "@mxlang/core";
import { dataTaglib } from "./taglib.ts";

export function dataTranslator(targets: TargetLookup): Translator {
  return createTranslator({
    taglibs: [dataTaglib()],
    statementTags: false,
    tagDiscoveryDirs: [],
    targets,
  });
}
