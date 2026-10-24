// What installed extensions give the host beyond their plugins: language servers and tools. The
// host owns both (it runs the servers and installs the tools), so the extensions service tells it
// whenever the set changes. Pure, so what an extension contributes is testable without a host.

import type { InstalledExtension } from "./store";
import type { InstallRecipe } from "./recipes";

/** A tool the host can install, as the host's `tools_register` takes it. */
export interface RegisteredTool {
  /** `<package>:<id>`, so tools of different extensions never collide. */
  id: string;
  name: string;
  description: string;
  install: InstallRecipe;
  /** The package that brought it. */
  source: string;
}

/** A language server the host can run for files no built-in server serves, as `lsp_register_servers` takes it. */
export interface RegisteredServer {
  name: string;
  command: string;
  args: string[];
  languageId: string;
  extensions: string[];
  fileNames: string[];
  rootMarkers: string[];
}

export interface Contributions {
  tools: RegisteredTool[];
  servers: RegisteredServer[];
}

/** What the extensions service needs from the host to hand these over. */
export interface ToolsHost {
  /** Replaces the tools and servers that extensions contribute with these. */
  registerContributions(contributions: Contributions): Promise<void>;
}

/** The tools and servers of the extensions that are enabled. */
export function contributionsOf(extensions: InstalledExtension[]): Contributions {
  const contributions: Contributions = { tools: [], servers: [] };
  for (const extension of extensions) {
    if (!extension.enabled || extension.manifest === null) {
      continue;
    }
    for (const tool of extension.manifest.tools) {
      contributions.tools.push({
        id: `${extension.name}:${tool.id}`,
        name: tool.name,
        description: "",
        install: tool.install,
        source: extension.name,
      });
    }
    for (const server of extension.manifest.languageServers) {
      contributions.servers.push({
        name: server.name,
        command: server.command,
        args: server.args,
        languageId: server.languageId,
        extensions: server.extensions,
        fileNames: server.fileNames,
        rootMarkers: server.rootMarkers,
      });
      if (server.install !== undefined) {
        contributions.tools.push({
          id: `${extension.name}:${server.id}`,
          name: server.name,
          description: `The ${server.name} language server, from ${extension.name}.`,
          install: server.install,
          source: extension.name,
        });
      }
    }
  }
  return contributions;
}
