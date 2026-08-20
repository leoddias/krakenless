import { useContext, useSyncExternalStore } from 'react';
import { StoreContext } from './context';
import type { AppState, Store } from './store';
import { createStore } from './store';

export { StoreProvider } from './StoreProvider';

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (store === null) {
    throw new Error('useStore must be used inside a StoreProvider');
  }
  return store;
}

/** Subscribes to a slice of state; re-renders only when that slice changes. */
export function useAppState<T>(select: (state: AppState) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getState()),
  );
}

/** Convenience for tests and for the app entry point. */
export function makeStore(): Store {
  return createStore();
}
