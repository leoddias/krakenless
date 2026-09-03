import { invoke } from '@tauri-apps/api/core';

/**
 * Deciding which program to run, from the user's settings.
 *
 * Rust spawns; the parsing lives here. `editorCommand` is a string the user
 * typed (`code -g`, `"C:/Program Files/x/x.exe" --wait`), so it has to be split
 * into a program and arguments — carefully, because splitting on whitespace
 * alone would break every path with a space in it.
 */

/** Splits a command line into tokens, honouring double quotes. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let seen = false;

  for (const char of command) {
    if (char === '"') {
      quoted = !quoted;
      seen = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0 || seen) tokens.push(current);
      current = '';
      seen = false;
      continue;
    }
    current += char;
  }
  if (current.length > 0 || seen) tokens.push(current);
  return tokens;
}

export interface Launchable {
  program: string;
  args: string[];
}

/**
 * Builds the launch for "open this file in my editor".
 *
 * Returns `null` when no editor is configured — the caller shows "set an editor
 * in Settings" rather than guessing at one and launching something unexpected.
 */
export function editorLaunch(editorCommand: string, path: string): Launchable | null {
  const tokens = tokenize(editorCommand);
  const program = tokens[0];
  if (program === undefined || program.length === 0) return null;

  // The path goes last as its own argument, never interpolated. A repository
  // file may legally be named `-w` or `--goto`, which the editor would read as
  // an option, so a leading dash is neutralised with an explicit `./` prefix —
  // the one form every editor treats as a path.
  const safePath = path.startsWith('-') ? `./${path}` : path;
  return { program, args: [...tokens.slice(1), safePath] };
}

/**
 * Builds `git mergetool` for one conflicted path.
 *
 * The tool itself is git's business: `--tool=` is only passed when the user
 * named one, otherwise git uses whatever their config already says. `-y` skips
 * git's own prompt, which the app has already asked in the UI.
 */
export function mergetoolLaunch(tool: string, path: string): Launchable {
  // The Rust side recognises `git` and prepends the same global arguments and
  // environment scrub the runner uses, so this only builds the subcommand.
  const args = ['mergetool', '--no-prompt'];
  if (tool.trim().length > 0) args.push(`--tool=${tool.trim()}`);
  args.push('--', path);
  return { program: 'git', args };
}

/**
 * Spawns a launch. Throws an `Error` with a readable message when the program
 * cannot be started — the raw IPC rejection is a bare object, and a UI that
 * showed it would print "[object Object]" at the user.
 */
export async function launch(target: Launchable, cwd?: string): Promise<void> {
  try {
    await invoke('open_external', {
      program: target.program,
      args: target.args,
      cwd: cwd ?? null,
    });
  } catch (error) {
    throw new Error(describeLaunchFailure(target.program, error));
  }
}

function describeLaunchFailure(program: string, error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return `Could not start ${program}`;
}

/** Opens the settings folder in the platform's file manager. */
export async function revealFolder(path: string): Promise<void> {
  try {
    await invoke('reveal_folder', { path });
  } catch (error) {
    throw new Error(describeLaunchFailure('the file manager', error));
  }
}

/**
 * Shows one file in the platform's file manager, selected.
 *
 * Takes an absolute path: the file manager knows nothing about the repository
 * root a git path is relative to.
 */
export async function revealPath(path: string): Promise<void> {
  try {
    await invoke('reveal_path', { path });
  } catch (error) {
    throw new Error(describeLaunchFailure('the file manager', error));
  }
}
