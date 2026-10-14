import { describe, expect, it } from "vitest";
import { createPluginService } from "./fixtures/plugin-service.ts";

/**
 * The editor path for a `server`/`client` statement: a type error inside one
 * lands on the token the author wrote, not on the start of the file. The
 * html target records the mapping when it emits the statement; the tooling
 * projection also emits a `client` statement's own code, so it is checked.
 */

const FILE = "/project/page.mx";
const CONSUMER = "/project/index.ts";

function errors(source: string) {
  const service = createPluginService(
    { [FILE]: source, [CONSUMER]: 'import "./page.mx";\n' },
    [CONSUMER],
  );
  service.getSemanticDiagnostics(CONSUMER);
  return service
    .getSemanticDiagnostics(FILE)
    .filter((diagnostic) => diagnostic.code !== 2307);
}

// ts-plugin-tsserver-test-timeouts: each test builds the plugin's language
// service (1.2-2.0 s per test in a full gate). 60 s is index.test.ts's
// TSSERVER_DESCRIBE_TIMEOUT: room for gate load, and a real hang still fails.
describe("a type error in a server or client statement", {
  timeout: 60_000,
}, () => {
  const cases: Array<[string, string, string]> = [
    ["server one line", 'server const a: number = "x";\n<div/>\n', "a: number"],
    [
      "server block",
      'server {\n  const a: number = "x";\n}\n<div/>\n',
      "a: number",
    ],
    [
      "server on line 3",
      "<div/>\n<span/>\nserver const b: string = 1;\n",
      "b: string",
    ],
    ["server undeclared", "server const c = nope + 1;\n<div/>\n", "nope"],
    ["client one line", 'client const a: number = "x";\n<div/>\n', "a: number"],
    [
      "client block",
      'client {\n  const a: number = "x";\n}\n<div/>\n',
      "a: number",
    ],
    ["client undeclared", "client const c = nope + 1;\n<div/>\n", "nope"],
  ];

  it.each(cases)("%s: reported at the token", (_name, source, needle) => {
    const found = errors(source);
    expect(found).toHaveLength(1);
    const [diagnostic] = found;
    expect(diagnostic?.start).toBe(source.indexOf(needle));
    expect(diagnostic?.length).toBeGreaterThan(0);
  });
});
