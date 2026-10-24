// What installed extensions give the host beyond their plugins: grammars, language servers and
// tools. The host owns all three (it parses with the grammars, runs the servers and installs the
// tools), so the extensions service tells it whenever the set changes. Pure, so what an extension contributes is testable without a host.

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

/** A grammar the host can highlight with, as `grammars_register` takes it; every path is absolute. */
export interface RegisteredGrammar {
  language: string;
  symbol?: string;
  wasm: string;
  highlights?: string;
  injections?: string;
  locals?: string;
  extensions: string[];
  fileNames: string[];
}

/** A grammar the host could not use, and why. */
export interface RejectedGrammar {
  language: string;
  reason: string;
}

export interface Contributions {
  tools: RegisteredTool[];
  servers: RegisteredServer[];
  grammars: RegisteredGrammar[];
}

/** What the extensions service needs from the host to hand these over. */
export interface ToolsHost {
  /** Replaces the grammars, tools and servers that extensions contribute with these, and answers with the grammars the host refused. */
  registerContributions(contributions: Contributions): Promise<RejectedGrammar[] | void>;
}

/** A path inside an extension's directory, made absolute for the host. */
function inside(directory: string, path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  return `${directory}/${path}`;
}

/** The tools and servers of the extensions that are enabled. */
export function contributionsOf(extensions: InstalledExtension[]): Contributions {
  const contributions: Contributions = { tools: [], servers: [], grammars: [] };
  for (const extension of extensions) {
    if (!extension.enabled || extension.manifest === null) {
      continue;
    }
    for (const grammar of extension.manifest.grammars) {
      contributions.grammars.push({
        language: grammar.language,
        symbol: grammar.symbol,
        wasm: `${extension.directory}/${grammar.wasm}`,
        highlights: inside(extension.directory, grammar.highlights),
        injections: inside(extension.directory, grammar.injections),
        locals: inside(extension.directory, grammar.locals),
        extensions: grammar.extensions,
        fileNames: grammar.fileNames,
      });
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
