/**
 * Reading `git --version`, and deciding whether that git can run this app.
 *
 * This exists because of a failure mode that cost two user-visible bugs. Git
 * does not fail politely on a flag it is too old for: `rev-parse` *echoes* an
 * unknown flag to stdout and exits 0, which surfaced as a line-count parse
 * error on open; `--diff-merges=first-parent` failed with a message naming a
 * flag the user never typed, on every commit in the repository. Neither said
 * "your git is too old", so neither was actionable.
 *
 * Checking the version once, at open, turns that whole class into one sentence
 * the user can act on.
 */

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  /** The line git printed, kept verbatim for the message and for logs. */
  raw: string;
}

/**
 * Oldest git this app's commands actually work on.
 *
 * Set by the newest thing the git layer uses, not by taste: `git restore`
 * (`buildUnstageCommand`) and `git switch` (`commands/branch.ts`) both arrived
 * in **2.23** (August 2019). Every other flag in use predates it — the audit
 * that followed the `--diff-merges` bug found nothing newer once the two 2.31
 * flags were removed.
 *
 * Deliberately not rounded up to something newer and tidier. A minimum higher
 * than the code needs turns a working install into a refusal.
 */
export const MINIMUM_GIT = { major: 2, minor: 23, patch: 0 } as const;

/** `2.23.0`, for messages. */
export function formatVersion(version: {
  major: number;
  minor: number;
  patch: number;
}): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

/**
 * Reads the version out of `git --version`.
 *
 * Returns `null` when the line is not recognisable rather than throwing. Git
 * distributions decorate this string freely — `2.29.2.windows.1`,
 * `2.39.5 (Apple Git-154)`, `2.30.2 (Debian 1:2.30.2-1)`, release candidates —
 * and a wrapper script could print something else entirely. Refusing to open a
 * repository because a *version string* was unfamiliar would break working
 * setups to prevent a worse error message, which is a bad trade.
 */
export function parseGitVersion(stdout: string): GitVersion | null {
  const raw = stdout.trim();
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (match === null) return null;

  const [, major, minor, patch] = match;
  // The capture groups are all digits, so these cannot be NaN.
  return {
    major: Number(major),
    minor: Number(minor),
    // Git omits the patch on some builds (`git version 2.30`); absent is zero.
    patch: patch === undefined ? 0 : Number(patch),
    raw,
  };
}

/** True when `version` is at least `minimum`, compared field by field. */
export function isAtLeast(
  version: { major: number; minor: number; patch: number },
  minimum: { major: number; minor: number; patch: number },
): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

/**
 * What to tell someone whose git is too old, or `null` when it is fine.
 *
 * Names the version they have, the version they need, and what to do — the
 * three things the flag-level errors could never say.
 */
export function unsupportedGitMessage(version: GitVersion | null): string | null {
  if (version === null) return null;
  if (isAtLeast(version, MINIMUM_GIT)) return null;
  return (
    `This git is ${formatVersion(version)}; Krakenless needs at least ` +
    `${formatVersion(MINIMUM_GIT)}. Older versions are missing commands the app ` +
    `relies on (\`git restore\` and \`git switch\`, both added in 2.23), so it ` +
    `would fail later with errors naming flags you never typed. Update git and ` +
    `reopen the repository. Reported by git as: ${version.raw}`
  );
}
