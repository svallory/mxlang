#!/usr/bin/env node
import { runCli } from "./cli.ts";

const result = runCli(process.argv.slice(2));
if (typeof result === "number") {
  process.exitCode = result;
} else {
  result
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
