use zed_extension_api::{self as zed, LanguageServerId, Result};

// @mxlang/language-server speaks LSP over stdio (`createConnection`
// auto-detects the `--stdio` transport). Unlike marko-js/zed's `MarkoExtension`
// (which downloads @marko/language-server from npm into the extension's own
// working directory), this extension does no installation of its own — see
// decision 77 / the brief: "keep it minimal: no settings, no downloads".
//
// Resolution order, cheapest and most explicit first:
//   1. A local install under the worktree, detected via `Worktree::read_text_file`
//      (zed_extension_api's `extension.wit`: "Returns the textual contents of
//      the specified file in the worktree" — this is a WASI-sandbox-safe way
//      to check worktree paths; `std::fs`/`std::path::Path` calls on worktree
//      paths always report "not found" because Zed's wasm sandbox preopens
//      only the extension's own working directory, never the worktree root).
//      If `node_modules/@mxlang/language-server/package.json` reads
//      successfully, the package is installed there, and the bin is spawned
//      at `<worktree root>/node_modules/.bin/<BIN_NAME>` — an absolute host
//      path, which Zed spawns on the host (not inside the sandbox), so this
//      is fine despite being computed from a sandboxed read.
//   2. A global install, via `Worktree::which` (extension.wit: "Returns the
//      path to the given binary name, if one is present on the `$PATH`").
//   3. `bunx @mxlang/language-server --stdio`, via `which("bunx")`.
//   4. `npx @mxlang/language-server --stdio`, via `which("npx")`.
// No walk-up past the worktree root: `Worktree`'s API has no such operation,
// and only the worktree's own paths are readable from the sandbox at all.
const BIN_NAME: &str = "mxlang-language-server";
const PACKAGE_NAME: &str = "@mxlang/language-server";
const LOCAL_MARKER: &str = "node_modules/@mxlang/language-server/package.json";
const LOCAL_BIN_REL: &str = "node_modules/.bin/mxlang-language-server";

struct MxlangExtension;

impl zed::Extension for MxlangExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        if worktree.read_text_file(LOCAL_MARKER).is_ok() {
            let bin_path = format!("{}/{LOCAL_BIN_REL}", worktree.root_path());
            return Ok(zed::Command {
                command: bin_path,
                args: vec!["--stdio".to_string()],
                env: Default::default(),
            });
        }

        if let Some(global_bin) = worktree.which(BIN_NAME) {
            return Ok(zed::Command {
                command: global_bin,
                args: vec!["--stdio".to_string()],
                env: Default::default(),
            });
        }

        if let Some(bunx) = worktree.which("bunx") {
            return Ok(zed::Command {
                command: bunx,
                args: vec![PACKAGE_NAME.to_string(), "--stdio".to_string()],
                env: Default::default(),
            });
        }

        if let Some(npx) = worktree.which("npx") {
            return Ok(zed::Command {
                command: npx,
                args: vec![PACKAGE_NAME.to_string(), "--stdio".to_string()],
                env: Default::default(),
            });
        }

        Err(format!(
            "could not find {BIN_NAME} (local install, global install, bunx, or npx)"
        ))
    }
}

zed::register_extension!(MxlangExtension);
