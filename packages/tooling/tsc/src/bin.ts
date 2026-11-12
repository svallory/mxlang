#!/usr/bin/env node
import { guardBrokenPipe } from "./broken-pipe.ts";
import { runMxTsc } from "./index.ts";

// `mx-tsc ... | head -1`: a reader that closes early is not a crash.
guardBrokenPipe(process.stdout);
runMxTsc();
