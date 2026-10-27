// What the sessions view says about the shown session at its foot: the directory it works in, its
// agent's context (share and exact tokens), the tokens in and out and the cost so far, and the
// language servers and MCP servers (the daemon's `service` connectors) with whether each is up.
// Plain functions, so they are tested without a window. Ported from neo term (apps/term details.rs).

import type { ConnectorInfo, Usage } from "@suite/protocol/types";
import { contextPercent, formatCost } from "./composerStatus";

/** How much of the context is used, and what colour that deserves. */
export interface ContextDetail {
  percent: number;
  used: number;
  size: number;
  tone: "muted" | "accent" | "danger";
}

/** One service connector and whether it is up. */
export interface ServerDetail {
  name: string;
  up: boolean;
  /** Why it is down, when the daemon says. */
  error?: string;
}

/** The block's contents; a part the daemon has no numbers for is left out. */
export interface Details {
  directory: string;
  context?: ContextDetail;
  tokens?: string;
  cost?: string;
  servers: ServerDetail[];
}

/** `1234567` as `1,234,567`. */
export function grouped(value: number): string {
  const digits = String(Math.abs(Math.trunc(value)));
  let out = "";
  for (let index = 0; index < digits.length; index++) {
    if (index > 0 && (digits.length - index) % 3 === 0) {
      out += ",";
    }
    out += digits[index];
  }
  if (value < 0) {
    return `-${out}`;
  }
  return out;
}

/** A directory with the home directory written `~`. */
export function shortened(directory: string, home: string | undefined): string {
  if (home === undefined || home === "") {
    return directory;
  }
  if (directory === home) {
    return "~";
  }
  if (directory.startsWith(`${home}/`)) {
    return `~${directory.slice(home.length)}`;
  }
  return directory;
}

/** The most characters of a directory the sidebar has room for. */
const DIRECTORY_COLUMNS = 27;

/** A path cut at the start to fit, since the end of a path says more: `…/neoworks/grove/demo`. */
export function truncatedStart(path: string, columns: number = DIRECTORY_COLUMNS): string {
  if (path.length <= columns) {
    return path;
  }
  return `…${path.slice(path.length - (columns - 1))}`;
}

/** How full the context is: past 60% it is worth a look, past 85% it is nearly out. */
function toneOf(percent: number): ContextDetail["tone"] {
  if (percent >= 85) {
    return "danger";
  }
  if (percent >= 60) {
    return "accent";
  }
  return "muted";
}

/** The details of a session working in `directory`, from its agent's usage and the daemon's connectors. */
export function detailsOf(
  directory: string,
  home: string | undefined,
  usage: Usage | undefined,
  connectors: readonly ConnectorInfo[],
): Details {
  const details: Details = { directory: truncatedStart(shortened(directory, home)), servers: serversOf(connectors) };
  if (usage === undefined) {
    return details;
  }
  const percent = contextPercent(usage);
  if (percent !== undefined && usage.contextUsed !== undefined && usage.contextSize !== undefined) {
    details.context = { percent, used: usage.contextUsed, size: usage.contextSize, tone: toneOf(percent) };
  }
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    let input = 0;
    if (usage.inputTokens !== undefined) {
      input = usage.inputTokens;
    }
    let output = 0;
    if (usage.outputTokens !== undefined) {
      output = usage.outputTokens;
    }
    details.tokens = `in ${grouped(input)} · out ${grouped(output)}`;
  }
  const cost = formatCost(usage.cost);
  if (cost !== undefined) {
    details.cost = cost;
  }
  return details;
}

/** The service connectors by name, each up when it is connected and has no error. */
export function serversOf(connectors: readonly ConnectorInfo[]): ServerDetail[] {
  return connectors
    .filter((connector) => connector.kind === "service")
    .map((connector) => {
      const server: ServerDetail = { name: connector.app, up: connector.connected && connector.error === undefined };
      if (connector.error !== undefined) {
        server.error = connector.error;
      }
      return server;
    })
    .sort((first, second) => first.name.localeCompare(second.name));
}
