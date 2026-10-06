/**
 * The child process behind `stockMarkoCompile` / `stockMarkoTree`
 * (../marko.ts). It is the one place `@marko/compiler` meets the stock
 * parser: a CommonJS resolution hook maps the bare specifier
 * `htmljs-parser` to the vendored stock build for THIS process only,
 * before the compiler (and Marko's real translator) are loaded. Nothing
 * in the parent process, the install, or any other package's resolution
 * changes — the parent spawns this script, hands it a JSON request on
 * stdin, and reads a JSON answer from stdout.
 *
 * Env (set by the parent):
 *   MX_STOCK_PARSER_CJS  absolute path of the extracted stock dist/index.js
 *   MX_MARKO_COMPILER    absolute path of @marko/compiler's entry
 *   MX_MARKO_TRANSLATOR  absolute path/URL of marko/translator
 */
const Module = require("node:module");

const stockParserPath = process.env.MX_STOCK_PARSER_CJS;
if (!stockParserPath) throw new Error("MX_STOCK_PARSER_CJS is not set");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "htmljs-parser") return stockParserPath;
  return originalResolveFilename.call(this, request, ...rest);
};

const compiler = require(process.env.MX_MARKO_COMPILER);

function serializeError(error) {
  return {
    message: String((error && error.message) || error),
    label: error && error.label ? String(error.label) : undefined,
    loc: error && error.loc && error.loc.start ? error.loc.start : undefined,
  };
}

// Fields dropped from the captured tree: `loc` duplicates start/end, the
// rest are Babel bookkeeping that drowns the signal.
const TREE_DROP_KEYS = new Set([
  "loc",
  "tokens",
  "comments",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "extra",
]);

function treeReplacer(key, value) {
  return TREE_DROP_KEYS.has(key) ? undefined : value;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  void (async () => {
    const request = JSON.parse(input);
    const filename = request.filename || "/probe.marko";
    try {
      if (request.mode === "tree") {
        let tree;
        compiler.compileSync(request.source, filename, {
          translator: {
            taglibs: [],
            tagDiscoveryDirs: [],
            translate: {
              Program: {
                enter(path) {
                  if (!tree) tree = JSON.parse(JSON.stringify(path.node, treeReplacer));
                },
                exit(path) {
                  path.node.body = [];
                },
              },
            },
          },
          output: "html",
          writeVersionComment: false,
        });
        process.stdout.write(JSON.stringify({ ok: true, tree }));
      } else {
        const translator = await import(process.env.MX_MARKO_TRANSLATOR);
        const result = compiler.compileSync(request.source, filename, {
          translator,
          output: "html",
          writeVersionComment: false,
          optimize: true,
        });
        process.stdout.write(JSON.stringify({ ok: true, code: result.code }));
      }
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: serializeError(error) }));
    }
  })();
});
