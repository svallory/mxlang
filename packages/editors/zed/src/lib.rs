use zed_extension_api::{self as zed, LanguageServerId, Result};

// @mxlang/language-server speaks LSP over stdio (`createConnection`
// auto-detects the `--stdio` transport). Unlike marko-js/zed's `MarkoExtension`
// (which downloads @marko/language-server from npm into the extension's own
// working directory), this extension does no installation of its own — see
// the brief: "keep it minimal: no settings, no downloads".
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

// @mxlang/typescript-plugin, registered with whichever TypeScript server Zed
// runs (vtsls, its default, or typescript-language-server), so a `.ts` file
// importing `.mx` type-checks and MX files get TypeScript features. The shape
// is marko-js/zed's for @marko/ts-plugin (see UPSTREAM.md). Unlike that
// extension, this one cannot `npm_install_package` the plugin (it is not on
// any registry), so it is used only when the project installs it: the
// worktree's own `node_modules/@mxlang/typescript-plugin`, detected with the
// same sandbox-safe `read_text_file` as the language server above. The
// worktree root is the plugin's probe location (tsserver loads
// `<location>/node_modules/<name>`). Without a local install the hooks return
// `None` and the TypeScript server is configured as before.
const TS_PLUGIN_NAME: &str = "@mxlang/typescript-plugin";
const TS_PLUGIN_MARKER: &str = "node_modules/@mxlang/typescript-plugin/package.json";
// LSP language ids of the languages the plugin serves: Zed sends a language's
// `config.toml` `name` lowercased (`LanguageName::lsp_id`). AstroMX is left
// out, as in `[language_servers.mxlang]`.
const TS_PLUGIN_LANGUAGES: [&str; 6] =
    ["mx", "solid", "reactmx", "preactmx", "honomx", "angularmx"];

/// vtsls takes tsserver plugins through workspace configuration.
fn ts_plugin_workspace_configuration(
    target: &str,
    location: Option<&str>,
) -> Option<serde_json::Value> {
    let location = location?;
    (target == "vtsls").then(|| {
        serde_json::json!({
            "vtsls": {
                "tsserver": {
                    "globalPlugins": [{
                        "name": TS_PLUGIN_NAME,
                        "location": location,
                        "languages": TS_PLUGIN_LANGUAGES,
                        "enableForWorkspaceTypeScriptVersions": true,
                    }],
                },
            },
        })
    })
}

/// typescript-language-server takes tsserver plugins through initialization
/// options.
fn ts_plugin_initialization_options(
    target: &str,
    location: Option<&str>,
) -> Option<serde_json::Value> {
    let location = location?;
    (target == "typescript-language-server").then(|| {
        serde_json::json!({
            "plugins": [{
                "name": TS_PLUGIN_NAME,
                "location": location,
                "languages": TS_PLUGIN_LANGUAGES,
            }],
        })
    })
}

/// The plugin's probe location: the worktree root, when the project installs
/// the plugin.
fn ts_plugin_location(worktree: &zed::Worktree) -> Option<String> {
    worktree
        .read_text_file(TS_PLUGIN_MARKER)
        .ok()
        .map(|_| worktree.root_path())
}

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

    fn language_server_additional_initialization_options(
        &mut self,
        _language_server_id: &LanguageServerId,
        target_language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(ts_plugin_initialization_options(
            target_language_server_id.as_ref(),
            ts_plugin_location(worktree).as_deref(),
        ))
    }

    fn language_server_additional_workspace_configuration(
        &mut self,
        _language_server_id: &LanguageServerId,
        target_language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(ts_plugin_workspace_configuration(
            target_language_server_id.as_ref(),
            ts_plugin_location(worktree).as_deref(),
        ))
    }
}

zed::register_extension!(MxlangExtension);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ROOT: &str = "/home/dev/app";

    #[test]
    fn vtsls_gets_the_plugin_as_a_global_plugin() {
        assert_eq!(
            ts_plugin_workspace_configuration("vtsls", Some(ROOT)),
            Some(json!({
                "vtsls": {
                    "tsserver": {
                        "globalPlugins": [{
                            "name": "@mxlang/typescript-plugin",
                            "location": "/home/dev/app",
                            "languages": ["mx", "solid", "reactmx", "preactmx", "honomx", "angularmx"],
                            "enableForWorkspaceTypeScriptVersions": true,
                        }],
                    },
                },
            }))
        );
    }

    #[test]
    fn typescript_language_server_gets_the_plugin_in_its_initialization_options() {
        assert_eq!(
            ts_plugin_initialization_options("typescript-language-server", Some(ROOT)),
            Some(json!({
                "plugins": [{
                    "name": "@mxlang/typescript-plugin",
                    "location": "/home/dev/app",
                    "languages": ["mx", "solid", "reactmx", "preactmx", "honomx", "angularmx"],
                }],
            }))
        );
    }

    #[test]
    fn each_hook_configures_only_its_own_server() {
        for target in [
            "typescript-language-server",
            "mxlang",
            "eslint",
            "tailwindcss-language-server",
        ] {
            assert_eq!(
                ts_plugin_workspace_configuration(target, Some(ROOT)),
                None,
                "{target}"
            );
        }
        for target in ["vtsls", "mxlang", "eslint", "tailwindcss-language-server"] {
            assert_eq!(
                ts_plugin_initialization_options(target, Some(ROOT)),
                None,
                "{target}"
            );
        }
    }

    #[test]
    fn nothing_is_configured_without_a_local_plugin_install() {
        assert_eq!(ts_plugin_workspace_configuration("vtsls", None), None);
        assert_eq!(
            ts_plugin_initialization_options("typescript-language-server", None),
            None
        );
    }
}
