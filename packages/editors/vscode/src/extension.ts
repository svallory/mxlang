import type { ExtensionContext } from "vscode";
import { commands, window, workspace } from "vscode";
import type {
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import { type Executable, LanguageClient } from "vscode-languageclient/node";
import { getServerCommand } from "./server-command.js";

let client: LanguageClient;

export function activate(context: ExtensionContext) {
  const outputChannel = window.createOutputChannel("MX Language Server");

  const startClient = async () => {
    let serverCommand: Executable | undefined;
    try {
      const config = workspace.getConfiguration("mxlang");
      const configuredPath = config.get<string>("languageServer.path");
      const workspaceFolders = (workspace.workspaceFolders || []).map(
        (f) => f.uri.fsPath,
      );

      serverCommand = getServerCommand(configuredPath, workspaceFolders);
      const serverOptions: ServerOptions = {
        run: serverCommand,
        debug: serverCommand,
      };

      const clientOptions: LanguageClientOptions = {
        documentSelector: [
          { scheme: "file", language: "mx" },
          { scheme: "untitled", language: "mx" },
          { scheme: "file", language: "solidmx" },
          { scheme: "untitled", language: "solidmx" },
          // astromx and ngmx are intentionally excluded as the LS does not
          // handle .amx or .ng.mx yet. `.ng.mx` gets TypeScript semantics
          // through the TS server plugin (see `typescriptServerPlugins` in
          // package.json); the LS handling and Angular template diagnostics
          // land later.
        ],
        // biome-ignore lint/suspicious/noExplicitAny: reason
        outputChannel: outputChannel as any,
      };

      client = new LanguageClient(
        "mxlang",
        "MX Language Server",
        serverOptions,
        clientOptions,
      );

      await client.start();
      // biome-ignore lint/suspicious/noExplicitAny: reason
    } catch (e: any) {
      const cmdStr = serverCommand
        ? `${serverCommand.command} ${serverCommand.args?.join(" ") || ""}`
        : "resolution failed";
      const msg = `Failed to start MX language server (Command: ${cmdStr}). To override, set "mxlang.languageServer.path" in settings. Error: ${e.message}`;
      outputChannel.appendLine(msg);
      window.showErrorMessage(msg);
    }
  };

  startClient();

  const restartCommand = commands.registerCommand(
    "mxlang.restartLanguageServer",
    async () => {
      if (client) {
        await client.stop();
      }
      await startClient();
    },
  );

  context.subscriptions.push(restartCommand);
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
