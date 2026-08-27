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
  /**
   * Opt-in: fetch author pictures from Gravatar and GitHub.
   *
   * Off by default, and the only setting in this file that can cause a network
   * request to anything other than a git remote (ADR-0021). When it is on,
   * every author whose picture is not already cached costs one request:
   * `avatars.githubusercontent.com` by account id for GitHub noreply
   * addresses, and `www.gravatar.com` — which receives a hash of the address
   * and this machine's IP — for everyone else. Named `remoteAvatars` rather
   * than for one of those hosts, because the honest name is the one that says
   * a request leaves the machine.
   */
  remoteAvatars: boolean;
  /**
   * Minutes between background fetches; `0` turns them off.
   *
   * A fetch is the only way to learn that other people have pushed — git
   * cannot know about a branch it has never been told about — so without this
   * the branch list is only ever as fresh as the last manual fetch. It talks
   * to the git remotes and nothing else (ADR-0025), which is the one network
   * destination this app has always had.
   */
  autoFetchMinutes: number;
  layout: LayoutConfig;
}

/**
 * What Settings offers, in minutes. Hand-edited values outside this list are
 * kept as long as they are sane (see {@link AUTO_FETCH_BOUNDS}) — the list is
 * the menu, not the schema.
 */
export const AUTO_FETCH_CHOICES = [0, 1, 5, 15, 30] as const;

/**
 * Floor and ceiling for a hand-edited interval. The floor is a minute because
 * anything under it turns a background convenience into a request loop against
 * someone's server; the ceiling is a day, past which the setting is off in all
 * but name. `0` is exempt: it means off, and is the one value below the floor.
 */
export const AUTO_FETCH_BOUNDS = { min: 1, max: 1440 } as const;

/** Sizes of the resizable panels, in the units the shell lays them out with. */
export interface LayoutConfig {
  /** Width of the refs sidebar, in pixels. */
  sidebarWidth: number;
  /** Width of the working-tree panel, in pixels. */
  detailWidth: number;
  /** Share of the centre column's height given to the graph, 0 to 1. */
  historyRatio: number;
}

/**
 * What each panel may be dragged to.
 *
 * The floors are the point below which a panel stops being readable rather
 * than merely small, and the ceilings keep any one panel from swallowing the
 * window — a layout the user cannot undo without editing the config file by
 * hand is a trap, not a preference.
 */
export const LAYOUT_BOUNDS = {
  sidebarWidth: { min: 180, max: 560 },
  detailWidth: { min: 240, max: 680 },
  historyRatio: { min: 0.15, max: 0.9 },
} as const;

export const MAX_RECENT_REPOS = 20;

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    recentRepos: [],
    editorCommand: '',
    mergetool: '',
    theme: 'dark',
    remoteAvatars: false,
    autoFetchMinutes: 5,
    layout: { sidebarWidth: 264, detailWidth: 340, historyRatio: 0.62 },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** A finite number inside its bounds, or the default. Rejects NaN and ±∞. */
function asBounded(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, bounds.min), bounds.max);
}

/**
 * Forces a layout back inside its bounds. Exported because the shell clamps
 * with it while dragging, so the size on screen and the size on disk can never
 * disagree about what is allowed.
 */
export function clampLayout(layout: LayoutConfig): LayoutConfig {
  const defaults = defaultConfig().layout;
  return {
    sidebarWidth: asBounded(
      layout.sidebarWidth,
      defaults.sidebarWidth,
      LAYOUT_BOUNDS.sidebarWidth,
    ),
    detailWidth: asBounded(
      layout.detailWidth,
      defaults.detailWidth,
      LAYOUT_BOUNDS.detailWidth,
    ),
    historyRatio: asBounded(
      layout.historyRatio,
      defaults.historyRatio,
      LAYOUT_BOUNDS.historyRatio,
    ),
  };
}

/**
 * Reads the fetch interval, rejecting anything that would make the app hammer
 * a remote. Whole minutes only: a fractional interval is a hand edit that
 * nothing in the UI can produce and that nobody wants the consequences of.
 */
export function asAutoFetchMinutes(value: unknown): number {
  const fallback = 5;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  return Math.min(
    Math.max(Math.round(value), AUTO_FETCH_BOUNDS.min),
    AUTO_FETCH_BOUNDS.max,
  );
}

function asLayout(value: unknown): LayoutConfig {
  const defaults = defaultConfig().layout;
  if (!isObject(value)) return defaults;
  return clampLayout({
    sidebarWidth: asBounded(
      value['sidebarWidth'],
      defaults.sidebarWidth,
      LAYOUT_BOUNDS.sidebarWidth,
    ),
    detailWidth: asBounded(
      value['detailWidth'],
      defaults.detailWidth,
      LAYOUT_BOUNDS.detailWidth,
    ),
    historyRatio: asBounded(
      value['historyRatio'],
      defaults.historyRatio,
      LAYOUT_BOUNDS.historyRatio,
    ),
  });
}

/**
 * Reads the author-pictures switch, honouring the name it used to have.
 *
 * Strictly `true`: anything else on disk — a string "true", a 1, a typo —
 * leaves the network alone, because the safe reading of a malformed privacy
 * setting is the private one.
 *
 * `githubAvatars` (ADR-0019) was renamed to `remoteAvatars` when the feature
 * grew, and the old key is deliberately **not** inherited.
 *
 * A rename normally carries a setting across, and dropping one is rude. This
 * one is not a rename: the old switch was described to the user as fetching a
 * picture by account number, with "no email address is ever sent anywhere".
 * The new one hashes every author's address and sends it to a third party.
 * Inheriting the answer would answer a question the user was never asked. The
 * cost of not inheriting is one checkbox, ticked once, next to copy that says
 * what actually happens now.
 */
function readRemoteAvatars(raw: Record<string, unknown>): boolean {
  return raw['remoteAvatars'] === true;
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
    remoteAvatars: readRemoteAvatars(raw),
    autoFetchMinutes: asAutoFetchMinutes(raw['autoFetchMinutes']),
    layout: asLayout(raw['layout']),
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
