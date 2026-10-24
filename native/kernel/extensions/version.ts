// Version numbers, enough of semver to tell whether a registry has something newer than what is
// installed. Ranges are not needed: an extension is installed at one exact version.

interface ParsedVersion {
  numbers: [number, number, number];
  /** The part after a dash, which makes a version older than the same version without one. */
  prerelease: string | null;
}

/** Reads `1.2.3`, `v1.2.3` or `1.2.3-beta.1`; null for anything else. */
export function parseVersion(text: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (match === null) {
    return null;
  }
  let prerelease: string | null = null;
  if (match[4] !== undefined) {
    prerelease = match[4];
  }
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease };
}

/** Negative when `first` is older than `second`, positive when newer, and zero when they are the same. */
export function compareVersions(first: string, second: string): number {
  const left = parseVersion(first);
  const right = parseVersion(second);
  if (left === null || right === null) {
    return 0;
  }
  for (let index = 0; index < 3; index++) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return comparePrereleases(left.prerelease, right.prerelease);
}

/** Whether `candidate` is a later version than `installed`; versions that cannot be read are never newer. */
export function isNewer(candidate: string, installed: string): boolean {
  return compareVersions(candidate, installed) > 0;
}

/** A release is newer than any prerelease of it; prereleases compare part by part. */
function comparePrereleases(first: string | null, second: string | null): number {
  if (first === second) {
    return 0;
  }
  if (first === null) {
    return 1;
  }
  if (second === null) {
    return -1;
  }
  const left = first.split(".");
  const right = second.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = comparePart(left[index], right[index]);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** One dot separated part: numbers compare as numbers and sort before words, and a missing part is the smallest. */
function comparePart(first: string | undefined, second: string | undefined): number {
  if (first === undefined) {
    return -1;
  }
  if (second === undefined) {
    return 1;
  }
  const firstIsNumber = /^\d+$/.test(first);
  const secondIsNumber = /^\d+$/.test(second);
  if (firstIsNumber && secondIsNumber) {
    return Number(first) - Number(second);
  }
  if (firstIsNumber) {
    return -1;
  }
  if (secondIsNumber) {
    return 1;
  }
  return first.localeCompare(second);
}
