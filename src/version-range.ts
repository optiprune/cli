import semver from "semver";

/** Select the highest published version that satisfies a package.json semver range. */
export function selectHighestCompatibleVersion(versions: string[], versionRange: string): string | null {
  const normalizedRange = versionRange.trim();
  if (
    !normalizedRange ||
    normalizedRange.startsWith("-") ||
    !/^[v0-9A-Za-z.+*xX^~<>=| -]+$/.test(normalizedRange) ||
    !semver.validRange(normalizedRange)
  ) {
    throw new Error(`Invalid npm version range in package.json: ${JSON.stringify(versionRange)}`);
  }
  return semver.maxSatisfying(versions, normalizedRange);
}
