import { invoke } from '@tauri-apps/api/core';
import { type AppConfig, parseConfig, serializeConfig } from './schema';

/** Reads settings from disk, falling back to defaults for anything unreadable. */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const text = await invoke<string | null>('config_read');
    return parseConfig(text);
  } catch {
    // Losing preferences is acceptable; refusing to start is not.
    return parseConfig(null);
  }
}

/** Writes settings. Throws so a caller can tell the user the save failed. */
export async function saveConfig(config: AppConfig): Promise<void> {
  await invoke('config_write', { contents: serializeConfig(config) });
}

/** Absolute path of the settings folder, for the "open config folder" action. */
export async function configFolder(): Promise<string> {
  return invoke<string>('config_dir_path');
}
