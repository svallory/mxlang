/**
 * The long no-throw run (brief §1.2 E): at least 500,000 inputs per
 * generator, from a seed given on the command line, reporting counts,
 * duration and every failure.
 *
 *   cd packages/parser
 *   bun run src/frontend/test-support/long-fuzz.ts <seed> <count>
 */
import { characters, expressionHeavy, run, tokens } from "./fuzz.ts";

const seed = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 500_000);
for (const [name, generate] of [
  ["characters", (s: number) => characters(s, 40)],
  ["tokens", tokens],
  ["expression-heavy", expressionHeavy],
] as const) {
  const started = performance.now();
  const result = run(generate, seed, count);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `${name}: seed ${seed}, ${result.inputs} inputs, ${seconds}s, ${result.failures.length} failures, ${result.templateThrows.length} template-parser throws`,
  );
  const distinct = new Map(result.templateThrows.map((t) => [t.problem, t]));
  for (const failure of [...result.failures, ...distinct.values()]) {
    console.log(
      `  seed ${failure.seed} ${JSON.stringify(failure.input)}: ${failure.problem}`,
    );
  }
}
