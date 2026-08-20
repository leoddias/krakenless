/**
 * The live stores, and the settings they all share.
 *
 * Each open repository gets its own store — that is what keeps one tab's status
 * from being another tab's — but the settings are not per repository. The panel
 * sizes, the theme and the author-picture switch are one answer for the whole
 * app, saved to one file. Without this registry, changing a setting in one tab
 * would leave every other tab running on the old one until restart, which reads
 * as the setting not working.
 */

import type { AppConfig } from '../config/schema';
import type { Store } from './store';

const live = new Set<Store>();

/** Adds a store to the set that receives settings changes. */
export function registerStore(store: Store): () => void {
  live.add(store);
  return () => {
    live.delete(store);
  };
}

/** Hands the same settings to every live store. */
export function publishConfig(config: AppConfig): void {
  for (const store of live) {
    store.dispatch({ type: 'config/loaded', config });
  }
}

/** For tests: forget every registered store. */
export function resetStoreRegistry(): void {
  live.clear();
}

/** How many stores are currently registered. Exported for tests. */
export function liveStoreCount(): number {
  return live.size;
}
