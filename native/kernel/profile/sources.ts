// Where the profile layers are read from: the bundle's core rows, the user's file under the
// config directory, and the opened folder's `.grove/profile.json`. The file access is a
// parameter so tests can run without a host, and the boot passes svelte-gpui's `files`.

import { layerProfiles, parseProfile, type ProfileLayer, type ProfileRow, type ResolvedRow } from "./rows";

export interface ProfileFiles {
  /** The file's text, or null when it does not exist. Other failures reject. */
  readIfExists(path: string): Promise<string | null>;
  /** The directory user settings live in: `$XDG_CONFIG_HOME` or `~/.config` on Linux. */
  configDirectory(): Promise<string>;
}

/** Where a user's profile lives, under the config directory. */
export function userProfilePath(configDirectory: string): string {
  return `${configDirectory}/grove/profile.json`;
}

/** Where a folder's own profile lives. */
export function projectProfilePath(folder: string): string {
  return `${folder}/.grove/profile.json`;
}

/**
 * Reads the layers and stacks them. The project layer is the `folder`'s profile, skipped when
 * no folder is open (null), and
 * a layer whose file is missing is skipped silently. A file that cannot be read or parsed
 * becomes a problem and an empty layer, so a bad file never costs the plugins below it.
 */
export async function loadProfile(
  coreRows: ProfileRow[],
  files: ProfileFiles,
  folder: string | null
): Promise<{ rows: ResolvedRow[]; problems: string[] }> {
  const problems: string[] = [];
  const layers: ProfileLayer[] = [{ name: "core", rows: coreRows }];
  const configDirectory = await files.configDirectory();
  const user = await readLayer("user", userProfilePath(configDirectory), files, problems);
  if (user) {
    layers.push(user);
  }
  if (folder !== null) {
    const project = await readLayer("project", projectProfilePath(folder), files, problems);
    if (project) {
      layers.push(project);
    }
  }
  const layered = layerProfiles(layers);
  return { rows: layered.rows, problems: [...problems, ...layered.problems] };
}

/** One layer from a file, or null when the file is absent or unreadable. */
async function readLayer(
  name: string,
  path: string,
  files: ProfileFiles,
  problems: string[]
): Promise<ProfileLayer | null> {
  let text: string | null;
  try {
    text = await files.readIfExists(path);
  } catch (error) {
    problems.push(`${path}: could not be read (${describeError(error)})`);
    return null;
  }
  if (text === null) {
    return null;
  }
  const parsed = parseProfile(text, path);
  problems.push(...parsed.problems);
  return { name, rows: parsed.rows };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
