/**
 * The settings schema. Rust moves opaque text; every decision about shape,
 * defaults and validation lives here.
 *
 * The file is human-readable JSON in `%APPDATA%/krakenless/config.json` — users
 * are expected to open it, so parsing must survive hand edits: an unknown or
 * malformed field falls back to its default instead of failing the app.
 */

export interface RecentRepo {
  /** Absolute path to the worktree root, forward slashes. */
  path: string;
  /** ISO 8601 timestamp of the last time it was opened. */
  lastOpened: string;
}

export interface AppConfig {
  /** Schema version, so a future migration can tell shapes apart. */
  version: 1;
  recentRepos: RecentRepo[];
  /** Command used to open a file in the user's editor, e.g. `code -g`. */
  editorCommand: string;
  /** `git mergetool --tool=<x>`; empty means git's own default. */
  mergetool: string;
  theme: 'dark' | 'light' | 'system';
}

export const MAX_RECENT_REPOS = 20;

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    recentRepos: [],
    editorCommand: '',
    mergetool: '',
    theme: 'dark',
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asRecentRepos(value: unknown): RecentRepo[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const repos: RecentRepo[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const path = entry['path'];
    if (typeof path !== 'string' || path.length === 0) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    repos.push({
      path,
      lastOpened: asString(entry['lastOpened'], new Date(0).toISOString()),
    });
    if (repos.length >= MAX_RECENT_REPOS) break;
  }
  return repos;
}

/**
 * Turns whatever is on disk into a valid config. Never throws: a corrupt file
 * costs the user their preferences, not their ability to open the app.
 */
export function parseConfig(text: string | null): AppConfig {
  const defaults = defaultConfig();
  if (text === null || text.trim().length === 0) return defaults;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return defaults;
  }
  if (!isObject(raw)) return defaults;

  const theme = raw['theme'];
  return {
    version: 1,
    recentRepos: asRecentRepos(raw['recentRepos']),
    editorCommand: asString(raw['editorCommand'], defaults.editorCommand),
    mergetool: asString(raw['mergetool'], defaults.mergetool),
    theme:
      theme === 'light' || theme === 'system' || theme === 'dark'
        ? theme
        : defaults.theme,
  };
}

/** Serializes for disk. Indented because the file is meant to be readable. */
export function serializeConfig(config: AppConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Puts `path` at the front of the recent list, de-duplicated and capped.
 * Pure, so the ordering rule is testable without touching disk.
 */
export function withRecentRepo(config: AppConfig, path: string, now: Date): AppConfig {
  const entry: RecentRepo = { path, lastOpened: now.toISOString() };
  const others = config.recentRepos.filter((repo) => repo.path !== path);
  return { ...config, recentRepos: [entry, ...others].slice(0, MAX_RECENT_REPOS) };
}

export function withoutRecentRepo(config: AppConfig, path: string): AppConfig {
  return {
    ...config,
    recentRepos: config.recentRepos.filter((repo) => repo.path !== path),
  };
}
